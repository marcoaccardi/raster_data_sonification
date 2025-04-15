const max = require("max-api");
const fs = require("fs");

// -----------------------------------------------------
// CONFIG
// -----------------------------------------------------

// We'll fire updates at a fixed internal period (16 ms ~ 60 FPS).
// This is how frequently we send out intermediate interpolated dictionaries.
const TICK_MS = 16;

// -----------------------------------------------------
// GLOBALS
// -----------------------------------------------------

let headerNames = []; // Column headers from first CSV row
let csvData = []; // All CSV data rows after the header
let jsonData = {}; // Optional JSON metadata

// Reading / interpolation variables
let readInterval = 500; // The total time (ms) to go from one row to the next
let timerId = null; // setInterval reference

// Row pointers
let currentIndex = -1; // which row in csvData we are moving *to*
let previousRow = null; // last "settled" row (fully arrived)
let currentRow = null; // row we are transitioning to
let elapsedTime = 0; // how many ms have passed in the current row-to-row ramp

// -----------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------

/**
 * Load CSV from disk. The first line is assumed to be column headers.
 */
function loadCSV(path) {
  try {
    const content = fs.readFileSync(path, "utf8");
    const lines = content.trim().split("\n");
    if (lines.length < 2) {
      max.post("CSV file has no data or just headers—can't proceed.");
      return;
    }

    // First line = headers
    headerNames = lines[0].split(",");

    // Remaining lines = data
    const dataLines = lines.slice(1);
    csvData = dataLines.map((line) => line.split(","));

    max.post(`Loaded CSV with ${csvData.length} data rows (+1 header).`);
    max.post(`Column headers: ${JSON.stringify(headerNames)}`);

    // Reset reading state
    resetState();
  } catch (err) {
    max.post(`Error reading CSV file: ${err}`);
  }
}

/**
 * Optional: load JSON data (e.g. config or min/max).
 */
function loadJSON(path) {
  try {
    const content = fs.readFileSync(path, "utf8");
    jsonData = JSON.parse(content);
    max.post(`Loaded JSON from: ${path}`);
  } catch (err) {
    max.post(`Error reading JSON file: ${err}`);
  }
}

/**
 * Set how many ms it takes to go from one row to the next.
 */
function setIntervalMs(ms) {
  readInterval = Math.max(1, ms);
  max.post(`Set row-to-row transition to ${readInterval} ms.`);
}

/**
 * Reset internal reading state so we start fresh at next 'start'.
 */
function resetState() {
  currentIndex = -1;
  previousRow = null;
  currentRow = null;
  elapsedTime = 0;
}

/**
 * Actually start reading:
 *  - Load first row into previousRow,
 *  - Then second row into currentRow,
 *  - Start a timer that fires every TICK_MS.
 */
function startReading() {
  stopReading();
  resetState();

  if (csvData.length < 1) {
    max.post("No CSV data loaded.");
    return;
  }

  // load first row
  if (!loadNextRow()) {
    max.post("No data row found—maybe empty file?");
    return;
  }

  // load second row (optional)
  loadNextRow();

  // Start the repeating timer for updates
  timerId = setInterval(tick, TICK_MS);
  max.post(
    `Started reading CSV. Interval=${readInterval} ms, TICK_MS=${TICK_MS}`
  );
}

/**
 * Stop reading if we are currently reading.
 */
function stopReading() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
    max.post("Stopped reading CSV data.");
  }
}

/**
 * loadNextRow attempts to load the next row in the CSV:
 *  - If previousRow is null, store this row there.
 *  - Else store in currentRow.
 * Returns false if we've run out of rows.
 */
function loadNextRow() {
  currentIndex++;
  if (currentIndex >= csvData.length) {
    return false;
  }

  const rawLine = csvData[currentIndex];
  // Convert each cell to float if possible
  let parsedLine = rawLine.map((val) => {
    let num = parseFloat(val);
    return isNaN(num) ? val : num;
  });

  if (!previousRow) {
    previousRow = parsedLine;
  } else {
    currentRow = parsedLine;
  }
  return true;
}

/**
 * Timer callback, called every TICK_MS.
 * If we have two rows (previous & current), we linearly interpolate
 * over readInterval ms. If we only have one row, we just hold that row.
 */
function tick() {
  // If there's only one row, or no currentRow, just output previousRow
  if (!currentRow) {
    outputDictionary(previousRow);
    return;
  }

  // fraction in [0..1]
  let fraction = elapsedTime / readInterval;
  if (fraction > 1) fraction = 1;

  // Interpolate
  let rowValues = interpolateRow(previousRow, currentRow, fraction);
  outputDictionary(rowValues);

  // Advance time
  elapsedTime += TICK_MS;

  // If we've hit the end of the ramp, finalize and move on
  if (elapsedTime >= readInterval) {
    // We are fully at currentRow
    previousRow = currentRow;
    currentRow = null;
    elapsedTime = 0;

    // Load next row
    if (!loadNextRow()) {
      // no more rows
      max.post("Reached end of CSV data. Stopping.");
      stopReading();
    }
  }
}

/**
 * Linear interpolation for numeric columns. If a cell is string, we jump at the end.
 */
function interpolateRow(a, b, frac) {
  return a.map((valA, i) => {
    let valB = b[i];
    if (typeof valA === "string" || typeof valB === "string") {
      // can't interpolate strings, so remain at valA until fraction=1
      return frac < 1 ? valA : valB;
    }
    // numeric
    return valA + (valB - valA) * frac;
  });
}

/**
 * Construct and send a dictionary out the single outlet.
 * Keys from headerNames, values from rowValues.
 */
function outputDictionary(rowValues) {
  let dictObj = {};
  headerNames.forEach((colName, idx) => {
    dictObj[colName] = rowValues[idx];
  });
  max.outlet(dictObj);
}

// -----------------------------------------------------
// MAX MESSAGE HANDLERS
// -----------------------------------------------------

// Load CSV
max.addHandler("loadCSV", (path) => loadCSV(path));

// Load JSON (optional)
max.addHandler("loadJSON", (path) => loadJSON(path));

// Set interpolation interval (ms)
max.addHandler("interval", (val) => setIntervalMs(parseInt(val, 10)));

// Start / Stop
max.addHandler("start", () => startReading());
max.addHandler("stop", () => stopReading());

// If you send a number directly, interpret it as setting the interval
max.addHandler("number", (val) => setIntervalMs(val));
