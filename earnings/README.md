# US & HK earnings dashboard

This route replaces the FullCalendar experiment with a date-grouped table that
keeps the useful Finlogix reading pattern:

- company and ticker;
- EPS actual, market consensus, and optional user forecast;
- revenue actual, market consensus, and optional user forecast;
- market cap;
- BMO/AMC/unknown timing and released status;
- original timezone plus UTC, New York, and Hong Kong materializations in the
  event detail dialog.

The private Notion build has two independent, switchable providers. Moomoo and
Yahoo use the same controls, table, and detail dialog, but their snapshots are
never merged or used to silently fill one another's missing fields.

## URLs

Production shell:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/earnings/?compact=1
```

Synthetic appearance preview:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/earnings/?demo=1&compact=1
```

Optional parameters include `range=next-week`, `markets=US,HK`,
`timezone=Asia/Hong_Kong`, `source=moomoo|yahoo`, and `theme=dark`.

## Data layers

```text
Moomoo OpenD snapshot ─┐
                       ├─ private source catalog → single-file Notion attachment
Yahoo personal staging ┘

reviewed public feed → GitHub Pages shell (no personal provider data)
```

The Pages repository is public. Do not put holdings, position sizes, costs,
stops, account identifiers, private Notion links, secrets, or an explicitly
labelled private watchlist into the public feed.

## Local Moomoo staging

Moomoo is the preferred private source when a current snapshot is available.
The collector connects only to loopback OpenD and creates no trade context:

```powershell
python scripts/fetch_moomoo_earnings.py
```

It writes `.private/moomoo-earnings-staging.json`, which is ignored by Git. The
collector reads only the earnings-calendar endpoint; it does not read account
data, unlock trading, or submit an order. Moomoo timestamps and BEFORE/AFTER
labels remain provider observations until issuer IR, SEC, or HKEX confirms
them.

## Local yfinance staging

The versioned zero-dependency Yahoo collector is the default local automation
path. It is for personal research and does not make Yahoo an official or
governed event source:

```powershell
node scripts/fetch_yahoo_quote_summary.mjs
```

It writes `.private/yahoo-earnings-staging.json` atomically and refuses input or
output paths outside `.private/`.

The yfinance collector remains an optional fallback. It also deliberately
refuses any output path under `earnings/data/` and now uses the same default
`.private/yahoo-earnings-staging.json` filename consumed by the private builder.

On Windows:

```powershell
New-Item -ItemType Directory -Force .private
Copy-Item config/watchlist.example.json .private/watchlist.json
py -m venv .private/.venv
.private/.venv/Scripts/python.exe -m pip install -r requirements-yfinance.txt
.private/.venv/Scripts/python.exe scripts/fetch_yfinance_earnings.py
```

The default result is `.private/yahoo-earnings-staging.json`. It contains
`UNVERIFIED_SECONDARY`, `PERSONAL_USE_ONLY`, and
`publicReleaseApproved=false` markers.

The collector supports an exact US/HK ticker list. Use Yahoo codes such as
`AAPL` and `0700.HK`. The checked-in example is illustrative and is not the
user's real watchlist.

## Why staging cannot be published automatically

`yfinance` is an unofficial wrapper and states that Yahoo Finance data is for
personal use. This collector uses only the ticker-scoped quote-summary calendar
for the next earnings date, EPS/revenue estimates, and market cap. It does not
trust the Yahoo earnings HTML table for ticker ownership, because the live page
has been observed ignoring its `symbol=` filter. Historical EPS/revenue actuals
therefore remain null until they are aligned and verified from an official
filing or results release.

The Yahoo date is treated as date-only. BMO/AMC remains `UNKNOWN` until issuer
IR, SEC, or HKEX confirms the release time. Estimate currency comes from the
issuer's reported financial currency when Yahoo supplies it; trading currency
is used only for market cap.

Before an event enters `events.json`:

1. confirm the event date and time from issuer IR, SEC, or HKEX;
2. confirm released actual values from the original filing or results release;
3. use only a licensed provider for market-consensus fields, or leave them null;
4. keep the user's forecast marked as user-owned;
5. set `dataStatus=PUBLIC_REVIEWED`, use an allowed redistribution status, and
   set `publicReleaseApproved=true`;
6. run `npm run validate`.

The public feed schema is [`public-feed.schema.json`](public-feed.schema.json).
Presentation data never becomes canonical investment-workbench state.

## Private Notion build

After refreshing either provider, build the self-contained attachment:

```powershell
node scripts/build_notion_earnings.mjs
```

If Moomoo is unavailable, its tab remains visible with an explicit `未连接`
state; the interface never falls back to Yahoo without the user selecting it.

The builder applies a freshness limit, marks retained old snapshots `STALE`,
marks partial collections `PARTIAL`, embeds all CSS, JavaScript, and data, and
rejects external script or stylesheet dependencies. Generic collector and
builder logic is versioned under `scripts/`; the watchlist, snapshots, logs,
generated HTML, and Notion configuration remain under ignored `.private/`.

## Local automatic update

Preview the complete workflow without network access, file writes, mutex
acquisition, Scheduled Task changes, or Notion writes:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/update_private_earnings.ps1 -DryRun
```

Run the local-only update explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/update_private_earnings.ps1
```

The updater uses a named mutex, checks loopback OpenD, collects Moomoo, Yahoo,
and company news independently, validates fresh candidate snapshots, and only
then atomically replaces each last-known-good file. The earnings HTML is built
to a temporary path, checked for its embedded catalog/offline CSP, and atomically
published. Failures leave the prior snapshot or HTML in place. Logs are written
to `.private/logs/`.

Notion is an explicit external-write boundary. `-PublishNotion` runs configured
Notion sync commands only after local collection and build succeed; omitting the
switch never writes to Notion. `-DryRun -PublishNotion` only reports the proposed
publish and still performs no external write.

The Windows PowerShell 5.1 installer can be inspected without registering a
task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/install_windows_task.ps1 -WhatIf
```

The fixed `Trader Master Journal Market Intelligence Sync` task uses the
current user's `InteractiveToken` without a
stored credential, triggers at logon and every two hours, ignores overlapping
runs, starts when available, and invokes the updater with `-PublishNotion`.
Registration and removal remain explicit operations; the repository does not
register a task merely by running validation.
