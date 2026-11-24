const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(responses, onWait = () => {}) {
  const source = fs.readFileSync('script.rate-limited.user.js', 'utf8');
  const context = { URLSearchParams, AbortController, setTimeout, clearTimeout, console };
  vm.createContext(context);
  vm.runInContext(source.slice(0, source.lastIndexOf('  setTimeout(() => {')) +
    '\nglobalThis.makeRequester = createPacedRequester;\n})();', context);
  let time = 0;
  const calls = [];
  const request = context.makeRequester({
    now: () => time,
    sleep: async ms => { time += ms; },
    fetchImpl: async () => { calls.push(time); return responses.shift(); },
    random: () => 0,
    onWait,
  });
  return { request, calls };
}

function loadContext(extra = {}) {
  const source = fs.readFileSync('script.rate-limited.user.js', 'utf8');
  const context = {
    URLSearchParams, AbortController, setTimeout, clearTimeout, console,
    document: {querySelector: () => null},
    ...extra,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(0, source.lastIndexOf('  setTimeout(() => {')) +
    '\nglobalThis.api = {enrichRows, runReportJob, Loading, buildReportData, buildReportWorkbook, tableToCSV, addButtons};\n})();', context);
  return context;
}

function reportRow(id) {
  return {
    appended: [],
    querySelector: () => ({getAttribute: () => `PaymentDetails('${id}','consignment','number','P')`}),
    insertAdjacentHTML(position, html) { this.appended.push(html); },
  };
}

const paymentParser = class {
  parseFromString(html) {
    return {querySelector: () => ({rows: [{innerHTML: html}, {innerHTML: 'second payment'}]})};
  }
};
const response = (status, retryAfter = null) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: () => retryAfter }, text: async () => '<table>ok</table>',
});

function workbookFixture() {
  const headers = ['S.No', 'Indent Number', 'Payment Status'];
  const cell = value => ({textContent: value});
  const table = {querySelector: () => ({rows: [{children: headers.map(cell)}]})};
  const payment = ['1', 'VAT', 'TX123', 'GRN456', '00012345678901234567', '1,234.50', '30-Sep-2026 14:13:09', 'Success'];
  const rows = [
    {children: ['1', 'IND123', 'Success (AD-VAL,TPF)', ...payment].map(cell)},
    {children: ['2', 'IND124', '=SOURCE TEXT', ...payment, ...payment].map(cell)},
    {children: ['3', 'IND125', 'Pending'].map(cell)},
  ];
  return {table, rows};
}

test('existing CSV serialization retains its original output and exact identifier digits', () => {
  const {api} = loadContext();
  const cell = text => ({innerText: text});
  const table = {querySelector: () => ({rows: [{children: ['ID', 'Status'].map(cell)}]})};
  const rows = [{children: ['00012345678901234567', 'Success (AD-VAL,TPF)'].map(cell)}];
  assert.equal(api.tableToCSV(table, rows), 'ID,Status\n00012345678901234567\t,Success (AD-VAL,TPF)');
});

test('toolbar offers separate CSV and XLSX export buttons', () => {
  const elements = [];
  const toolbar = {dataset: {}, append() {}};
  const {api} = loadContext({
    document: {
      querySelector: () => toolbar,
      createElement: tag => {
        const element = {tag, style: {}, append() {}, addEventListener() {}};
        elements.push(element);
        return element;
      },
    },
    location: {},
    $: () => ({attr: () => 'https://example.test/ifs'}),
  });
  api.addButtons();
  const labels = elements.filter(element => element.tag === 'button').map(element => element.innerText);
  assert.ok(labels.includes('Export CSV New Method'));
  assert.ok(labels.includes('Export XLSX'));
});

test('XLSX data preserves commas, long IDs and literal formula-like text with labeled payment groups', () => {
  const {api} = loadContext();
  const {table, rows} = workbookFixture();
  const data = api.buildReportData(table, rows);
  assert.equal(data.length, 4);
  data.forEach(row => assert.equal(row.length, 19));
  assert.equal(data[0][7], 'Payment 1 — Challan Number');
  assert.equal(data[0][15], 'Payment 2 — Challan Number');
  assert.equal(data[1][2].v, 'Success (AD-VAL,TPF)');
  assert.equal(data[1][7].v, '00012345678901234567');
  assert.equal(data[1][7].t, 's');
  assert.equal(data[1][8].v, 1234.5);
  assert.equal(data[1][8].t, 'n');
  assert.equal(data[2][2].v, '=SOURCE TEXT');
  assert.equal(data[2][2].t, 's');
  assert.equal(data[2][2].f, undefined);
  assert.equal(data[3][7].v, '');
});

test('unexpected payment column counts fail instead of shifting spreadsheet cells', () => {
  const {api} = loadContext();
  const {table, rows} = workbookFixture();
  rows[0].children.pop();
  assert.throws(() => api.buildReportData(table, rows), /payment columns/i);
});

test('actual XLSX round trip retains exact identifiers and numeric amounts', {skip: !process.env.SHEETJS_PATH}, () => {
  const XLSX = require(process.env.SHEETJS_PATH);
  const {api} = loadContext({XLSX});
  const {table, rows} = workbookFixture();
  const workbook = api.buildReportWorkbook(table, rows);
  const bytes = XLSX.write(workbook, {type: 'buffer', bookType: 'xlsx'});
  const restored = XLSX.read(bytes, {type: 'buffer'}).Sheets.Report;
  assert.equal(restored.H2.v, '00012345678901234567');
  assert.equal(restored.H2.t, 's');
  assert.equal(restored.I2.v, 1234.5);
  assert.equal(restored.I2.t, 'n');
  assert.equal(restored.C3.v, '=SOURCE TEXT');
  assert.equal(restored.C3.f, undefined);
  assert.equal(restored.C2.v, 'Success (AD-VAL,TPF)');
});

