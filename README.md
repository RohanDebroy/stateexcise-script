# StateExcise Assam report exporter

A Violentmonkey userscript for the StateExcise Assam wholesale report table. It adds CSV and Excel exports with payment details, progress tracking, and retries for HTTP 429 rate limits.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/get-it/) in Brave, Chrome, Firefox, or another supported browser.
2. In Brave or Chrome, open `chrome://extensions`, select **Violentmonkey → Details**, and enable **Allow user scripts** if that setting is present. Site access must allow the StateExcise Assam domain.
3. Open the [userscript installation link](https://raw.githubusercontent.com/RohanDebroy/stateexcise-script/main/script.rate-limited.user.js). Violentmonkey should show an installation screen; click **Install**. If it displays plain text, use Violentmonkey's **Install from URL** option with that same URL.
4. Disable older copies of the StateExcise exporter to avoid duplicate buttons or competing requests.
5. Sign in to the [StateExcise Assam portal](https://stateexcise.assam.gov.in/index.php/Wholesale/indent/ifs) using your own account, then reload the page.

No GitHub account or access token is needed to install this public script.

## Export a report

1. Select the start date, end date, and status. Click **Search** so the table and selected filters agree.
2. Choose an export button:
   - **Export CSV New Method** retains the existing CSV output format.
   - **Export XLSX** creates `data.xlsx` with payment-column headers. Identifiers are stored as text to preserve long numbers and leading zeroes; payment amounts are numeric.
3. Keep the tab open until the file downloads. The counter updates after each completed row.

Both exports fetch a fresh report using the date and status fields, then request payment details. **View Full Table** expands the displayed table. **Load Payment Details** appends payment details to displayed rows; it is not required before exporting.

## Rate limits and progress

- Work is grouped in batches of up to **25 rows**, with request starts initially spaced **250 ms** apart.
- A 429 pauses new request starts. The script respects `Retry-After`, uses increasing fallback waits, and displays a countdown.
- The failed request is retried with the same payment lookup, up to five retries. Already queued requests may run before the retry.
- Batch size stays at 25, while request spacing increases after rate limiting. Already in-flight requests can still finish during a pause.
- Duplicate payment lookups share one response within the export. Payment details remain attached to their source row even when responses arrive out of order.
- If a request ultimately fails, the script reports the error and does not download an incomplete export. A new export starts again; progress is not saved across reloads.

## CSV and Excel

Use **XLSX** when opening the report in Excel. CSV cannot specify text cell types, and Excel can alter numeric identifiers longer than 15 digits or remove leading zeroes.

For CSV, use **Data → From Text/CSV → Transform Data** and set identifier columns to **Text** before loading. The legacy CSV format also leaves embedded commas unquoted and omits headers for appended payment details, so fields such as `(AD-VAL,TPF)` can shift columns in a standard CSV importer. The XLSX export avoids these issues.

## Automatic updates

Install from the linked URL and enable update checks in Violentmonkey. The script's `@downloadURL` points to this repository. When a higher `@version` is pushed to `main`, Violentmonkey can install it during its next update check. Updates are periodic, not instantaneous; you can also check manually. Reload the portal afterward.

If you previously installed by pasting code, install from the link once and disable the old copy. Keep the script name and namespace stable in future releases.

To publish an update: edit the script, increase `@version`, run the tests, and commit and push the change to `main`.

## Credentials and privacy

- The userscript contains no hardcoded account credentials, API keys, access tokens, or session cookies.
- Portal requests use the browser's existing signed-in session and go to the StateExcise Assam site. Sign in normally; do not add credentials to the source.
- Workbook generation happens in the browser. The script does not upload portal responses or exported files to GitHub or an analytics service.
- Violentmonkey downloads the pinned [SheetJS browser library](https://docs.sheetjs.com/docs/getting-started/installation/standalone/) from its official CDN for XLSX support.
- Do not commit HAR files, downloaded reports, browser snapshots, or credentials. The included `.gitignore` excludes common local data files.

This is an independent helper, not an official StateExcise Assam application. It exports the portal's responses; it cannot verify the underlying government records or banking transactions.

## Development and checks

Use Node.js 18 or newer:

```sh
node --check script.rate-limited.user.js
node --test
```

The XLSX binary round-trip test is optional in the default run. To run it with the same library used by Violentmonkey:

```sh
curl -fL https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js -o /tmp/stateexcise-xlsx-0.20.3.cjs
SHEETJS_PATH=/tmp/stateexcise-xlsx-0.20.3.cjs node --test
```

Tests use synthetic fixtures and simulated requests; they do not contact the portal. They cover pacing, retry timing, countdowns, row-to-payment associations, progress, separate export buttons, and identifier preservation.

Report problems through [GitHub Issues](https://github.com/RohanDebroy/stateexcise-script/issues). Remove credentials, cookies, and private business or transaction data before attaching logs.
