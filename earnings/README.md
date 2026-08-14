# HK & US Earnings Calendar

This directory contains a free FullCalendar Standard month view for embedding in
Notion. The production page reads `events.json`; `events.demo.json` is synthetic
and is loaded only when the URL includes `?demo=1`.

## URLs

Production:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/earnings/?compact=1
```

Visual demo:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/earnings/?demo=1
```

## Public-data boundary

GitHub Pages and this repository are public. Do not put account identifiers,
position sizes, position/watchlist classifications, private Notion URLs, API
keys, or other portfolio-sensitive data in either JSON file. A future publisher
may emit public earnings events, but private portfolio filtering requires a
separate private delivery design.

## Event shape

Each production event is a FullCalendar event object. Governance metadata is
stored under `extendedProps`:

```json
{
  "id": "stable-versioned-event-id",
  "title": "AMC · US.SYMBOL | Company",
  "start": "2026-08-18",
  "allDay": true,
  "color": "#2563eb",
  "contrastColor": "#ffffff",
  "extendedProps": {
    "market": "US",
    "symbol": "US.SYMBOL",
    "company": "Company",
    "period": "Q2 2026",
    "session": "AMC",
    "confidence": "CONFIRMED",
    "originalTimezone": "America/New_York",
    "newYorkTime": "2026-08-18 · AMC",
    "hongKongTime": "2026-08-19 · 盘前",
    "sourcePublishedAt": "2026-08-01T12:00:00Z",
    "sourceLabel": "Company investor relations",
    "sourceUrl": "https://issuer.example/official-release"
  }
}
```

`confidence` must be `CONFIRMED` or `ESTIMATED`. A price move is never evidence
that an earnings event occurred. Production records need an official source and
the source's original IANA timezone before being treated as confirmed.
