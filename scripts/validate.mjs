import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const parseJson = async (path) => JSON.parse(await read(path));

const [
  rootHtml,
  newsHtml,
  newsCss,
  newsJs,
  earningsHtml,
  earningsCss,
  earningsJs,
  publicFeed,
  demoFeed,
  publicSchema,
  watchlistExample,
  yfinanceScript,
  moomooScript,
  yahooQuoteSummaryScript,
  privateBuildScript,
  privateUpdaterScript,
  windowsTaskInstaller,
  companyNewsScript,
  dashboardNewsFeedLib,
  newsWidgetConfigLib,
  newsWidgetSyncScript,
  companyNewsSchema,
  companyNewsReadme,
  gitignore,
] = await Promise.all([
  read("index.html"),
  read("news/index.html"),
  read("news/styles.css"),
  read("news/app.js"),
  read("earnings/index.html"),
  read("earnings/styles.css"),
  read("earnings/app.js"),
  parseJson("earnings/data/events.json"),
  parseJson("earnings/data/events.demo.json"),
  parseJson("earnings/public-feed.schema.json"),
  parseJson("config/watchlist.example.json"),
  read("scripts/fetch_yfinance_earnings.py"),
  read("scripts/fetch_moomoo_earnings.py"),
  read("scripts/fetch_yahoo_quote_summary.mjs"),
  read("scripts/build_notion_earnings.mjs"),
  read("scripts/update_private_earnings.ps1"),
  read("scripts/install_windows_task.ps1"),
  read("scripts/fetch_company_news.py"),
  read("scripts/notion_dashboard_news_feed_lib.mjs"),
  read("scripts/news_widget_config_lib.mjs"),
  read("scripts/sync_notion_news_widget.mjs"),
  parseJson("company-news/staging.schema.json"),
  read("company-news/README.md"),
  read(".gitignore"),
]);

const rootChecks = [
  ["root HTML document", /<!doctype html>/i],
  ["responsive root viewport", /name="viewport"/i],
  [
    "official TradingView widget loader",
    /https:\/\/s3\.tradingview\.com\/external-embedding\/embed-widget-events\.js/,
  ],
  ["US root default filter", /params\.get\("countries"\) \|\| "us"/],
  ["high-importance root default", /params\.get\("importance"\) \|\| "high"/],
  ["TradingView root attribution", /Economic Calendar<\/span><\/a>/],
  ["root noindex metadata", /name="robots" content="noindex, nofollow"/],
];

const earningsChecks = [
  ["earnings HTML document", /<!doctype html>/i],
  ["earnings noindex metadata", /name="robots" content="noindex, nofollow"/],
  ["self-hosted earnings app", /<script src="app\.js" defer><\/script>/],
  ["self-hosted earnings styles", /<link rel="stylesheet" href="styles\.css"/],
  ["strict earnings CSP", /Content-Security-Policy/],
  ["date range tabs", /data-range="next-week"/],
  ["Moomoo source tab", /data-source="moomoo"/],
  ["Yahoo source tab", /data-source="yahoo"/],
  ["no Bloomberg source tab", /^(?![\s\S]*data-source="bloomberg")[\s\S]*$/],
  ["US and HK filters", /name="market" value="US"[\s\S]*name="market" value="HK"/],
  ["EPS Actual and Forecast columns", /EPS[\s\S]*Actual[\s\S]*Forecast/],
  ["Revenue Actual and Forecast columns", /Revenue[\s\S]*Actual[\s\S]*Forecast/],
  ["market cap column", /Market Cap/],
  ["no FullCalendar dependency", /^(?![\s\S]*FullCalendar)[\s\S]*$/i],
  ["no external earnings script", /^(?![\s\S]*<script[^>]+https?:\/\/)[\s\S]*$/i],
  ["explicit dialog close button", /id="dialog-close"/],
];

const appChecks = [
  ["production/demo feed selection", /demoMode \? "data\/events\.demo\.json" : "data\/events\.json"/],
  ["two-source contract", /new Set\(\["moomoo", "yahoo"\]\)/],
  ["fresh/partial/no-data source contract", /new Set\(\["READY", "PARTIAL", "NO_DATA"\]\)/],
  ["stale source label", /STALE: "已过期"/],
  ["source selection", /function selectSource\(source\)/],
  ["embedded private source catalog", /window\.__EARNINGS_SOURCE_CATALOG__/],
  ["explicit dialog close", /dialogClose\.addEventListener\("click", \(\) => elements\.dialog\.close\(\)\)/],
  ["New York timezone", /America\/New_York/],
  ["Hong Kong timezone", /Asia\/Hong_Kong/],
  ["date-only conversion fail closed", /REVIEW_REQUIRED · 无法精确换算/],
  ["safe DOM text rendering", /\.textContent\s*=/],
  ["no dynamic innerHTML", /^(?![\s\S]*\.innerHTML\s*=)[\s\S]*$/],
  ["price-action inference warning", /不根据价格行为反推/],
];

