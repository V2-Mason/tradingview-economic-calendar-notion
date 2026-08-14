#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSecrets } from "./notion_earnings_sync_lib.mjs";
import {
  buildCompanyNewsUpsertPlan,
  loadAndNormalizeCompanyNews,
  validateCompanyNewsSchema,
} from "./notion_company_news_sync_lib.mjs";
import {
  buildDashboardFeedChildren,
  dashboardFeedMatches,
  selectDashboardNews,
} from "./notion_dashboard_news_feed_lib.mjs";
import {
  applyPlan,
  createNtnClient,
  enforcePrivateConfiguration,
  queryAllPages,
} from "./sync_notion_earnings.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const privateDirectory = resolve(projectRoot, ".private");

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Notion company-news sync failed: ${message}`);
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
  enforcePrivateConfiguration(configPath, config.companyNews.dataSourceId);
  const stagingPath = resolvePrivatePath(config.companyNews.stagingFile);
  const normalized = await loadAndNormalizeCompanyNews(stagingPath, {
    maxAgeMinutes: config.companyNews.maxAgeMinutes,
  });

  const ntn = createNtnClient({
    projectRoot,
    packageName: config.notionCliPackage,
  });
  await ntn.whoami();
  const dataSource = await ntn.api(
    `v1/data_sources/${config.companyNews.dataSourceId}`,
  );
  validateCompanyNewsSchema(dataSource);
  const existingPages = await queryAllPages(
    ntn,
    config.companyNews.dataSourceId,
  );
  const plan = buildCompanyNewsUpsertPlan({ normalized, existingPages });
  if (options.apply) {
    await applyPlan({
      ntn,
      dataSourceId: config.companyNews.dataSourceId,
      plan,
    });
  }

  const dashboardFeed = await prepareDashboardFeed({
    ntn,
    normalized,
    config: config.companyNews.dashboardFeed,
  });
  if (options.apply && dashboardFeed.updateRequired) {
    await applyDashboardFeed({
      ntn,
      blockId: config.companyNews.dashboardFeed.blockId,
      existingBlocks: dashboardFeed.existingBlocks,
      desiredBlocks: dashboardFeed.desiredBlocks,
    });
  }

  const report = {
    status: normalized.valid ? "READY" : "SOURCE_STALE",
    mode: options.apply ? "APPLY" : "DRY_RUN",
    sourceRecords: normalized.recordCount,
    existingPages: existingPages.length,
    changes: plan.counts,
    unchanged: plan.unchanged,
    sourceError: normalized.error,
    dashboardFeed: {
      configured: dashboardFeed.configured,
      items: dashboardFeed.items,
      directLinks: dashboardFeed.directLinks,
      updateRequired: dashboardFeed.updateRequired,
      applied: options.apply && dashboardFeed.updateRequired,
      preservedBecauseStale: dashboardFeed.preservedBecauseStale,
    },
    deleted: 0,
    brokerWrites: false,
    tradeAuthority: "NONE",
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`Notion company-news sync: ${report.mode} / ${report.status}`);
    console.log(
      `Records ${report.sourceRecords}; create ${report.changes.create}, update ${report.changes.update}, stale ${report.changes.stale}, unchanged ${report.unchanged}`,
    );
    if (report.sourceError) {
      console.log(`Source: Stale (${report.sourceError})`);
    }
    console.log("Deleted: 0");
    if (report.dashboardFeed.configured) {
      console.log(
        `Dashboard feed: ${report.dashboardFeed.items} linked stories; update ${report.dashboardFeed.updateRequired ? "required" : "not required"}`,
      );
    }
  }
}

async function prepareDashboardFeed({ ntn, normalized, config }) {
  if (!config) {
    return {
      configured: false,
      items: 0,
      directLinks: 0,
      updateRequired: false,
      preservedBecauseStale: false,
      existingBlocks: [],
      desiredBlocks: [],
    };
  }
  const feedBlock = await ntn.api(`v1/blocks/${config.blockId}`);
  if (feedBlock.type !== "callout" || feedBlock.in_trash) {
    throw new Error("dashboardFeed.blockId must reference an active Notion callout block");
  }
  const existingBlocks = await queryAllBlockChildren(ntn, config.blockId);
  if (!normalized.valid) {
    return {
      configured: true,
      items: 0,
      directLinks: 0,
      updateRequired: false,
      preservedBecauseStale: true,
      existingBlocks,
      desiredBlocks: [],
    };
  }
  const items = selectDashboardNews(normalized.records, config.maxItems);
  const desiredBlocks = buildDashboardFeedChildren({
    items,
    fullNewsUrl: config.fullNewsUrl,
    generatedAt: normalized.generatedAt,
    totalRecords: normalized.recordCount,
  });
  return {
    configured: true,
    items: items.length,
    directLinks: items.length,
    updateRequired: !dashboardFeedMatches(existingBlocks, desiredBlocks),
    preservedBecauseStale: false,
    existingBlocks,
    desiredBlocks,
  };
}

async function queryAllBlockChildren(ntn, blockId) {
  const blocks = [];
  let cursor = null;
  do {
    const suffix = cursor
      ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
      : "?page_size=100";
    const response = await ntn.api(`v1/blocks/${blockId}/children${suffix}`);
    if (!Array.isArray(response.results)) {
      throw new Error("Notion block-children response does not contain results");
    }
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return blocks;
}

async function applyDashboardFeed({ ntn, blockId, existingBlocks, desiredBlocks }) {
  const sameShape = existingBlocks.length === desiredBlocks.length &&
    existingBlocks.every((block, index) => block.type === desiredBlocks[index].type);
  if (sameShape) {
    for (let index = 0; index < desiredBlocks.length; index += 1) {
      if (dashboardFeedMatches([existingBlocks[index]], [desiredBlocks[index]])) {
        continue;
      }
      const desired = desiredBlocks[index];
      await ntn.api(`v1/blocks/${existingBlocks[index].id}`, {
        method: "PATCH",
        body: { [desired.type]: desired[desired.type] },
      });
    }
    return;
  }

  const appended = await ntn.api(`v1/blocks/${blockId}/children`, {
    method: "PATCH",
    body: {
      children: desiredBlocks,
      position: { type: "end" },
    },
  });
  if (!Array.isArray(appended.results) || appended.results.length !== desiredBlocks.length) {
    throw new Error("Notion did not confirm every replacement dashboard-feed block");
  }
  for (const block of existingBlocks) {
    await ntn.api(`v1/blocks/${block.id}`, { method: "DELETE" });
  }
}

function parseArguments(args) {
  const options = {
    apply: false,
    dryRun: false,
    json: false,
    help: false,
    configPath: ".private/notion-sync.json",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      options.apply = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--config") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      options.configPath = value;
      index += 1;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (options.apply && options.dryRun) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  return options;
}

function validateConfig(config) {
  const news = config.companyNews;
  if (!/^ntn@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(config.notionCliPackage ?? "")) {
    throw new Error("notionCliPackage must pin an ntn version");
  }
  if (!news || typeof news !== "object") {
    throw new Error("private config must contain companyNews");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(news.dataSourceId ?? "")) {
    throw new Error("companyNews.dataSourceId must be a UUID");
  }
  if (!String(news.stagingFile ?? "").trim()) {
    throw new Error("companyNews.stagingFile is required");
  }
  if (!Number.isFinite(news.maxAgeMinutes) || news.maxAgeMinutes <= 0) {
    throw new Error("companyNews.maxAgeMinutes must be a positive number");
  }
  if (news.dashboardFeed) {
    const feed = news.dashboardFeed;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(feed.blockId ?? "")) {
      throw new Error("companyNews.dashboardFeed.blockId must be a UUID");
    }
    if (!Number.isInteger(feed.maxItems) || feed.maxItems < 1 || feed.maxItems > 20) {
      throw new Error("companyNews.dashboardFeed.maxItems must be an integer from 1 to 20");
    }
    let fullNewsUrl;
    try {
      fullNewsUrl = new URL(feed.fullNewsUrl);
    } catch {
      throw new Error("companyNews.dashboardFeed.fullNewsUrl must be a URL");
    }
    if (!new Set(["https:", "http:"]).has(fullNewsUrl.protocol)) {
      throw new Error("companyNews.dashboardFeed.fullNewsUrl must use HTTP or HTTPS");
    }
  }
}

function resolvePrivatePath(configuredPath) {
  const absolutePath = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(projectRoot, configuredPath);
  const pathFromPrivate = relative(privateDirectory, absolutePath);
  const inside =
    pathFromPrivate === "" ||
    (!pathFromPrivate.startsWith(`..${sep}`) &&
      pathFromPrivate !== ".." &&
      !isAbsolute(pathFromPrivate));
  if (!inside) {
    throw new Error(`company-news staging path must stay under .private/: ${configuredPath}`);
  }
  return absolutePath;
}

function helpText() {
  return `Usage: node scripts/sync_notion_company_news.mjs [options]\n\nOptions:\n  --dry-run          Query Notion and print the idempotent plan; this is the default.\n  --apply            Execute page create/update operations through official ntn CLI.\n  --json             Emit a summary without page or data-source IDs.\n  --config PATH      Private config path (default: .private/notion-sync.json).\n  -h, --help         Show this help.\n\nAuthentication is read from the official ntn CLI keychain.\n`;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
