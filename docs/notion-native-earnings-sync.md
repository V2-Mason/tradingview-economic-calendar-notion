# Private Notion earnings and company-news sync

The native sync projects the two private earnings staging files and the private
company-news staging file into existing Notion data sources. It uses the
official `ntn` CLI and its user keychain; no Notion token belongs in this
repository or in the sync config.

Create the ignored private config once:

```powershell
Copy-Item config/notion-sync.example.json .private/notion-sync.json
```

Put the real data-source ID only in `.private/notion-sync.json`. The checked-in
example must keep its placeholder ID.

Preview an idempotent plan without writing:

```powershell
node scripts/sync_notion_earnings.mjs --dry-run --json
```

Apply the plan after reviewing it:

```powershell
node scripts/sync_notion_earnings.mjs --apply --json
```

Company news has the same dry-run/apply split:

```powershell
node scripts/sync_notion_company_news.mjs --dry-run --json
node scripts/sync_notion_company_news.mjs --apply --json

node scripts/sync_notion_news_widget.mjs --dry-run --json
node scripts/sync_notion_news_widget.mjs --apply --json
```

The exit code is `0` when the query/plan/apply cycle completes. A missing or
invalid or over-age source is reported as `status: SOURCE_STALE`; its existing
rows are marked `Source Status = Stale` and are never deleted. The checked
`generatedAt` age limit defaults to 180 minutes in the example config, so a
collector failure cannot make a retained old staging file Ready again.
Configuration, schema, authentication, API, or write failures return exit code
`1`.

The news-widget sync reads the editable private Notion watchlist database,
builds up to eight pools with up to forty symbols each, and updates only the
existing dashboard embed URL. Pool membership travels in the URL fragment and
is not committed to the public Pages repository. The widget is TradingView's
curated Top Stories feed; it must not be labelled as a complete or real-time
company-news source.

## Projection rules

- `Event Key` is source-specific (`moomoo:<source-id>` or
  `yahoo:<source-id>`) and is the sole upsert key.
- The visible title is only `Ticker | Company`.
- `My EPS Forecast` and `My Revenue Forecast` are never sent in create or
  update requests.
- Missing source values remain null; they are never converted to zero.
- Yahoo date-only events remain date-only. The staging file's placeholder time
  is not promoted to a confirmed event time.
- A source fetch timestamp is stored as `Fetched At`, never relabelled as
  `Source Publication Time`.
- No page is deleted or archived by this sync.

Company-news rules:

- `News Key` is source-specific (`moomoo:<source-id>` or `sec:<source-id>`) and
  is the sole upsert key.
- Moomoo-discovered stories remain `Source = Moomoo`, `Source Tier = Discovery`,
  and `Verification = Unverified`, even if their provider metadata names an
  official source.
- A month/day value without a year or timezone is kept only in `Published Raw`;
  `Published At` remains empty.
- `Material` is user-managed and is never sent by the sync. `Fetched At` is
  create-only; later runs change `Last Seen` only when needed.
- When `companyNews.dashboardFeed` is configured, the same sync also refreshes
  a compact native Notion `Top Stories` callout on the dashboard. It selects one
  story per ticker, alternates US and HK rows, and links each headline directly
  to the source URL. The footer links to the complete Company News database.
- A stale company-news snapshot never clears or rewrites the dashboard feed.
  The existing callout is preserved until a fresh validated snapshot exists.
- The dashboard feed contains metadata and links only. It does not publish or
  copy article bodies, and it remains inside the private Notion workspace.

Run the offline contract tests with:

```powershell
npm run test:notion-sync
```
