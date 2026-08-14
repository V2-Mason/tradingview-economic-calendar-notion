#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSecrets } from "./notion_earnings_sync_lib.mjs";
import { validateNewsWatchlistSchema } from "./news_widget_config_lib.mjs";
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
    console.error(`Notion news-watchlist setup failed: ${message}`);
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

  const watchlistPath = resolve(projectRoot, options.watchlistPath);
  const watchlist = JSON.parse(await readFile(watchlistPath, "utf8"));
  const seedRows = buildSeedRows(watchlist);
  const ntn = createNtnClient({
    projectRoot,
    packageName: config.notionCliPackage,
  });
  await ntn.whoami();

  if (options.apply) {
    await repairDatabaseMetadata(ntn, config.newsWidget.databaseId);
    await repairDataSourceMetadata(ntn, config.newsWidget.dataSourceId);
  }

  const dataSource = await ntn.api(`v1/data_sources/${config.newsWidget.dataSourceId}`);
  validateNewsWatchlistSchema(dataSource);
  const existingPages = await queryAllPages(ntn, config.newsWidget.dataSourceId);

  if (options.apply && existingPages.length === 0) {
    for (const row of seedRows) {
      await ntn.api("v1/pages", {
        method: "POST",
        body: {
          parent: {
            type: "data_source_id",
            data_source_id: config.newsWidget.dataSourceId,
          },
          properties: toNotionProperties(row),
        },
      });
    }
  }

  const finalPages = options.apply
    ? await queryAllPages(ntn, config.newsWidget.dataSourceId)
    : existingPages;
  const report = {
    status: "READY",
    mode: options.apply ? "APPLY" : "DRY_RUN",
    existingRows: existingPages.length,
    seedRows: seedRows.length,
    createdRows: options.apply && existingPages.length === 0 ? seedRows.length : 0,
    finalRows: finalPages.length,
    metadataRepaired: options.apply,
    brokerWrites: false,
    tradeAuthority: "NONE",
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export function buildSeedRows(watchlist) {
  if (!Array.isArray(watchlist?.tickers) || watchlist.tickers.length === 0) {
    throw new Error("private watchlist must contain at least one ticker");
  }
  return watchlist.tickers.map((item, index) => {
    const ticker = requiredText(item.ticker, `tickers[${index}].ticker`);
    const company = requiredText(item.companyName, `tickers[${index}].companyName`);
    const tradingViewSymbol = requiredText(
      item.tradingViewSymbol,
      `tickers[${index}].tradingViewSymbol`,
    ).toUpperCase();
    if (!/^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/.test(tradingViewSymbol)) {
      throw new Error(`invalid TradingView symbol for ${ticker}`);
    }
    const market = requiredText(item.market, `tickers[${index}].market`).toUpperCase();
    if (!new Set(["US", "HK"]).has(market)) {
      throw new Error(`unsupported market for ${ticker}: ${market}`);
    }
    const tags = new Set(item.scopeTags ?? []);
    const pools = [];
    if (tags.has("POSITION")) {
      pools.push("最近观察持仓");
    }
    pools.push(`${market} 关注`);
    if (tags.has("WATCHING")) {
      pools.push("研究候选");
    }
    return {
      name: `${ticker} | ${company}`,
      ticker,
      company,
      tradingViewSymbol,
      market,
      pools,
      active: true,
      order: index + 1,
    };
  });
}

async function repairDatabaseMetadata(ntn, databaseId) {
  await ntn.api(`v1/databases/${databaseId}`, {
    method: "PATCH",
    body: {
      title: richTextItems("新闻关注池"),
      description: richTextItems("编辑 Pools、Active 与 Order，即可控制 Notion 新闻组件中的池子、公司和顺序。"),
    },
  });
}

async function repairDataSourceMetadata(ntn, dataSourceId) {
  await ntn.api(`v1/data_sources/${dataSourceId}`, {
    method: "PATCH",
    body: {
      title: richTextItems("新闻关注池"),
      properties: {
        Market: {
          select: {
            options: [
              { name: "US", color: "blue" },
              { name: "HK", color: "red" },
            ],
          },
        },
        Pools: {
          multi_select: {
            options: [
              { name: "最近观察持仓", color: "green" },
              { name: "US 关注", color: "blue" },
              { name: "HK 关注", color: "red" },
              { name: "研究候选", color: "purple" },
            ],
          },
        },
      },
    },
  });
}

function toNotionProperties(row) {
  return {
    Name: { title: richTextItems(row.name) },
    Ticker: { rich_text: richTextItems(row.ticker) },
    Company: { rich_text: richTextItems(row.company) },
    "TradingView Symbol": { rich_text: richTextItems(row.tradingViewSymbol) },
    Market: { select: { name: row.market } },
    Pools: { multi_select: row.pools.map((name) => ({ name })) },
    Active: { checkbox: row.active },
    Order: { number: row.order },
  };
}

function richTextItems(value) {
  return [{ type: "text", text: { content: value } }];
}

function requiredText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function validateConfig(config) {
  if (!/^ntn@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(config.notionCliPackage ?? "")) {
    throw new Error("notionCliPackage must pin an ntn version");
  }
  const widget = config.newsWidget;
  if (!widget || typeof widget !== "object") {
    throw new Error("private config must contain newsWidget");
  }
  for (const field of ["databaseId", "dataSourceId"]) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(widget[field] ?? "")) {
      throw new Error(`newsWidget.${field} must be a UUID`);
    }
  }
}

function parseArguments(args) {
  const options = {
    apply: false,
    help: false,
    configPath: ".private/notion-sync.json",
    watchlistPath: ".private/watchlist.json",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--dry-run" || argument === "--json") {
      // Both are accepted for consistency. Dry-run is the default.
    } else if (argument === "--config") {
      options.configPath = requireNext(args, ++index, "--config");
    } else if (argument === "--watchlist") {
      options.watchlistPath = requireNext(args, ++index, "--watchlist");
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  return options;
}

function requireNext(args, index, flag) {
  if (!args[index]) {
    throw new Error(`${flag} requires a path`);
  }
  return args[index];
}

function helpText() {
  return `Usage: node scripts/setup_notion_news_watchlist.mjs [options]\n\nOptions:\n  --dry-run          Validate config, schema and seed data (default).\n  --apply            Repair UTF-8 metadata and seed rows only when the database is empty.\n  --config PATH      Private config path.\n  --watchlist PATH   Private seed watchlist path.\n  --json             Accepted for consistency; output is always JSON.\n  -h, --help         Show this help.\n`;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
