import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateRoot = path.join(root, ".private");

function parseArguments(argv) {
  const options = {
    moomoo: path.join(privateRoot, "moomoo-earnings-staging.json"),
    yahoo: path.join(privateRoot, "yahoo-earnings-staging.json"),
    output: path.join(privateRoot, "notion-earnings-calendar.html"),
    maxAgeMinutes: 180,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--moomoo", "--yahoo", "--output", "--max-age-minutes"].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    if (value === undefined) throw new Error(`${name} requires a value`);
    index += 1;
    if (name === "--moomoo") options.moomoo = resolvePrivatePath(value, name);
    if (name === "--yahoo") options.yahoo = resolvePrivatePath(value, name);
    if (name === "--output") options.output = resolvePrivatePath(value, name);
    if (name === "--max-age-minutes") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--max-age-minutes must be an integer >= 1");
      }
      options.maxAgeMinutes = parsed;
    }
  }

  options.moomoo = resolvePrivatePath(options.moomoo, "--moomoo");
  options.yahoo = resolvePrivatePath(options.yahoo, "--yahoo");
  options.output = resolvePrivatePath(options.output, "--output");
  return options;
}

function resolvePrivatePath(value, label) {
  const resolved = path.resolve(root, value);
  if (resolved !== privateRoot && !resolved.startsWith(`${privateRoot}${path.sep}`)) {
    throw new Error(`${label} must stay under ${privateRoot}`);
  }
  return resolved;
}

