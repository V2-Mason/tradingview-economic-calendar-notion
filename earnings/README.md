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
`timezone=Asia/Hong_Kong`, and `theme=dark`.

## Data layers

```text
yfinance personal staging (.private/, never committed)
                  │
                  ▼ manual verification / licensed replacement
reviewed public feed (earnings/data/events.json)
                  │
                  ▼
GitHub Pages → Notion embed
```

The Pages repository is public. Do not put holdings, position sizes, costs,
stops, account identifiers, private Notion links, secrets, or an explicitly
labelled private watchlist into the public feed.

## Local yfinance staging

The collector is for personal research and does not make Yahoo an official or
governed event source. It deliberately refuses any output path under
`earnings/data/`.

On Windows:

```powershell
New-Item -ItemType Directory -Force .private
Copy-Item config/watchlist.example.json .private/watchlist.json
py -m venv .private/.venv
.private/.venv/Scripts/python.exe -m pip install -r requirements-yfinance.txt
.private/.venv/Scripts/python.exe scripts/fetch_yfinance_earnings.py
```

The default result is `.private/yfinance-earnings-staging.json`. It contains
`UNVERIFIED_SECONDARY`, `PERSONAL_USE_ONLY`, and
`publicReleaseApproved=false` markers.

The collector supports an exact US/HK ticker list. Use Yahoo codes such as
`AAPL` and `0700.HK`. The checked-in example is illustrative and is not the
user's real watchlist.

## Why staging cannot be published automatically

`yfinance` is an unofficial wrapper and states that Yahoo Finance data is for
personal use. It can supply earnings dates, EPS estimate/actual, market cap, and
often the next-quarter revenue estimate. It cannot reliably align a reported
revenue figure to every event, especially across Hong Kong disclosure formats.

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
