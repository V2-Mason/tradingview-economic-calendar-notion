import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateRoot = path.join(root, ".private");
const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const marketTimezones = {
  US: "America/New_York",
  HK: "Asia/Hong_Kong",
};

function parseArguments(argv) {
  const options = {
    watchlist: path.join(privateRoot, "watchlist.json"),
    output: path.join(privateRoot, "yahoo-earnings-staging.json"),
    daysBack: 30,
    daysForward: 120,
    requestDelayMs: 250,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--watchlist", "--output", "--days-back", "--days-forward", "--request-delay-ms"].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    if (value === undefined) throw new Error(`${name} requires a value`);
    index += 1;
    if (name === "--watchlist") options.watchlist = resolvePrivatePath(value, name);
    if (name === "--output") options.output = resolvePrivatePath(value, name);
    if (name === "--days-back") options.daysBack = integerArgument(name, value, 0);
    if (name === "--days-forward") options.daysForward = integerArgument(name, value, 1);
    if (name === "--request-delay-ms") options.requestDelayMs = integerArgument(name, value, 0);
  }

  options.watchlist = resolvePrivatePath(options.watchlist, "--watchlist");
  options.output = resolvePrivatePath(options.output, "--output");
  return options;
}

function integerArgument(name, value, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function resolvePrivatePath(value, label) {
  const resolved = path.resolve(root, value);
  if (resolved !== privateRoot && !resolved.startsWith(`${privateRoot}${path.sep}`)) {
    throw new Error(`${label} must stay under ${privateRoot}`);
  }
  return resolved;
}

function raw(value) {
  if (value === null || value === undefined) return null;
  const candidate = typeof value === "object" && "raw" in value ? value.raw : value;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveRaw(value) {
  const candidate = raw(value);
  return candidate !== null && candidate > 0 ? candidate : null;
}

function text(value) {
  if (value === null || value === undefined) return null;
  const candidate = typeof value === "object" && "fmt" in value ? value.fmt : value;
  const normalized = String(candidate).trim();
  return normalized || null;
}

function zonedIso(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const offset = (parts.timeZoneName || "GMT+00:00").replace("GMT", "") || "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function eventId(market, ticker, timestamp) {
  const digest = createHash("sha256")
    .update(`${market}|${ticker}|${timestamp}`)
    .digest("hex")
    .slice(0, 16);
  return `YQ-${market}-${ticker.replaceAll(".", "-")}-${digest}`;
}

function cookieHeader(response) {
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

async function createYahooSession() {
  const cookieResponse = await fetch("https://fc.yahoo.com", {
    headers: { "user-agent": userAgent },
    redirect: "manual",
  });
  const cookie = cookieHeader(cookieResponse);
  if (!cookie) throw new Error("Yahoo did not return a session cookie");

  const crumbResponse = await fetch(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    { headers: { cookie, "user-agent": userAgent } },
  );
  if (!crumbResponse.ok) {
    throw new Error(`Yahoo crumb request failed with HTTP ${crumbResponse.status}`);
  }
  const crumb = (await crumbResponse.text()).trim();
  if (!crumb || crumb.startsWith("{")) throw new Error("Yahoo returned an invalid crumb");
  return { cookie, crumb };
}

async function fetchQuoteSummary(ticker, session, retry = true) {
  const modules = "calendarEvents,price,financialData,earningsTrend,earningsHistory";
  const url = new URL(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`,
  );
  url.searchParams.set("modules", modules);
  url.searchParams.set("crumb", session.crumb);
  const response = await fetch(url, {
    headers: { cookie: session.cookie, "user-agent": userAgent },
  });
  if (response.status === 401 && retry) {
    const refreshed = await createYahooSession();
    session.cookie = refreshed.cookie;
    session.crumb = refreshed.crumb;
    return fetchQuoteSummary(ticker, session, false);
  }
  if (!response.ok) throw new Error(`quoteSummary returned HTTP ${response.status}`);
  const payload = await response.json();
  const apiError = payload?.quoteSummary?.error;
  if (apiError) throw new Error(`${apiError.code}: ${apiError.description}`);
  const result = payload?.quoteSummary?.result?.[0];
  if (!result) throw new Error("quoteSummary returned no result");
  return result;
}

function trendForCurrentQuarter(result) {
  return result?.earningsTrend?.trend?.find((row) => row?.period === "0q") ?? null;
}

function buildEvent(item, result, collectedAt) {
  const earnings = result?.calendarEvents?.earnings;
  const timestamp = raw(earnings?.earningsDate?.[0]);
  if (timestamp === null) return null;
  const eventTime = new Date(timestamp * 1000);
  if (!Number.isFinite(eventTime.getTime())) return null;

  const originalTimezone = marketTimezones[item.market];
  const price = result?.price ?? {};
  const trend = trendForCurrentQuarter(result);
  const marketCurrency = text(price.currency) || (item.market === "HK" ? "HKD" : "USD");
  const metricCurrency = text(result?.financialData?.financialCurrency) || "XXX";
  const company = item.companyName || text(price.longName) || text(price.shortName) || item.ticker;
  const scheduledAt = zonedIso(eventTime, originalTimezone);
  const epsConsensus = raw(earnings?.earningsAverage) ?? raw(trend?.earningsEstimate?.avg);
  const revenueConsensus =
    positiveRaw(earnings?.revenueAverage) ?? positiveRaw(trend?.revenueEstimate?.avg);

  return {
    id: eventId(item.market, item.ticker, scheduledAt),
    market: item.market,
    ticker: item.ticker,
    issuerKey: item.issuerKey ?? null,
    scopeTags: item.scopeTags ?? [],
    company,
    eventName: `${company} earnings announcement`,
    fiscalPeriod: text(trend?.endDate),
    scheduledAt,
    originalTimezone,
    dateOnly: true,
    timeStatus: "ESTIMATED",
    yahooDateEstimateFlag: earnings?.isEarningsDateEstimate ?? null,
    session: "UNKNOWN",
    releaseState:
      eventTime.getTime() < collectedAt.getTime()
        ? "REPORTED_BY_SECONDARY_SOURCE"
        : "UPCOMING",
    times: {
      utc: eventTime.toISOString(),
      newYork: zonedIso(eventTime, "America/New_York"),
      hongKong: zonedIso(eventTime, "Asia/Hong_Kong"),
    },
    eps: {
      actual: null,
      consensus: epsConsensus,
      ownForecast: raw(item.ownForecast?.eps),
      currency: metricCurrency,
      surprisePercent: null,
    },
    revenue: {
      actual: null,
      consensus: revenueConsensus,
      ownForecast: raw(item.ownForecast?.revenue),
      currency: metricCurrency,
    },
    marketCap: {
      value: positiveRaw(price.marketCap),
      currency: marketCurrency,
      asOf: collectedAt.toISOString(),
    },
    sources: [
      {
        name: "Yahoo Finance quoteSummary",
        kind: "UNVERIFIED_SECONDARY",
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(item.ticker)}/calendar/`,
        fetchedAt: collectedAt.toISOString(),
      },
    ],
    dataStatus: "UNVERIFIED_SECONDARY",
    redistributionStatus: "PERSONAL_USE_ONLY",
    publicReleaseApproved: false,
  };
}

function validateWatchlist(document) {
  if (!Array.isArray(document?.tickers) || document.tickers.length === 0) {
    throw new Error("watchlist must contain a non-empty tickers array");
  }
  document.tickers.forEach((item, index) => {
    if (!item || typeof item.ticker !== "string" || !item.ticker.trim()) {
      throw new Error(`watchlist tickers[${index}] requires ticker`);
    }
    item.market = String(item.market || "").toUpperCase();
    if (!marketTimezones[item.market]) {
      throw new Error(`watchlist tickers[${index}] market must be US or HK`);
    }
  });
  return document.tickers;
}

async function atomicWriteJson(outputPath, document) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

const options = parseArguments(process.argv.slice(2));
const watchlist = JSON.parse(await readFile(options.watchlist, "utf8"));
const tickers = validateWatchlist(watchlist);
const collectedAt = new Date();
const windowStart = new Date(collectedAt.getTime() - options.daysBack * 86_400_000);
const windowEnd = new Date(collectedAt.getTime() + options.daysForward * 86_400_000);
const session = await createYahooSession();
const events = [];
const collectionErrors = [];
const tickersWithoutEvent = [];

for (const item of tickers) {
  try {
    const result = await fetchQuoteSummary(item.ticker, session);
    const event = buildEvent(item, result, collectedAt);
    if (!event) {
      tickersWithoutEvent.push(item.ticker);
    } else {
      const eventUtc = new Date(event.times.utc);
      if (eventUtc >= windowStart && eventUtc <= windowEnd) events.push(event);
      else tickersWithoutEvent.push(item.ticker);
    }
  } catch (error) {
    collectionErrors.push({
      ticker: item.ticker,
      market: item.market,
      stage: "quoteSummary",
      errorType: error?.constructor?.name || "Error",
      message: String(error?.message || error).slice(0, 300),
    });
  }
  if (options.requestDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.requestDelayMs));
  }
}

