#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRESERVED_PROPERTIES,
  buildUpsertPlan,
  loadAndNormalizeSource,
  readSyncConfig,
  validateDataSourceSchema,
} from "./notion_earnings_sync_lib.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const privateDirectory = resolve(projectRoot, ".private");

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Notion earnings sync failed: ${message}`);
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
  const config = await readSyncConfig(configPath);
  enforcePrivateConfiguration(configPath, config.dataSourceId);

  const sourceResults = [];
  for (const sourceId of ["moomoo", "yahoo"]) {
    const sourceConfig = config.sources[sourceId];
    const absolutePath = resolveProjectPrivatePath(sourceConfig.stagingFile);
    sourceResults.push(
      await loadAndNormalizeSource({
        sourceId,
        sourceConfig,
        absolutePath,
      }),
    );
  }

  const ntn = createNtnClient({
    projectRoot,
    packageName: config.notionCliPackage,
  });
  await ntn.whoami();

  const dataSource = await ntn.api(`v1/data_sources/${config.dataSourceId}`);
  validateDataSourceSchema(dataSource);
  const existingPages = await queryAllPages(ntn, config.dataSourceId);
  const plan = buildUpsertPlan({ sourceResults, existingPages });

  if (options.apply) {
    await applyPlan({ ntn, dataSourceId: config.dataSourceId, plan });
  }

  const report = buildReport({ options, sourceResults, existingPages, plan });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHumanReport(report);
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

export function createNtnClient({ projectRoot: cwd, packageName }) {
  // Windows cannot execute an npm-generated .cmd shim directly through
  // child_process.spawn (it fails with EINVAL). Invoke the pinned package via
  // cmd.exe explicitly there; request bodies still travel over stdin.
  const executable = process.platform === "win32"
    ? process.env.ComSpec ?? "cmd.exe"
    : "npx";
  const prefix = process.platform === "win32"
    ? ["/d", "/s", "/c", "npx", "--yes", packageName]
    : ["--yes", packageName];

  return {
    async whoami() {
      await runCommand(executable, [...prefix, "whoami"], { cwd });
    },

    async api(apiPath, { method = "GET", body } = {}) {
      const args = [...prefix, "api", apiPath];
      if (method !== "GET") {
        args.push("-X", method);
      }
      let input;
      if (body !== undefined) {
        args.push("--data", "@-");
        input = JSON.stringify(body);
      }
      const result = await runCommand(executable, args, { cwd, input });
      return parseNtnJson(result.stdout, `${method} ${apiPath}`);
    },
  };
}

export async function queryAllPages(ntn, dataSourceId) {
  const pages = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (cursor) {
      body.start_cursor = cursor;
    }
    const response = await ntn.api(`v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body,
    });
    if (!Array.isArray(response.results)) {
      throw new Error("Notion query response does not contain results");
    }
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : null;
  } while (cursor);
  return pages;
}

export async function applyPlan({ ntn, dataSourceId, plan }) {
  for (const operation of plan.operations) {
    if (operation.kind === "create") {
      await ntn.api("v1/pages", {
        method: "POST",
        body: {
          parent: {
            type: "data_source_id",
            data_source_id: dataSourceId,
          },
          properties: operation.properties,
        },
      });
      continue;
    }

    await ntn.api(`v1/pages/${operation.pageId}`, {
      method: "PATCH",
      body: { properties: operation.properties },
    });
  }
}

function buildReport({ options, sourceResults, existingPages, plan }) {
  const invalidSources = sourceResults.filter((source) => !source.valid);
  return {
    status: invalidSources.length > 0 ? "SOURCE_STALE" : "READY",
    mode: options.apply ? "APPLY" : "DRY_RUN",
    existingPages: existingPages.length,
    sourceEvents: Object.fromEntries(
      sourceResults.map((source) => [source.sourceId, source.eventCount]),
    ),
    sourceStatus: sourceResults.map((source) => ({
      source: source.sourceId,
      status: source.valid ? "Ready" : "Stale",
      ...(source.error ? { error: source.error } : {}),
    })),
    changes: plan.counts,
    unchanged: plan.unchanged,
    protectedProperties: [...PRESERVED_PROPERTIES],
    deleted: 0,
    brokerWrites: false,
    tradeAuthority: "NONE",
  };
}

function printHumanReport(report) {
  console.log(`Notion earnings sync: ${report.mode} / ${report.status}`);
  console.log(
    `Sources: Moomoo ${report.sourceEvents.moomoo ?? 0}, Yahoo ${report.sourceEvents.yahoo ?? 0}; existing ${report.existingPages}`,
  );
  console.log(
    `Changes: create ${report.changes.create}, update ${report.changes.update}, stale ${report.changes.stale}, unchanged ${report.unchanged}`,
  );
  for (const source of report.sourceStatus) {
    if (source.error) {
      console.log(`${source.source}: Stale (${source.error})`);
    }
  }
  console.log(
    `Protected: ${report.protectedProperties.join(", ")}; deleted ${report.deleted}`,
  );
}

export function enforcePrivateConfiguration(configPath, dataSourceId) {
  const placeholder = "00000000-0000-0000-0000-000000000000";
  if (dataSourceId === placeholder) {
    throw new Error("replace the placeholder dataSourceId in .private/notion-sync.json");
  }
  if (!isInside(configPath, privateDirectory)) {
    throw new Error("a real Notion data source ID may only be stored under .private/");
  }
}

function resolveProjectPrivatePath(configuredPath) {
  const absolutePath = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(projectRoot, configuredPath);
  if (!isInside(absolutePath, privateDirectory)) {
    throw new Error(`private staging path must stay under .private/: ${configuredPath}`);
  }
  return absolutePath;
}

function isInside(candidate, directory) {
  const pathFromDirectory = relative(directory, candidate);
  return (
    pathFromDirectory === "" ||
    (!pathFromDirectory.startsWith(`..${sep}`) && pathFromDirectory !== ".." && !isAbsolute(pathFromDirectory))
  );
}

function runCommand(command, args, { cwd, input } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      rejectPromise(new Error(`unable to start official ntn CLI: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new Error(
            `official ntn CLI exited ${code}: ${sanitizeCliError(stderr || stdout)}`,
          ),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function parseNtnJson(stdout, action) {
  const cleaned = stdout.replace(/\u001b\[[0-9;]*m/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {
        // The error below intentionally excludes raw CLI output.
      }
    }
    throw new Error(`official ntn CLI returned invalid JSON for ${action}`);
  }
}

function sanitizeCliError(value) {
  return String(value)
    .replace(/ntn_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 500);
}

function helpText() {
  return `Usage: node scripts/sync_notion_earnings.mjs [options]\n\nOptions:\n  --dry-run          Query Notion and print the idempotent plan; this is the default.\n  --apply            Execute page create/update operations through official ntn CLI.\n  --json             Emit a machine-readable summary without page or data-source IDs.\n  --config PATH      Private config path (default: .private/notion-sync.json).\n  -h, --help         Show this help.\n\nAuthentication is read from the official ntn CLI keychain. Tokens are forbidden in config.\n`;
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