const stagingChecks = [
  ["imports yfinance", /import yfinance as yf/],
  ["shared Yahoo output filename", /DEFAULT_OUTPUT = ROOT \/ "\.private" \/ "yahoo-earnings-staging\.json"/],
  ["ticker-scoped earnings calendar", /ticker\.get_calendar/],
  ["ambiguous HTML ownership guard", /cannot safely prove row ownership/],
  ["ticker revenue estimate", /get_revenue_estimate/],
  ["private staging policy", /YFINANCE_PERSONAL_STAGING_ONLY/],
  ["personal-use marker", /PERSONAL_USE_ONLY/],
  ["public output refusal", /Refusing to write Yahoo-derived personal-use data/],
  ["UTC materialization", /"utc": iso_z\(local\)/],
  ["New York materialization", /ZoneInfo\("America\/New_York"\)/],
  ["Hong Kong materialization", /ZoneInfo\("Asia\/Hong_Kong"\)/],
];

const moomooChecks = [
  ["read-only quote context", /OpenQuoteContext/],
  ["earnings calendar endpoint", /get_earnings_calendar/],
  ["loopback-only OpenD", /args\.host != "127\.0\.0\.1"/],
  ["private Moomoo staging policy", /MOOMOO_PERSONAL_STAGING_ONLY/],
  ["no trade context", /^(?![\s\S]*OpenTradeContext)[\s\S]*$/],
  ["no trade unlock", /^(?![\s\S]*unlock_trade)[\s\S]*$/],
  ["Moomoo UTC materialization", /"utc": instant\.isoformat/],
  ["Moomoo New York materialization", /zoned_iso\(instant, "America\/New_York"\)/],
  ["Moomoo Hong Kong materialization", /zoned_iso\(instant, "Asia\/Hong_Kong"\)/],
];

const newsChecks = [
  ["news HTML document", /<!doctype html>/i],
  ["news responsive viewport", /name="viewport"/i],
  ["news noindex metadata", /name="robots" content="noindex, nofollow"/],
  ["self-hosted news app", /<script src="app\.js" defer><\/script>/],
  ["self-hosted news styles", /<link rel="stylesheet" href="styles\.css"/],
  ["news pool navigation", /id="pool-tabs"/],
  ["news company selector", /id="company-select"/],
];

const newsAppChecks = [
  ["official TradingView timeline loader", /https:\/\/s3\.tradingview\.com\/external-embedding\/embed-widget-timeline\.js/],
  ["single-symbol news mode", /feedMode: "symbol"/],
  ["private encoded fragment configuration", /parseEncodedConfig\(params\.get\("config"\)\)/],
  ["bounded pool list", /const MAX_POOLS = 8/],
  ["bounded symbols per pool", /const MAX_SYMBOLS_PER_POOL = 40/],
  ["pool switch", /function selectPool\(poolId, preferredSymbol\)/],
  ["selection persistence", /history\.replaceState/],
  ["dark widget theme", /colorTheme: "dark"/],
  ["safe DOM rendering", /\.textContent\s*=/],
  ["no dynamic innerHTML", /^(?![\s\S]*\.innerHTML\s*=)[\s\S]*$/],
  ["no committed exchange symbols", /^(?![\s\S]*(?:NASDAQ:|NYSE:|HKEX:))[\s\S]*$/],
];

const newsWidgetConfigChecks = [
  ["minimal Notion watchlist schema", /NEWS_WATCHLIST_EXPECTED_SCHEMA/],
  ["active-row filter", /readCheckbox\(properties\.Active\)/],
  ["arbitrary multi-select pools", /readMultiSelect\(properties\.Pools\)/],
  ["watchlist fragment encoding", /\.toString\("base64url"\)/],
  ["HTTPS-only public widget", /news widget baseUrl must use HTTPS/],
  ["no committed exchange symbols", /^(?![\s\S]*(?:NASDAQ:|NYSE:|HKEX:))[\s\S]*$/],
];

const newsWidgetSyncChecks = [
  ["private config enforcement", /enforcePrivateConfiguration/],
  ["Notion watchlist query", /queryAllPages/],
  ["existing embed validation", /must reference an active Notion embed block/],
  ["idempotent URL comparison", /widgetUrlMatches/],
  ["explicit apply switch", /argument === "--apply"/],
  ["no broker writes", /brokerWrites: false/],
];

