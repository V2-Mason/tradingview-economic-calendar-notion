import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const parseJson = async (path) => JSON.parse(await read(path));

const [
  rootHtml,
  earningsHtml,
  earningsCss,
  earningsJs,
  publicFeed,
  demoFeed,
  publicSchema,
  watchlistExample,
  yfinanceScript,
  gitignore,
] = await Promise.all([
  read("index.html"),
  read("earnings/index.html"),
  read("earnings/styles.css"),
  read("earnings/app.js"),
  parseJson("earnings/data/events.json"),
  parseJson("earnings/data/events.demo.json"),
  parseJson("earnings/public-feed.schema.json"),
  parseJson("config/watchlist.example.json"),
  read("scripts/fetch_yfinance_earnings.py"),
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
  ["US and HK filters", /name="market" value="US"[\s\S]*name="market" value="HK"/],
  ["EPS Actual and Forecast columns", /EPS[\s\S]*Actual[\s\S]*Forecast/],
  ["Revenue Actual and Forecast columns", /Revenue[\s\S]*Actual[\s\S]*Forecast/],
  ["market cap column", /Market Cap/],
  ["no FullCalendar dependency", /^(?![\s\S]*FullCalendar)[\s\S]*$/i],
  ["no external earnings script", /^(?![\s\S]*<script[^>]+https?:\/\/)[\s\S]*$/i],
];

const appChecks = [
  ["production/demo feed selection", /demoMode \? "data\/events\.demo\.json" : "data\/events\.json"/],
  ["New York timezone", /America\/New_York/],
  ["Hong Kong timezone", /Asia\/Hong_Kong/],
  ["safe DOM text rendering", /\.textContent\s*=/],
  ["no dynamic innerHTML", /^(?![\s\S]*\.innerHTML\s*=)[\s\S]*$/],
  ["price-action inference warning", /不根据价格行为反推/],
];

const stagingChecks = [
  ["imports yfinance", /import yfinance as yf/],
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

if (/get_earnings_dates\s*\(/.test(yfinanceScript)) {
  fail("yfinance staging must not consume the ambiguous Yahoo earnings HTML table");
}

for (const [group, source, checks] of [
  ["root", rootHtml, rootChecks],
  ["earnings", earningsHtml, earningsChecks],
  ["earnings app", earningsJs, appChecks],
  ["yfinance staging", yfinanceScript, stagingChecks],
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

if (publicSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
  fail("public feed schema must use JSON Schema 2020-12");
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
  `Validated ${rootChecks.length + earningsChecks.length + appChecks.length + stagingChecks.length} static checks, ` +
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