test('spaces successful requests instead of bursting', async () => {
  const { request, calls } = harness([response(200), response(200), response(200)]);
  await request('/details'); await request('/details'); await request('/details');
  assert.deepEqual(calls, [0, 250, 500]);
});
test('429 waits for Retry-After before retrying', async () => {
  const { request, calls } = harness([response(429, '60'), response(200)]);
  assert.equal(await request('/details'), '<table>ok</table>');
  assert.deepEqual(calls, [0, 60000]);
  assert.equal(request.concurrency(), 25);
});
test('rate-limit wait updates its remaining time automatically', async () => {
  const messages = [];
  const { request } = harness([response(429, '60'), response(200)], message => messages.push(message));
  await request('/details');
  assert.ok(messages.some(message => message.includes('60s remaining')));
  assert.ok(messages.some(message => message.includes('30s remaining')));
  assert.ok(messages.some(message => message.includes('1s remaining')));
  assert.ok(messages.some(message => message.includes('Resuming')));
});
test('repeated rate limits keep batch size fixed at 25', async () => {
  const {request} = harness([response(429), response(429), response(200)]);
  await request('/details');
  assert.equal(request.concurrency(), 25);
});
test('429 without Retry-After uses increasing backoff', async () => {
  const { request, calls } = harness([response(429), response(429), response(200)]);
  await request('/details');
  assert.deepEqual(calls, [0, 30000, 90000]);
});
test('HTTP-date Retry-After is respected', async () => {
  const { request, calls } = harness([response(429, new Date(90000).toUTCString()), response(200)]);
  await request('/details');
  assert.deepEqual(calls, [0, 90000]);
});
test('persistent rate limiting stops after bounded retries', async () => {
  const { request, calls } = harness(Array.from({length: 6}, () => response(429)));
  await assert.rejects(request('/details'), /429/);
  assert.equal(calls.length, 6);
});
test('does not parse HTTP errors as payment tables', async () => {
  const { request, calls } = harness([response(403)]);
  await assert.rejects(request('/details'), /403/);
  assert.equal(calls.length, 1);
});
test('cancellation stops before another request', async () => {
  const { request, calls } = harness([response(200)]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(request('/details', {signal: controller.signal}), /abort/i);
  assert.equal(calls.length, 0);
});

test('export enriches 60 rows with no more than 25 requests active', async () => {
  const {api} = loadContext({DOMParser: paymentParser});
  let active = 0, peak = 0;
  const request = async (url, options) => {
    active++; peak = Math.max(peak, active);
    const id = new URLSearchParams(options.body).get('indentID');
    await new Promise(resolve => setTimeout(resolve, Number(id) % 3));
    active--;
    return `payment ${id}`;
  };
  request.concurrency = () => 25;
  const rows = Array.from({length: 60}, (_, id) => reportRow(id));
  await api.enrichRows(rows, request);
  assert.equal(peak, 25);
  rows.forEach((row, id) => assert.deepEqual(row.appended, [`payment ${id}`, 'second payment']));
});

test('duplicate lookup across rows is fetched once and populates both rows', async () => {
  const {api} = loadContext({DOMParser: paymentParser});
  let requests = 0;
  const request = async () => { requests++; return 'shared details'; };
  request.concurrency = () => 25;
  const rows = [reportRow('same'), reportRow('same')];
  await api.enrichRows(rows, request);
  assert.equal(requests, 1);
  rows.forEach(row => assert.deepEqual(row.appended, ['shared details', 'second payment']));
});

test('progress increments after each row without waiting for the rest of the batch', async () => {
  const {api} = loadContext({DOMParser: paymentParser});
  const messages = [];
  api.Loading.message = message => messages.push(message);
  const pending = new Map();
  const request = (url, options) => new Promise(resolve => {
    pending.set(new URLSearchParams(options.body).get('indentID'), resolve);
  });
  request.concurrency = () => 25;
  const rows = [reportRow('a'), reportRow('b'), reportRow('c')];
  const work = api.enrichRows(rows, request);
  pending.get('b')('payment b');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(message => message.includes('1/3 rows')));
  assert.equal(rows[0].appended.length, 0);
  pending.get('a')('payment a');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(message => message.includes('2/3 rows')));
  pending.get('c')('payment c');
  await work;
  assert.ok(messages.at(-1).includes('3/3 rows'));
});

test('HTTP failure shows error, clears overlay and permits another job without downloading', async () => {
  const alerts = [], displays = [];
  let downloads = 0;
  const context = loadContext({
    XLSX: {},
    window: {location: {href: 'https://example.test/ifs'}},
    fetch: async () => response(403),
    alert: message => alerts.push(message),
    console: {log() {}, error() {}},
    $: () => ({css: (key, value) => displays.push(value)}),
    document: {querySelector: () => null, createElement: () => {downloads++; throw new Error('Unexpected download');}},
  });
  await context.api.runReportJob(true);
  await context.api.runReportJob(true);
  assert.equal(alerts.length, 2);
  alerts.forEach(message => assert.match(message, /403/));
  assert.deepEqual(displays, ['', 'none', '', 'none']);
  assert.equal(downloads, 0);
});
