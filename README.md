# TradingView Economic Calendar for Notion

A minimal GitHub Pages wrapper for TradingView's official Economic Calendar widget.
It is designed to replace an Apption-hosted embed in Notion without exposing any
investment-workbench, account, or trading data.

## Default view

- United States events only
- High-importance events only
- English event labels
- Automatic light/dark theme
- Responsive width for a Notion embed block
- TradingView attribution preserved

## Notion embed

Paste this URL into Notion and select **Create embed**:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/
```

Resize the Notion embed block to roughly 500–700 px high. The hosted page is public,
but contains no personal or portfolio data.

## Optional URL settings

The defaults can be changed with query parameters:

```text
?theme=dark
?locale=zh_CN
?importance=medium-high
?importance=all
?countries=us,hk,cn
```

Example:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/?theme=dark&locale=en&importance=high&countries=us
```

## Data boundary

This page is a display-only reference layer. TradingView supplies and updates the
widget data. The page does not scrape the widget, persist events, provide an API,
or write data into Notion or the investment workbench. Events used for governed
investment decisions should still be verified against their original official
sources and recorded in the governed event calendar.

TradingView's widget terms and attribution requirements continue to apply.

## US & HK earnings dashboard

The earnings route uses a date-grouped financial table rather than a month grid:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/earnings/?compact=1
```

It is designed to show EPS and revenue actual/forecast values, market cap,
release timing, and a user-owned forecast without exposing holdings or account
data. The committed production feed is intentionally empty until reviewed data
with publication rights is supplied. A synthetic visual preview is available at:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/earnings/?demo=1&compact=1
```

`yfinance` is supported only as a local personal-research staging source. The
collector refuses to write Yahoo-derived data into the public Pages directory.
See [`earnings/README.md`](earnings/README.md) for the data flow and field rules.

## Private company news

`scripts/fetch_company_news.py` builds a metadata-only US/HK news queue under
`.private/`. Moomoo Search News is the discovery layer and every result is
filtered against the exact watched `related_securities`. An optional SEC
submissions source adds official US filing metadata when a compliant
`SEC_USER_AGENT` is configured. All records remain `UNVERIFIED`, no article body
is stored, and the collector itself performs no Notion write.

The separate `scripts/sync_notion_company_news.mjs` command can project that
private snapshot into the configured Company News database and maintain a
compact native Notion `Top Stories` dashboard callout. Each displayed headline
is a direct external link; the private data is never added to GitHub Pages.

The `/news/` route is a generic TradingView Top Stories shell with switchable
pool and company controls. A private Notion watchlist data source controls the
membership; the local sync encodes it in the embed URL fragment, so holdings and
watchlist membership are not committed to the public Pages repository.
TradingView Top Stories is a curated per-symbol feed, not a guaranteed real-time
news API, and some Hong Kong symbols may have no stories.

See [`company-news/README.md`](company-news/README.md) for setup, dry-run,
fail-closed snapshot behavior, the SEC option, and the JSON Schema.
