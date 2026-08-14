#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSecrets } from "./notion_earnings_sync_lib.mjs";
import {
  buildNewsWidgetUrl,
  buildWidgetPools,
  validateNewsWatchlistSchema,
  widgetUrlMatches,
} from "./news_widget_config_lib.mjs";
import {
  createNtnClient,
  enforcePrivateConfiguration,
  queryAllPages,
} from "./sync_notion_earnings.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Notion news-widget sync failed: ${message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const configPath = resolve(projectRoot, options.configPath);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assertNoSecrets(config);
  validateConfig(config);
  enforcePrivateConfiguration(configPath, config.newsWidget.dataSourceId);

  const ntn = createNtnClient({
    projectRoot,
    packageName: config.notionCliPackage,
  });
  await ntn.whoami();
  const dataSource = await ntn.api(`v1/data_sources/${config.newsWidget.dataSourceId}`);
  validateNewsWatchlistSchema(dataSource);
  const pages = await queryAllPages(ntn, config.newsWidget.dataSourceId);
  const pools = buildWidgetPools(pages);
  const desiredUrl = buildNewsWidgetUrl({
    baseUrl: config.newsWidget.baseUrl,
    pools,
    locale: config.newsWidget.locale,
  });
  const block = await ntn.api(`v1/blocks/${config.newsWidget.embedBlockId}`);
  if (block.type !== "embed" || block.in_trash) {
    throw new Error("newsWidget.embedBlockId must reference an active Notion embed block");
  }
  const updateRequired = !widgetUrlMatches(block.embed?.url, desiredUrl);
  if (options.apply && updateRequired) {
    const updated = await ntn.api(`v1/blocks/${config.newsWidget.embedBlockId}`, {
      method: "PATCH",
      body: { embed: { url: desiredUrl } },
    });
    if (updated.type !== "embed" || !widgetUrlMatches(updated.embed?.url, desiredUrl)) {
      throw new Error("Notion did not confirm the news-widget URL update");
    }
  }

  const report = {
    status: "READY",
    mode: options.apply ? "APPLY" : "DRY_RUN",
    pools: pools.map((pool) => ({ label: pool.label, symbols: pool.symbols.length })),
    activeRows: pages.filter((page) => page.properties?.Active?.checkbox).length,
    updateRequired,
    applied: options.apply && updateRequired,
    urlLength: desiredUrl.length,
    brokerWrites: false,
    tradeAuthority: "NONE",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseArguments(args) {
  const options = {
    apply: false,
    dryRun: false,
    help: false,
    configPath: ".private/notion-sync.json",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--config") {
      if (!args[index + 1]) {
        throw new Error("--config requires a path");
      }
      options.configPath = args[index + 1];
      index += 1;
    } else if (argument !== "--json") {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (options.apply && options.dryRun) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  return options;
}

function validateConfig(config) {
  if (!/^ntn@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(config.notionCliPackage ?? "")) {
    throw new Error("notionCliPackage must pin an ntn version");
  }
  const widget = config.newsWidget;
  if (!widget || typeof widget !== "object") {
    throw new Error("private config must contain newsWidget");
  }
  for (const field of ["dataSourceId", "embedBlockId"]) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(widget[field] ?? "")) {
      throw new Error(`newsWidget.${field} must be a UUID`);
    }
  }
  const baseUrl = new URL(widget.baseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("newsWidget.baseUrl must use HTTPS");
  }
  if (!/^[A-Za-z_]{2,10}$/.test(widget.locale ?? "")) {
    throw new Error("newsWidget.locale is invalid");
  }
}

function helpText() {
  return `Usage: node scripts/sync_notion_news_widget.mjs [options]\n\nOptions:\n  --dry-run          Read Notion and report whether the embed URL needs an update (default).\n  --apply            Update the existing Notion embed URL when pool membership changed.\n  --json             Accepted for consistency; output is always JSON.\n  --config PATH      Private config path (default: .private/notion-sync.json).\n  -h, --help         Show this help.\n`;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