if (collectionErrors.length === tickers.length) {
  throw new Error("Every Yahoo quoteSummary request failed; existing snapshot preserved");
}

events.sort((left, right) => left.times.utc.localeCompare(right.times.utc));
const document = {
  schemaVersion: "1.0.0",
  generatedAt: collectedAt.toISOString(),
  dataPolicy: "YAHOO_PERSONAL_STAGING_ONLY",
  collector: "YAHOO_QUOTE_SUMMARY_ZERO_DEPENDENCY",
  watchlistBasis: "private exact US/HK ticker list",
  window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
  coverage: {
    tickersRequested: tickers.length,
    tickersWithEvent: events.length,
    tickersWithoutEvent: tickersWithoutEvent.length,
    fetchFailures: collectionErrors.length,
  },
  events,
  tickersWithoutEvent,
  collectionErrors,
  limitations: [
    "Yahoo Finance is an unverified secondary source and the response is personal-use staging only.",
    "Event occurrence is never inferred from price action.",
    "Yahoo quoteSummary supplies a date estimate but not a trustworthy BMO/AMC session for every ticker.",
    "EPS and revenue actuals are not imported because they are not safely aligned to this upcoming event.",
    "Issuer IR, SEC, or HKEX must verify the date, original timezone, and released values before governed import or public display.",
  ],
};

await atomicWriteJson(options.output, document);
console.log(JSON.stringify({ output: options.output, ...document.coverage }));
