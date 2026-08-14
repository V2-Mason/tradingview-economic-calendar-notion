import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const earningsHtml = await readFile(
  new URL("../earnings/index.html", import.meta.url),
  "utf8",
);
const earningsEvents = JSON.parse(
  await readFile(new URL("../earnings/events.json", import.meta.url), "utf8"),
);
const demoEvents = JSON.parse(
  await readFile(new URL("../earnings/events.demo.json", import.meta.url), "utf8"),
);

const checks = [
  ["HTML document", /<!doctype html>/i],
  ["responsive viewport", /name="viewport"/i],
  [
    "official TradingView widget loader",
    /https:\/\/s3\.tradingview\.com\/external-embedding\/embed-widget-events\.js/,
  ],
  ["US default filter", /params\.get\("countries"\) \|\| "us"/],
  ["high-importance default", /params\.get\("importance"\) \|\| "high"/],
  ["TradingView attribution", /Economic Calendar<\/span><\/a>/],
  ["noindex metadata", /name="robots" content="noindex, nofollow"/],
];

const failures = checks
  .filter(([, pattern]) => !pattern.test(html))
  .map(([name]) => name);

if (failures.length > 0) {
  console.error(`Validation failed: ${failures.join(", ")}`);
  process.exit(1);
}

const earningsChecks = [
  ["earnings HTML document", /<!doctype html>/i],
  ["FullCalendar Standard bundle", /fullcalendar@7\.0\.2\/all\/global\.js/],
  ["FullCalendar month view", /initialView:\s*"dayGridMonth"/],
  ["FullCalendar list view", /dayGridMonth,listMonth/],
  ["production JSON event source", /demoMode \? "events\.demo\.json" : "events\.json"/],
  ["US and HK filters", /new Set\(\["US", "HK"\]\)/],
  ["confirmed and estimated filters", /new Set\(\["CONFIRMED", "ESTIMATED"\]\)/],
  ["FullCalendar v7 event class hook", /eventClass\(info\)/],
  ["no legacy FullCalendar v6 options", /^(?![\s\S]*(?:eventClassNames|buttonText:))[\s\S]*$/],
  ["no premium scheduler bundle", /^(?![\s\S]*fullcalendar-scheduler)[\s\S]*$/],
  ["earnings noindex metadata", /name="robots" content="noindex, nofollow"/],
];

const earningsFailures = earningsChecks
  .filter(([, pattern]) => !pattern.test(earningsHtml))
  .map(([name]) => name);

if (earningsFailures.length > 0) {
  console.error(`Validation failed: ${earningsFailures.join(", ")}`);
  process.exit(1);
}

if (!Array.isArray(earningsEvents) || !Array.isArray(demoEvents)) {
  console.error("Validation failed: earnings event files must contain arrays");
  process.exit(1);
}

if (earningsEvents.length !== 0) {
  console.error("Validation failed: production earnings feed must remain empty for this shell release");
  process.exit(1);
}

for (const event of demoEvents) {
  const props = event.extendedProps || {};
  if (!event.color || !event.contrastColor) {
    console.error(`Validation failed: demo event ${event.id} lacks FullCalendar v7 colors`);
    process.exit(1);
  }
  if (!["US", "HK"].includes(props.market)) {
    console.error(`Validation failed: unsupported demo market ${props.market}`);
    process.exit(1);
  }
  if (!["CONFIRMED", "ESTIMATED"].includes(props.confidence)) {
    console.error(`Validation failed: unsupported demo confidence ${props.confidence}`);
    process.exit(1);
  }
}

const sensitivePatterns = [
  /PRIMARY_CASH/,
  /account[_ -]?id/i,
  /trading[_ -]?password/i,
  /api[_ -]?key/i,
];

const publicContent = [html, earningsHtml, JSON.stringify(earningsEvents), JSON.stringify(demoEvents)].join("\n");
const sensitiveMatches = sensitivePatterns.filter((pattern) => pattern.test(publicContent));
if (sensitiveMatches.length > 0) {
  console.error("Validation failed: possible sensitive project data found in public files");
  process.exit(1);
}

const inlineScripts = [html, earningsHtml]
  .flatMap((document) => [...document.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)])
  .map((match) => match[1].trim())
  .filter(Boolean);

for (const script of inlineScripts) {
  try {
    Function(script);
  } catch (error) {
    console.error(`Validation failed: invalid inline JavaScript: ${error.message}`);
    process.exit(1);
  }
}

console.log(
  `Validated ${checks.length + earningsChecks.length} required properties, ${demoEvents.length} synthetic earnings events, and ${inlineScripts.length} inline scripts; no sensitive markers found.`,
);