const yahooQuoteSummaryChecks = [
  ["Yahoo private output default", /yahoo-earnings-staging\.json/],
  ["Yahoo private path boundary", /must stay under/],
  ["Yahoo personal staging policy", /YAHOO_PERSONAL_STAGING_ONLY/],
  ["Yahoo unverified source marker", /UNVERIFIED_SECONDARY/],
  ["Yahoo personal-use marker", /PERSONAL_USE_ONLY/],
  ["Yahoo all-fail preservation gate", /Every Yahoo quoteSummary request failed; existing snapshot preserved/],
  ["Yahoo atomic rename", /rename\(temporary, outputPath\)/],
  ["Yahoo configurable candidate output", /name === "--output"/],
];

const privateBuildChecks = [
  ["private build output default", /notion-earnings-calendar\.html/],
  ["private build path boundary", /must stay under/],
  ["private build freshness option", /--max-age-minutes/],
  ["private build stale state", /status: "STALE"/],
  ["private build partial state", /status: "PARTIAL"/],
  ["private build embedded catalog", /window\.__EARNINGS_SOURCE_CATALOG__/],
  ["private build offline CSP", /connect-src 'none'/],
  ["private build external-dependency guard", /external script or stylesheet dependency/],
  ["private build atomic rename", /rename\(temporary, outputPath\)/],
];

const privateUpdaterChecks = [
  ["PowerShell 5.1 updater", /#requires -Version 5\.1/],
  ["named updater mutex", /System\.Threading\.Mutex/],
  ["OpenD endpoint preflight", /function Test-OpenDEndpoint/],
  ["snapshot freshness gate", /function Get-StagingState[\s\S]*FreshnessMinutes/],
  ["candidate-based collection", /\.candidate\.json/],
  ["atomic candidate promotion", /System\.IO\.File\]::Replace/],
  ["temporary HTML validation", /function Test-HtmlCandidate/],
  ["private logging", /\.private[\s\S]*logs|PrivateRoot[\s\S]*"logs"/],
  ["dry-run no-write boundary", /DRY RUN: no network request, file write/],
  ["explicit Notion publish switch", /\[switch\]\$PublishNotion/],
  ["Notion earnings sync hook", /sync_notion_earnings\.mjs/],
  ["Notion company-news sync hook", /sync_notion_company_news\.mjs/],
  ["Notion news-widget sync hook", /sync_notion_news_widget\.mjs/],
  ["updater never registers a task", /^(?![\s\S]*Register-ScheduledTask)[\s\S]*$/],
];

