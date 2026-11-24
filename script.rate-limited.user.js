// ==UserScript==
// @name         [LATEST] Rate-limited Consolidated Report to CSV and Excel [StateExcise Assam]
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Export StateExcise Assam reports to CSV or Excel with payment details, paced requests and rate-limit retries.
// @author       Rohan Debroy
// @updateURL    https://raw.githubusercontent.com/RohanDebroy/stateexcise-script/main/script.rate-limited.user.js
// @downloadURL  https://raw.githubusercontent.com/RohanDebroy/stateexcise-script/main/script.rate-limited.user.js
// @homepageURL  https://github.com/RohanDebroy/stateexcise-script
// @supportURL   https://github.com/RohanDebroy/stateexcise-script/issues
// @match        https://stateexcise.assam.gov.in/*
// @icon
// @require      https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  "use strict";

  /** Endpoints and selectors used across the script. */
  const ENDPOINTS = {
    paymentDetails: "https://stateexcise.assam.gov.in/index.php/Wholesale/indent/paymentdetails",
    indentIFS: "https://stateexcise.assam.gov.in/index.php/Wholesale/indent/ifs",
  };

  const SELECTORS = {
    /** The redesigned report toolbar lives in `.bottom_tab form` (was `.tabs-bottombg`). */
    toolbar: ".bottom_tab",
    toolbarTop: "#my-table-sorter_wrapper > div.control-top",
    table: "table#my-table-sorter",
    thead: "#thead",
    tbody: "#tbody",
    globalLoading: "div#global-loading",
    dateStart: "#datepicker",
    dateEnd: "#datepicker1",
    status: "#status",
    supplier: "#supplier",
    tableInfo: "#my-table-sorter_info",
    lengthSelect: '.select2-hidden-accessible[name="my-table-sorter_length"]',
    paymentDetailsButton: 'button[title="Payment Details"]',
  };

  /** Tiny helpers over the global loading overlay. */
  const Loading = {
    show(message = "") {
      $(SELECTORS.globalLoading).css("display", "");
      this.message(message);
    },
    hide() {
      $(SELECTORS.globalLoading).css("display", "none");
    },
    message(text) {
      const heading = document
        .querySelector(SELECTORS.globalLoading)
        ?.querySelector("h2");
      if (heading) heading.innerText = text;
    },
  };

  /** Build a styled toolbar button matching the site's `.btn-search` look. */
  function makeButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-search";
    button.style.marginLeft = "8px";
    button.innerText = label;
    button.addEventListener("click", onClick);
    return button;
  }

  /** Append the action buttons to the report toolbar's inline form. */
  function addButtons() {
    const form = document.querySelector(SELECTORS.toolbarTop);
    if (!form || form.dataset.exscriptInjected === "1") return;
    form.dataset.exscriptInjected = "1";

    const btnViewFull = makeButton("View Full Table", viewFull);
    const btnLoadPayments = makeButton("Load Payment Details", loadPaymentDetails);
    const btnExportNew = makeButton("Export CSV New Method", exportEnrichedReport);
    const btnExportXlsx = makeButton("Export XLSX", exportEnrichedExcel);

    // Wrap in a form-group so the buttons sit inline with the existing controls.
    const group = document.createElement("div");
    group.className = "form-group";
    group.append(btnViewFull);
    if ($(location).attr("href").includes("ifs")) {
      group.append(btnLoadPayments);
    }
    group.append(btnExportNew);
    group.append(btnExportXlsx);
    form.append(group);
  }

  /** Normalize a cell/row's text for CSV: collapse newlines/tabs, trim. */
  function csvCell(text) {
    return String(text).replaceAll("\n", "").replaceAll("\t", "").trim();
  }

  /** Serialize a DOM table (header from #thead, body from `rows`) to a CSV string. */
  function tableToCSV(table, rows) {
    const header = Array.from(table.querySelector(SELECTORS.thead).rows[0].children)
      .map((cell) => csvCell(cell.innerText))
      .join(",");

    const body = Array.from(rows).map((row) =>
      Array.from(row.children)
        .map((cell) => csvCell(cell.innerText))
        .join("\t,"),
    );

    return [header, ...body].join("\n");
  }

  /** Trigger a download of `csv` text as `filename`. */
  function downloadCSV(csv, filename) {
    const link = document.createElement("a");
    link.download = filename;
    link.href = window.URL.createObjectURL(
      new Blob([csv], { type: "text/csv" }),
    );
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  const PAYMENT_HEADERS = [
    "S.No", "Process Name", "Excise Transaction ID",
    "GRN Number", "Challan Number", "Transaction Amount",
    "Transaction Date", "Transaction Status",
  ];

  function cellText(cell) {
    return String(cell.innerText ?? cell.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function spreadsheetCell(text, isAmount = false) {
    const numeric = text.replaceAll(",", "");
    if (isAmount && /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)
      && numeric.replace(/[^0-9]/g, "").length <= 15 && Number.isFinite(Number(numeric))) {
      return {t: "n", v: Number(numeric), z: "#,##0.00"};
    }
    // Explicit string cells preserve leading zeroes and never become formulas.
    return {t: "s", v: text, z: "@"};
  }

  function buildReportData(table, rows) {
    const headers = Array.from(table.querySelector(SELECTORS.thead).rows[0].children, cellText);
    const values = Array.from(rows, row => Array.from(row.children, cellText));
    let maxPayments = 0;
    for (const cells of values) {
      const extra = cells.length - headers.length;
      if (extra < 0 || extra % PAYMENT_HEADERS.length !== 0) {
        throw new Error("Unexpected payment columns. Export stopped to avoid misaligned data.");
      }
      maxPayments = Math.max(maxPayments, extra / PAYMENT_HEADERS.length);
    }
    const allHeaders = [...headers];
    for (let payment = 1; payment <= maxPayments; payment++) {
      allHeaders.push(...PAYMENT_HEADERS.map(header => `Payment ${payment} — ${header}`));
    }
    const data = values.map(cells => Array.from({length: allHeaders.length}, (_, index) => {
      const isAmount = index >= headers.length && (index - headers.length) % PAYMENT_HEADERS.length === 5;
      return spreadsheetCell(cells[index] ?? "", isAmount);
    }));
    return [allHeaders, ...data];
  }

  function buildReportWorkbook(table, rows) {
    const data = buildReportData(table, rows);
    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet["!cols"] = data[0].map(header => ({wch: Math.min(42, Math.max(16, header.length + 2))}));
    sheet["!autofilter"] = {ref: sheet["!ref"]};
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Report");
    return workbook;
  }

  function downloadWorkbook(table, rows) {
    XLSX.writeFile(buildReportWorkbook(table, rows), "data.xlsx", {compression: true, bookType: "xlsx"});
  }

  /** Switch the DataTable page-length selector to show every entry at once. */
  function viewFull() {
    const infoEl = $(SELECTORS.tableInfo)[0];
    if (!infoEl) return;

    const entries = Number(
      infoEl.innerText
        .split("of")[1]
        .replace("entries", "")
        .replaceAll(" ", "")
        .replaceAll(",", ""),
    );
    if (!entries) return;

    const select = $(SELECTORS.lengthSelect);
    const selectEl = select[0];
    if (!selectEl) return;

    const allOption = document.createElement("option");
    allOption.value = parseInt(entries, 10);
    allOption.innerText = `ALL(${entries})`;
    selectEl.appendChild(allOption);
    select.val(entries).trigger("change");
  }

  /* Both payment loading and Excel export share the paced request pool. */

  // One job at a time prevents overlapping exports multiplying request traffic.
  let activeJob = false;
  const MAX_CONCURRENT_REQUESTS = 25;
  const REQUEST_INTERVAL_MS = 250;

  /** Shared start gate: every retry and request respects the same cooldown. */
  function createPacedRequester({
    fetchImpl = (...args) => fetch(...args),
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    random = () => Math.random(),
    onWait = () => {},
  } = {}) {
    let gate = Promise.resolve();
    let nextStart = 0;
    let cooldownUntil = 0;
    let interval = REQUEST_INTERVAL_MS;
    let stopped = null;

    async function waitForTurn(signal) {
      const turn = gate.then(async () => {
        signal?.throwIfAborted();
        if (stopped) throw stopped;
        // Recheck after sleeping: another in-flight request may extend cooldown.
        while (nextStart > now()) {
          signal?.throwIfAborted();
          if (stopped) throw stopped;
          if (cooldownUntil > now()) {
            onWait(`Rate limited (429): ${Math.ceil((cooldownUntil - now()) / 1000)}s remaining. Batch size: ${MAX_CONCURRENT_REQUESTS}.`);
          }
          await sleep(Math.min(nextStart - now(), 1000));
        }
        signal?.throwIfAborted();
        if (stopped) throw stopped;
        if (cooldownUntil && now() >= cooldownUntil) {
          cooldownUntil = 0;
          onWait(`Wait complete. Resuming requests; batch size: ${MAX_CONCURRENT_REQUESTS}.`);
        }
        nextStart = now() + interval;
      });
      gate = turn.catch(() => {});
      await turn;
    }

    async function request(url, options = {}) {
      try {
        for (let attempt = 0; attempt <= 5; attempt++) {
          await waitForTurn(options.signal);
          const response = await fetchImpl(url, options);
          if (response.status === 429) {
            interval = Math.min(interval * 2, 10000);
            const header = response.headers.get("Retry-After");
            const seconds = header === null || header.trim() === "" ? NaN : Number(header);
            const date = Date.parse(header ?? "");
            let serverDelay = 0;
            if (Number.isFinite(seconds) && seconds >= 0) {
              serverDelay = seconds * 1000;
            } else if (Number.isFinite(date)) {
              serverDelay = Math.max(0, date - now());
            }
            const delay = Math.max(serverDelay, 30000 * 2 ** attempt) + Math.floor(random() * 1000);
            cooldownUntil = Math.max(cooldownUntil, now() + delay);
            nextStart = Math.max(nextStart, cooldownUntil);
            // Consume the error response, never treat it as payment HTML.
            await response.text();
            if (attempt === 5) throw new Error("HTTP 429: rate limit persisted after 5 retries. Wait before trying again.");
            onWait(`Rate limited (429): ${Math.ceil((cooldownUntil - now()) / 1000)}s remaining; retry ${attempt + 1}/5. Batch size: ${MAX_CONCURRENT_REQUESTS}.`);
            continue;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}: report export stopped.`);
          return await response.text();
        }
      } catch (error) {
        stopped = error;
        throw error;
      }
    }
    request.concurrency = () => MAX_CONCURRENT_REQUESTS;
    return request;
  }

  /** Keep each response attached to its source row, including duplicate indents. */
  async function enrichRows(rows, request, onProgress = (completed, total) => {
    Loading.message(`Processed ${completed}/${total} rows (batch size: ${MAX_CONCURRENT_REQUESTS})`);
  }) {
    const cache = new Map();
    let completed = 0;
    for (let i = 0; i < rows.length;) {
      const batch = rows.slice(i, i + request.concurrency());
      const results = await Promise.allSettled(batch.map(async row => {
        const details = await fetchPaymentDetails(row, request, cache);
        for (const detail of details) row.insertAdjacentHTML("beforeend", detail.innerHTML);
        completed++;
        onProgress(completed, rows.length);
      }));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      i += batch.length;
    }
  }

  async function runReportJob(exportFile, format = "csv") {
    if (activeJob) return;
    activeJob = true;
    let processed = 0;
    let total = 0;
    let waitMessage = "";
    function showProgress() {
      const progress = total
        ? `Processed ${processed}/${total} rows (batch size: ${MAX_CONCURRENT_REQUESTS})`
        : "Fetching report...";
      Loading.message(waitMessage ? `${progress}\n${waitMessage}` : progress);
    }
    const request = createPacedRequester({onWait: message => {
      waitMessage = message.startsWith("Wait complete.") ? "" : message;
      showProgress();
    }});
    try {
      Loading.show("Fetching report...");
      if (exportFile && format === "xlsx" && typeof XLSX === "undefined") throw new Error("Excel library unavailable. Save the complete userscript including its @require line, then reload.");
      const dom = exportFile ? await fetchReportDOM(getReportFilters(), request) : document;
      const tbody = dom.querySelector(SELECTORS.tbody);
      if (!tbody) throw new Error("Report table missing. Check your login and reload the page.");
      const rows = Array.from(tbody.rows);
      if (!rows.length) throw new Error("No records found for the selected dates and filters.");
      total = rows.length;
      showProgress();
      await enrichRows(rows, request, completed => {
        processed = completed;
        showProgress();
      });
      if (exportFile) {
        const table = dom.querySelector(SELECTORS.table);
        if (format === "xlsx") downloadWorkbook(table, rows);
        else downloadCSV(tableToCSV(table, rows), "data.csv");
      }
    } catch (error) {
      console.error("StateExcise report:", error);
      alert(`Report stopped: ${error.message}\n${exportFile ? "No file was downloaded; incomplete reports are not exported." : "Some rows may already contain payment details. Reload before retrying."}`);
    } finally {
      Loading.hide();
      activeJob = false;
    }
  }

  function loadPaymentDetails() { return runReportJob(false); }

  /** dd-Mon-yyyy, e.g. 04-Jul-2026. */
  function formatDate(date = new Date()) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = date.toLocaleString("en-GB", { month: "short" });
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  }

  /** Read the toolbar filter values, mirroring the site's searchtext() form POST. */
  function getReportFilters() {
    const startDate = document.querySelector(SELECTORS.dateStart)?.value ?? "";
    const endDate = document.querySelector(SELECTORS.dateEnd)?.value ?? formatDate();
    // New UI exposes a #status dropdown; #supplier is absent on this page (undefined).
    const status =
      document.querySelector(SELECTORS.status)?.value ?? "all";
    const supplier =
      document.querySelector(SELECTORS.supplier)?.value ?? "undefined";
    return { startDate, endDate, status, supplier };
  }

  /** POST the report page to itself with the active filters and return the parsed DOM. */
  async function fetchReportDOM(filters, request) {
    const { startDate, endDate, status, supplier } = filters;
    console.log(`Getting document for ${startDate} to ${endDate} (status=${status})`);
    const htmlText = await request(window.location.href, {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "accept-language": "en-GB,en;q=0.9",
        "cache-control": "max-age=0",
        "content-type": "application/x-www-form-urlencoded",
      },
      referrer: window.location.href,
      body: `sdate=${encodeURIComponent(startDate)}&edate=${encodeURIComponent(endDate)}&status=${encodeURIComponent(status)}&supplier=${encodeURIComponent(supplier)}`,
      method: "POST",
      mode: "cors",
      credentials: "include",
    });
    console.log(`Got document for ${startDate} to ${endDate}`);
    return new DOMParser().parseFromString(htmlText, "text/html");
  }

  /** Fetch the payment-details sub-rows for one indent row. */
  async function fetchPaymentDetails(row, request, cache) {
    const button = row.querySelector(SELECTORS.paymentDetailsButton);
    if (!button) return [];

    const onclickStr = button.getAttribute("onclick");
    const [indentID, consignment, indentnumber, status] = onclickStr
      .match(/\((.*)\)/)[1]
      .split(",")
      .map((p) => p.trim().replace(/^['"]|['"]$/g, ""));

    const body = new URLSearchParams({indentID, consignment, indentnumber, status}).toString();
    if (!cache.has(body)) {
      cache.set(body, request(ENDPOINTS.paymentDetails, {
        headers: {"content-type": "application/x-www-form-urlencoded; charset=UTF-8"},
        body,
        method: "POST",
        credentials: "include",
      }));
    }
    // Parse a fresh DOM per row so cached responses can be reused safely.
    const html = new DOMParser().parseFromString(await cache.get(body), "text/html");
    const tbody = html.querySelector("tbody");
    if (!tbody) throw new Error(`Payment response for indent ${indentID} has no table. Check your session.`);
    return Array.from(tbody.rows);
  }

  function exportEnrichedReport() { return runReportJob(true, "csv"); }

  function exportEnrichedExcel() { return runReportJob(true, "xlsx"); }

  /** Inject buttons the moment the toolbar exists (no fixed-delay racing). */
  function bootWhenReady() {
    if (document.querySelector(SELECTORS.toolbarTop)) {
      addButtons();
      return;
    }

    const observer = new MutationObserver((mutations, obs) => {
      if (document.querySelector(SELECTORS.toolbarTop)) {
        obs.disconnect();
        addButtons();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  setTimeout(() => {
    /* Boot — try immediately, otherwise wait for the toolbar to be inserted. */
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootWhenReady, { once: true });
    } else {
      bootWhenReady();
    }
  }, 3000);

})();
