import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

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

const sensitivePatterns = [
  /PRIMARY_CASH/,
  /account[_ -]?id/i,
  /trading[_ -]?password/i,
  /api[_ -]?key/i,
];

const sensitiveMatches = sensitivePatterns.filter((pattern) => pattern.test(html));
if (sensitiveMatches.length > 0) {
  console.error("Validation failed: possible sensitive project data found in index.html");
  process.exit(1);
}

const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
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
  `Validated ${checks.length} required properties and ${inlineScripts.length} inline script; no sensitive markers found.`,
);