async function readOptionalFeed(filePath, expectedPolicy) {
  try {
    const feed = JSON.parse(await readFile(filePath, "utf8"));
    assertFeed(feed, expectedPolicy, filePath);
    return feed;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertFeed(feed, expectedPolicy, filePath) {
  if (!feed || feed.schemaVersion !== "1.0.0" || !Array.isArray(feed.events)) {
    throw new Error(`${filePath} is not a supported earnings feed`);
  }
  if (feed.dataPolicy !== expectedPolicy) {
    throw new Error(`${filePath} has unexpected dataPolicy ${feed.dataPolicy}`);
  }
  if (!feed.generatedAt || !Number.isFinite(Date.parse(feed.generatedAt))) {
    throw new Error(`${filePath} has an invalid generatedAt`);
  }
  for (const [index, event] of feed.events.entries()) {
    if (
      !event?.id ||
      !["US", "HK"].includes(event.market) ||
      !event.ticker ||
      !event.company ||
      !event.scheduledAt ||
      !Number.isFinite(Date.parse(event.scheduledAt))
    ) {
      throw new Error(`${filePath} events[${index}] lacks required fields`);
    }
  }
}

function emptyFeed(policy) {
  return {
    schemaVersion: "1.0.0",
    generatedAt: null,
    dataPolicy: policy,
    events: [],
  };
}

function feedState(feed, maxAgeMinutes) {
  if (!feed) return { status: "MISSING", ageMinutes: null, errors: 0 };
  const ageMinutes = (Date.now() - Date.parse(feed.generatedAt)) / 60_000;
  const errors = Array.isArray(feed.collectionErrors) ? feed.collectionErrors.length : 0;
  if (!Number.isFinite(ageMinutes) || ageMinutes < -5 || ageMinutes > maxAgeMinutes) {
    return { status: "STALE", ageMinutes, errors };
  }
  if (errors > 0) return { status: "PARTIAL", ageMinutes, errors };
  if (feed.events.length === 0) return { status: "NO_DATA", ageMinutes, errors };
  return { status: "READY", ageMinutes, errors };
}

function ageLabel(ageMinutes) {
  if (!Number.isFinite(ageMinutes)) return "unknown age";
  if (ageMinutes < 0) return "timestamp is in the future";
  if (ageMinutes < 60) return `${Math.round(ageMinutes)} minutes old`;
  return `${(ageMinutes / 60).toFixed(1)} hours old`;
}

function sourceEntry({ label, feed, missingStatus, readyMessage, missingMessage, maxAgeMinutes }) {
  const state = feedState(feed, maxAgeMinutes);
  let message = readyMessage;
  if (state.status === "MISSING") message = missingMessage;
  if (state.status === "STALE") {
    message = `${label} snapshot is stale (${ageLabel(state.ageMinutes)}). The retained data is not current.`;
  }
  if (state.status === "PARTIAL") {
    message = `${readyMessage} ${state.errors} request(s) failed; coverage is partial.`;
  }
  if (state.status === "NO_DATA") {
    message = `${readyMessage} The fresh snapshot contains no events in the requested window.`;
  }
  return {
    label,
    status: state.status === "MISSING" ? missingStatus : state.status,
    message,
    generatedAt: feed?.generatedAt ?? null,
    ageMinutes: Number.isFinite(state.ageMinutes) ? Math.max(0, state.ageMinutes) : null,
    feed: feed || emptyFeed(`${label.toUpperCase()}_PERSONAL_STAGING_ONLY`),
  };
}

function preferredSource(sources) {
  const score = { READY: 4, PARTIAL: 3, NO_DATA: 2, STALE: 1, NOT_CONNECTED: 0 };
  return ["moomoo", "yahoo"].sort(
    (left, right) => (score[sources[right].status] ?? -1) - (score[sources[left].status] ?? -1),
  )[0];
}

function replaceRequired(source, searchValue, replacement, label) {
  if (!source.includes(searchValue)) throw new Error(`HTML build marker not found: ${label}`);
  return source.replace(searchValue, replacement);
}

async function atomicWriteText(outputPath, contents) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

const options = parseArguments(process.argv.slice(2));
const [htmlSource, css, appSource, moomooFeed, yahooFeed] = await Promise.all([
  readFile(path.join(root, "earnings", "index.html"), "utf8"),
  readFile(path.join(root, "earnings", "styles.css"), "utf8"),
  readFile(path.join(root, "earnings", "app.js"), "utf8"),
  readOptionalFeed(options.moomoo, "MOOMOO_PERSONAL_STAGING_ONLY"),
  readOptionalFeed(options.yahoo, "YAHOO_PERSONAL_STAGING_ONLY"),
]);

const sources = {
  moomoo: sourceEntry({
    label: "Moomoo",
    feed: moomooFeed,
    missingStatus: "NOT_CONNECTED",
    readyMessage:
      "Moomoo private read-only snapshot. Release dates and sessions remain provider observations until issuer, SEC, or HKEX confirmation.",
    missingMessage: "Moomoo is not connected. Start local OpenD and run the updater again.",
    maxAgeMinutes: options.maxAgeMinutes,
  }),
  yahoo: sourceEntry({
    label: "Yahoo",
    feed: yahooFeed,
    missingStatus: "NO_DATA",
    readyMessage:
      "Yahoo is an unverified personal-research fallback and is never merged with the Moomoo snapshot.",
    missingMessage: "No private Yahoo snapshot is available.",
    maxAgeMinutes: options.maxAgeMinutes,
  }),
};

const catalog = {
  schemaVersion: "1.0.0",
  generatedAt: new Date().toISOString(),
  freshnessMaxAgeMinutes: options.maxAgeMinutes,
  defaultSource: preferredSource(sources),
  sources,
};

let app = replaceRequired(
  appSource,
  'const demoMode = params.get("demo") === "1";',
  "const demoMode = false;",
  "demo mode",
);
app = replaceRequired(
  app,
  'const compactMode = params.get("compact") === "1";',
  "const compactMode = true;",
  "compact mode",
);

const safeCatalog = JSON.stringify(catalog).replaceAll("<", "\\u003c");
const inlineScripts =
  `<script>window.__EARNINGS_SOURCE_CATALOG__=${safeCatalog};</script>\n` +
  `<script>${app}</script>`;

let html = replaceRequired(
  htmlSource,
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none';",
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none';",
  "content security policy",
);
html = replaceRequired(
  html,
  "<title>US & HK Earnings Calendar</title>",
  "<title>Private US & HK Earnings Calendar</title>",
  "document title",
);
html = replaceRequired(
  html,
  '<link rel="stylesheet" href="styles.css" />',
  `<style>${css}</style>`,
  "stylesheet",
);
html = replaceRequired(
  html,
  '<script src="app.js" defer></script>',
  inlineScripts,
  "application script",
);

if (/<script\b[^>]*\bsrc=/i.test(html) || /<link\b[^>]*rel=["']stylesheet["']/i.test(html)) {
  throw new Error("private build contains an external script or stylesheet dependency");
}
if (!html.includes("window.__EARNINGS_SOURCE_CATALOG__=") || !html.includes("connect-src 'none'")) {
  throw new Error("private build is missing its embedded catalog or offline CSP");
}

await atomicWriteText(options.output, html);
const sha256 = createHash("sha256").update(html).digest("hex");
console.log(
  JSON.stringify({
    output: options.output,
    bytes: Buffer.byteLength(html),
    sha256,
    defaultSource: catalog.defaultSource,
    sources: Object.fromEntries(
      Object.entries(catalog.sources).map(([id, entry]) => [
        id,
        { status: entry.status, events: entry.feed.events.length, generatedAt: entry.generatedAt },
      ]),
    ),
  }),
);
