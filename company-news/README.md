# Private company-news collector

This collector builds a private metadata-only news queue for the exact US/HK
watchlist. It does not write to Notion and it does not publish any provider data
to GitHub Pages.

## Source roles

- **Moomoo Search News** is the preferred discovery layer for both markets. A
  row is retained only when its normalized `related_securities` contains the
  exact watched security (`US.AAPL` or `HK.00700`). Keyword matches alone never
  pass the filter.
- **SEC submissions** are an optional official US disclosure source. The local
  collector uses the SEC ticker-to-CIK mapping and per-CIK submissions JSON; it
  does not scrape EDGAR HTML.
- **HKEXnews is not scraped.** HKEX does not expose a free official API/RSS for
  listed-company announcements, and its website terms prohibit programmatic
  scraping. Use the free HKEX News Alert manually or a separately licensed IIS
  feed.

Every retained row has `verificationStatus=UNVERIFIED`, including SEC metadata.
The source URL still has to be opened before the item can become governed
evidence. Article, press-release, and filing body text is never stored.

Moomoo Search News currently returns `publish_time` values such as `8/10`
without a year, clock time, or timezone. The collector preserves that exact
value in `publishedAtRaw` and sets `publishedAt` to `null`; it never turns the
partial value into a fabricated date. `fetchedAt` records only when this
collector observed the row and must not be presented as the publication time.

## Watchlist

The default input is `.private/watchlist.json` when present, otherwise
`config/watchlist.example.json`. Each entry needs:

```json
{
  "ticker": "AAPL",
  "market": "US",
  "companyName": "Apple Inc."
}
```

HK tickers use the existing Yahoo-style code such as `0700.HK`. Optional fields:

- `newsSearchKeyword`: overrides the Moomoo keyword while exact security
  filtering still applies;
- `secCik`: overrides the SEC ticker-to-CIK mapping for a US issuer.

## Run

Install the existing Moomoo dependency and keep OpenD on loopback:

```powershell
python -m pip install -r requirements-moomoo.txt
python scripts/fetch_company_news.py --dry-run
python scripts/fetch_company_news.py
```

The normal output is `.private/company-news-staging.json`. The schema is
[`staging.schema.json`](staging.schema.json).

After collection, `scripts/sync_notion_company_news.mjs` can upsert the private
Notion Company News database and, when `companyNews.dashboardFeed` is configured,
refresh a six-item `Top Stories` callout on the journal dashboard. It alternates
US/HK companies, keeps one headline per ticker, and makes the headline itself a
direct link to the source page. A stale snapshot preserves the prior callout.

Moomoo documents a limit of 10 Search News calls per 30 seconds. The collector
therefore uses one keyword call per ticker and spaces calls by 3.1 seconds. It
examines up to 100 provider candidates so that a true ticker match is not hidden
by unrelated keyword results, then retains at most 5 exact-match rows per ticker.
`--max-count` can raise or lower the retained limit; `--search-max-count` changes
the candidate window. An all-watchlist zero-match result fails closed instead of
replacing the previous snapshot.

## Enable SEC

SEC automated requests must declare the application and a real contact email:

```powershell
$env:SEC_USER_AGENT = "Personal Investment Workbench your-real-email@example.com"
python scripts/fetch_company_news.py --sec-mode required --dry-run
python scripts/fetch_company_news.py --sec-mode required
```

With the default `--sec-mode auto`, SEC is collected when `SEC_USER_AGENT` is
present. If it is absent, the snapshot remains usable but records the explicit
`SEC_USER_AGENT_REQUIRED` source gap. `--sec-mode required` fails closed instead.

The default SEC lookback is 30 days and retains material company forms including
8-K, 10-Q, 10-K, 6-K, 20-F, and 40-F plus amendments. Both the ticker mapping and
submissions endpoints are official, keyless SEC JSON APIs.

## Failure and publication boundary

- `--dry-run` performs collection and validation but never touches the output.
- Any failure from an enabled source returns a non-zero exit and leaves the old
  snapshot unchanged.
- A successful run writes a temporary file in `.private/`, flushes it, and uses
  an atomic replace.
- The collector refuses output outside `.private/` and never stores full text.
- Do not commit or serve the staging snapshot. Public GitHub Pages must not
  contain Moomoo data, private watchlists, provider credentials, or API keys.

Official references:

- [Moomoo Search News API](https://openapi.moomoo.com/moomoo-api-doc/en/quote/get-search-news.html)
- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC developer and fair-access guidance](https://www.sec.gov/about/developer-resources)
- [HKEX News Alert](https://www.hkex.com.hk/Global/Exchange/FAQ/Getting-Started/News-Alert?sc_lang=en)
- [HKEX website terms](https://www.hkex.com.hk/global/exchange/terms-of-use?sc_lang=en)
