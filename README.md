# StateExcise Assam report exporter

Export wholesale reports with payment details as CSV or Excel. Uses standard userscript APIs for **Violentmonkey and Tampermonkey**; live portal testing so far has used Violentmonkey.

## Setup

1. Install [Violentmonkey](https://violentmonkey.github.io/get-it/) or [Tampermonkey](https://www.tampermonkey.net/). Use one manager for this script.
2. In Brave or Chrome, open `chrome://extensions`, select your userscript manager's **Details**, and enable **Allow user scripts** if shown. Allow access to `stateexcise.assam.gov.in`.
3. Open the [installation link](https://raw.githubusercontent.com/RohanDebroy/stateexcise-script/main/script.rate-limited.user.js) and click **Install**. If you see plain text, import that URL through your manager's dashboard.
4. Disable any older copies of this script.
5. Sign in to the [StateExcise portal](https://stateexcise.assam.gov.in/index.php/Wholesale/indent/ifs) and reload the page.

## Export

1. Choose the dates and status, then click **Search**.
2. Click **Export CSV New Method** or **Export XLSX**.
3. Keep the tab open until the download finishes. Progress updates after every row. Rate limits trigger an automatic wait countdown and retry; batches stay at 25.

**Use XLSX for Excel:** it includes payment headers and preserves long identifiers and leading zeroes as text. Payment amounts remain numeric.

CSV keeps the original format, including its existing limitations: embedded commas can shift columns, payment columns have no extra headers, and Excel may alter long numbers. Import identifier columns as **Text**, or use XLSX.

## Updates

Enable automatic update checks in your userscript manager. Install from the link above once; newer versions will be picked up during periodic checks. Reload the portal after updating.

To publish changes, increase `@version`, run the checks below, then commit and push to `main` in this repository.

## Privacy

No credentials, tokens, cookies, or real transaction fixtures are included. The script uses your existing portal login. Report data stays in your browser and the downloaded file; it is not uploaded to GitHub. The XLSX library is loaded from the official SheetJS CDN.

Do not commit HAR files, reports, snapshots, or credentials. This is an independent helper, not an official government application.

## Checks

With Node.js 18 or newer:

```sh
node --check script.rate-limited.user.js
node --test
```

To include the XLSX binary round-trip test:

```sh
curl -fL https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js -o /tmp/stateexcise-xlsx-0.20.3.cjs
SHEETJS_PATH=/tmp/stateexcise-xlsx-0.20.3.cjs node --test
```