const windowsTaskChecks = [
  ["PowerShell 5.1 task installer", /#requires -Version 5\.1/],
  ["fixed journal task name", /Trader Master Journal Market Intelligence Sync/],
  ["current-user interactive token", /<LogonType>InteractiveToken<\/LogonType>/],
  ["at-logon trigger", /<LogonTrigger>/],
  ["two-hour trigger", /<Interval>PT2H<\/Interval>/],
  ["ignore overlapping runs", /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/],
  ["start when available", /<StartWhenAvailable>true<\/StartWhenAvailable>/],
  ["explicit Notion action", /update_private_earnings\.ps1[\s\S]*-PublishNotion/],
  ["uninstall support", /\[switch\]\$Uninstall/],
  ["WhatIf support", /SupportsShouldProcess\s*=\s*\$true/],
  ["no credential parameter", /^(?![\s\S]*(?:Password|PSCredential))[\s\S]*$/i],
];

const companyNewsChecks = [
  ["Moomoo Search News endpoint", /get_search_news\(/],
  ["exact related-security filter", /if watched_security not in related:/],
  ["Moomoo rate-limit spacing", /MOOMOO_REQUEST_SPACING_SECONDS = 3\.1/],
  ["five-row retained default", /"--max-count"[\s\S]*?default=5/],
  ["full provider candidate window", /"--search-max-count"[\s\S]*?default=100/],
  ["per-ticker retained cap", /if retained_for_ticker >= max_count:/],
  ["zero-match fail closed", /Moomoo returned no exact related_securities match/],
  ["all records unverified", /"verificationStatus": "UNVERIFIED"/],
  ["raw partial publication date", /"publishedAtRaw": published_at_raw/],
  ["no inferred Moomoo publication instant", /"publishedAt": None/],
  ["metadata-only body guard", /\{"body", "content", "fullText", "articleText"\}/],
  ["official SEC ticker map", /https:\/\/www\.sec\.gov\/files\/company_tickers\.json/],
  ["official SEC submissions API", /https:\/\/data\.sec\.gov\/submissions\/CIK\{cik\}\.json/],
  ["declared SEC user agent", /SEC_USER_AGENT/],
  ["atomic snapshot replacement", /os\.replace\(temporary_path, path\)/],
  ["dry-run write guard", /if not args\.dry_run:/],
  ["private output boundary", /Company-news staging output must remain under \.private\//],
  ["loopback-only OpenD", /host != "127\.0\.0\.1"/],
  ["no trade context", /^(?![\s\S]*OpenTradeContext)[\s\S]*$/],
  ["no trade unlock", /^(?![\s\S]*unlock_trade)[\s\S]*$/],
];

const dashboardNewsFeedChecks = [
  ["one dashboard row per ticker", /seenTickers/],
  ["balanced US and HK selection", /for \(const market of \["US", "HK"\]\)/],
  ["direct headline source link", /textItem\(clip\(item\.headline, 180\), \{ link: item\.url \}\)/],
  ["complete-news database link", /fullNewsUrl/],
  ["discovery remains unverified", /Moomoo \u53d1\u73b0\u5c42 \/ \u5f85\u6838\u9a8c/],
  ["no article body projection", /^(?![\s\S]*(?:articleBody|fullText))[\s\S]*$/],
];

if (/get_earnings_dates\s*\(/.test(yfinanceScript)) {
  fail("yfinance staging must not consume the ambiguous Yahoo earnings HTML table");
}

for (const [group, source, checks] of [
  ["root", rootHtml, rootChecks],
  ["news", newsHtml, newsChecks],
  ["news app", newsJs, newsAppChecks],
  ["news widget config", newsWidgetConfigLib, newsWidgetConfigChecks],
  ["news widget sync", newsWidgetSyncScript, newsWidgetSyncChecks],
  ["earnings", earningsHtml, earningsChecks],
  ["earnings app", earningsJs, appChecks],
  ["yfinance staging", yfinanceScript, stagingChecks],
  ["Moomoo staging", moomooScript, moomooChecks],
  ["Yahoo quoteSummary staging", yahooQuoteSummaryScript, yahooQuoteSummaryChecks],
  ["private earnings build", privateBuildScript, privateBuildChecks],
  ["private update orchestrator", privateUpdaterScript, privateUpdaterChecks],
  ["Windows task installer", windowsTaskInstaller, windowsTaskChecks],
  ["company-news staging", companyNewsScript, companyNewsChecks],
  ["Notion dashboard news feed", dashboardNewsFeedLib, dashboardNewsFeedChecks],
]) {
  const failures = checks
    .filter(([, pattern]) => !pattern.test(source))
    .map(([name]) => name);
  if (failures.length) {
    fail(`${group}: ${failures.join(", ")}`);
  }
}

try {
  Function(earningsJs);
} catch (error) {
  fail(`invalid earnings JavaScript: ${error.message}`);
}
try {
  Function(newsJs);
} catch (error) {
  fail(`invalid news JavaScript: ${error.message}`);
}

if (publicSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
  fail("public feed schema must use JSON Schema 2020-12");
}
if (companyNewsSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
  fail("company-news schema must use JSON Schema 2020-12");
}
if (
  companyNewsSchema.properties?.dataPolicy?.const !== "PRIVATE_PERSONAL_STAGING_ONLY" ||
  companyNewsSchema.$defs?.newsRecord?.properties?.verificationStatus?.const !== "UNVERIFIED" ||
  companyNewsSchema.$defs?.newsRecord?.additionalProperties !== false
) {
  fail("company-news schema must enforce private, UNVERIFIED, metadata-only records");
}
if (
  ["body", "content", "fullText", "articleText"].some(
    (field) => field in (companyNewsSchema.$defs?.newsRecord?.properties || {}),
  )
) {
  fail("company-news schema must not define article body fields");
}
if (
  !/HKEXnews is not scraped/.test(companyNewsReadme) ||
  !/--dry-run/.test(companyNewsReadme) ||
  !/publishedAtRaw/.test(companyNewsReadme)
) {
  fail("company-news documentation must explain the HKEX and dry-run boundaries");
}

validateFeed(publicFeed, { demo: false });
validateFeed(demoFeed, { demo: true });

if (publicFeed.dataPolicy !== "PUBLIC_REVIEWED_ONLY") {
  fail("production feed must use PUBLIC_REVIEWED_ONLY");
}
if (demoFeed.dataPolicy !== "SYNTHETIC_DEMO_ONLY" || demoFeed.events.length < 4) {
  fail("demo feed must contain at least four synthetic events");
}

for (const event of publicFeed.events) {
  if (event.dataStatus !== "PUBLIC_REVIEWED" || event.publicReleaseApproved !== true) {
    fail(`production event ${event.id} is not public-reviewed and approved`);
  }
  if (["PERSONAL_USE_ONLY", "SYNTHETIC"].includes(event.redistributionStatus)) {
    fail(`production event ${event.id} lacks publication rights`);
  }
  if (
    event.sources.some((source) =>
      /yahoo|yfinance|unverified_secondary/i.test(`${source.name} ${source.kind}`),
    )
  ) {
    fail(`production event ${event.id} contains an unpublishable Yahoo source`);
  }
}

for (const event of demoFeed.events) {
  if (
    event.dataStatus !== "SYNTHETIC" ||
    event.redistributionStatus !== "SYNTHETIC" ||
    event.publicReleaseApproved !== false
  ) {
    fail(`demo event ${event.id} must remain synthetic and unapproved`);
  }
}

if (
  !Array.isArray(watchlistExample.tickers) ||
  !watchlistExample.tickers.some((item) => item.market === "US") ||
  !watchlistExample.tickers.some((item) => item.market === "HK")
) {
  fail("watchlist example must demonstrate both US and HK tickers");
}

if (!/^\.private\/$/m.test(gitignore)) {
  fail(".private/ must remain ignored by git");
}

const publicFiles = [
  rootHtml,
  earningsHtml,
  earningsCss,
  earningsJs,
  JSON.stringify(publicFeed),
  JSON.stringify(demoFeed),
].join("\n");
const sensitivePatterns = [
  /PRIMARY_CASH/,
  /account[_ -]?id/i,
  /trading[_ -]?password/i,
  /api[_ -]?key/i,
  /position[_ -]?(?:size|cost)/i,
];
if (sensitivePatterns.some((pattern) => pattern.test(publicFiles))) {
  fail("possible sensitive investment-workbench data found in public files");
}

console.log(
  `Validated ${rootChecks.length + newsChecks.length + newsAppChecks.length + newsWidgetConfigChecks.length + newsWidgetSyncChecks.length + earningsChecks.length + appChecks.length + stagingChecks.length + moomooChecks.length + yahooQuoteSummaryChecks.length + privateBuildChecks.length + privateUpdaterChecks.length + windowsTaskChecks.length + companyNewsChecks.length + dashboardNewsFeedChecks.length} static checks, ` +
    `${publicFeed.events.length} production events, ${demoFeed.events.length} synthetic events, ` +
    "and the public/private data boundary.",
);

function validateFeed(feed, { demo }) {
  if (!feed || feed.schemaVersion !== "1.0.0" || !Array.isArray(feed.events)) {
    fail(`${demo ? "demo" : "production"} feed has an invalid envelope`);
  }
  for (const event of feed.events) {
    for (const field of [
      "id",
      "market",
      "ticker",
      "company",
      "eventName",
      "scheduledAt",
      "originalTimezone",
      "timeStatus",
      "session",
      "releaseState",
      "eps",
      "revenue",
      "marketCap",
      "sources",
      "dataStatus",
      "redistributionStatus",
      "publicReleaseApproved",
    ]) {
      if (!(field in event)) {
        fail(`${demo ? "demo" : "production"} event ${event.id || "?"} lacks ${field}`);
      }
    }
    if (!["US", "HK"].includes(event.market)) {
      fail(`event ${event.id} has unsupported market ${event.market}`);
    }
    if (!["America/New_York", "Asia/Hong_Kong"].includes(event.originalTimezone)) {
      fail(`event ${event.id} has unsupported original timezone`);
    }
    if (!event.times?.utc || !event.times?.newYork || !event.times?.hongKong) {
      fail(`event ${event.id} lacks UTC/NY/HK materialized times`);
    }
    if (!Array.isArray(event.sources) || event.sources.length === 0) {
      fail(`event ${event.id} lacks sources`);
    }
    for (const metricName of ["eps", "revenue"]) {
      const metric = event[metricName];
      for (const field of ["actual", "consensus", "ownForecast", "currency"]) {
        if (!(field in metric)) {
          fail(`event ${event.id} ${metricName} lacks ${field}`);
        }
      }
      for (const field of ["actual", "consensus", "ownForecast"]) {
        const value = metric[field];
        if (value !== null && !Number.isFinite(value)) {
          fail(`event ${event.id} ${metricName}.${field} must be finite or null`);
        }
      }
    }
  }
}

function fail(message) {
  console.error(`Validation failed: ${message}`);
  process.exit(1);
}
