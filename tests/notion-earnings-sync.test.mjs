import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EXPECTED_SCHEMA,
  PRESERVED_PROPERTIES,
  assertNoSecrets,
  buildUpsertPlan,
  loadAndNormalizeSource,
  readPropertyValue,
  validateDataSourceSchema,
} from "../scripts/notion_earnings_sync_lib.mjs";

const fixtureUrl = (name) => new URL(`./fixtures/notion-sync/${name}`, import.meta.url);

test("normalizes Moomoo and Yahoo into independent source-specific rows", async () => {
  const [moomoo, yahoo] = await Promise.all([
    loadAndNormalizeSource({
      sourceId: "moomoo",
      sourceConfig: {
        eventKeyPrefix: "moomoo",
        sourceLabel: "Moomoo",
      },
      absolutePath: fixtureUrl("moomoo-staging.json"),
    }),
    loadAndNormalizeSource({
      sourceId: "yahoo",
      sourceConfig: {
        eventKeyPrefix: "yahoo",
        sourceLabel: "Yahoo (unofficial)",
      },
      absolutePath: fixtureUrl("yahoo-staging.json"),
    }),
  ]);

  assert.equal(moomoo.valid, true);
  assert.equal(yahoo.valid, true);
  assert.equal(moomoo.events[0].eventKey, "moomoo:shared-event");
  assert.equal(yahoo.events[0].eventKey, "yahoo:shared-event");
  assert.equal(
    readPropertyValue(moomoo.events[0].properties.Event),
    "TEST | Test Systems",
  );
  assert.equal(
    readPropertyValue(yahoo.events[0].properties["Event Time"]).start,
    "2026-08-21",
  );
  assert.equal(
    readPropertyValue(yahoo.events[0].properties["Time Confidence"]),
    "Date Only",
  );
  assert.equal(
    readPropertyValue(yahoo.events[0].properties["UTC Display"]),
    "",
    "date-only placeholder times must not be promoted to exact display times",
  );

  for (const event of [...moomoo.events, ...yahoo.events]) {
    for (const protectedProperty of PRESERVED_PROPERTIES) {
      assert.equal(Object.hasOwn(event.properties, protectedProperty), false);
    }
  }

  assert.equal(moomoo.events[0].properties["EPS Actual"].number, null);
  assert.equal(moomoo.events[0].properties["EPS Consensus"].number, null);
  assert.equal(yahoo.events[0].properties["Market Cap"].number, null);
  assert.equal(
    moomoo.events[0].properties["Source Publication Time"].date,
    null,
    "fetch time must not be relabelled as publication time",
  );
});

test("builds idempotent create/update/stale operations without user forecast writes", async () => {
  const [moomoo, yahoo, existingPages] = await Promise.all([
    loadAndNormalizeSource({
      sourceId: "moomoo",
      sourceConfig: {
        eventKeyPrefix: "moomoo",
        sourceLabel: "Moomoo",
      },
      absolutePath: fixtureUrl("moomoo-staging.json"),
    }),
    loadAndNormalizeSource({
      sourceId: "yahoo",
      sourceConfig: {
        eventKeyPrefix: "yahoo",
        sourceLabel: "Yahoo (unofficial)",
      },
      absolutePath: fixtureUrl("yahoo-staging.json"),
    }),
    readJsonFixture("existing-pages.json"),
  ]);

  const plan = buildUpsertPlan({
    sourceResults: [moomoo, yahoo],
    existingPages,
  });
  assert.deepEqual(plan.counts, { create: 1, update: 1, stale: 1 });

  const update = plan.operations.find((operation) => operation.kind === "update");
  assert.equal(update.eventKey, "moomoo:shared-event");
  assert.equal(Object.hasOwn(update.properties, "My EPS Forecast"), false);
  assert.equal(Object.hasOwn(update.properties, "My Revenue Forecast"), false);

  const stale = plan.operations.find((operation) => operation.kind === "stale");
  assert.equal(stale.eventKey, "yahoo:old-event");
  assert.deepEqual(stale.properties, {
    "Source Status": { select: { name: "Stale" } },
  });

  const create = plan.operations.find((operation) => operation.kind === "create");
  assert.equal(create.eventKey, "yahoo:shared-event");
  assert.equal(Object.hasOwn(create.properties, "My EPS Forecast"), false);
  assert.equal(Object.hasOwn(create.properties, "My Revenue Forecast"), false);
});

test("rejects duplicate Notion Event Keys instead of choosing an arbitrary row", async () => {
  const [moomoo, existingPages] = await Promise.all([
    loadAndNormalizeSource({
      sourceId: "moomoo",
      sourceConfig: {
        eventKeyPrefix: "moomoo",
        sourceLabel: "Moomoo",
      },
      absolutePath: fixtureUrl("moomoo-staging.json"),
    }),
    readJsonFixture("existing-pages.json"),
  ]);
  existingPages.push({
    id: "duplicate-page",
    properties: existingPages[0].properties,
  });

  assert.throws(
    () => buildUpsertPlan({ sourceResults: [moomoo], existingPages }),
    /duplicate Event Key moomoo:shared-event/,
  );
});

test("validates the required Notion schema and forbids credentials in config", () => {
  const properties = Object.fromEntries(
    Object.entries(EXPECTED_SCHEMA).map(([name, type]) => [name, { type }]),
  );
  assert.doesNotThrow(() => validateDataSourceSchema({ properties }));
  assert.throws(
    () => validateDataSourceSchema({ properties: { ...properties, Event: { type: "rich_text" } } }),
    /Event: expected title, got rich_text/,
  );
  assert.throws(
    () => assertNoSecrets({ notionToken: "do-not-store" }),
    /keychain/,
  );
});

test("compares Notion date-times at the minute precision returned by the API", () => {
  const submitted = readPropertyValue({
    date: { start: "2026-08-14T20:21:03.204Z" },
  });
  const returned = readPropertyValue({
    date: { start: "2026-08-14T20:21:00.000+00:00" },
  });
  assert.deepEqual(submitted, returned);
});

test("stale retained earnings staging cannot restore Ready rows", async () => {
  const [staleSource, existingPages] = await Promise.all([
    loadAndNormalizeSource({
      sourceId: "moomoo",
      sourceConfig: {
        eventKeyPrefix: "moomoo",
        sourceLabel: "Moomoo",
        maxAgeMinutes: 180,
      },
      absolutePath: fixtureUrl("moomoo-staging.json"),
      now: new Date("2026-08-14T23:00:01Z"),
    }),
    readJsonFixture("existing-pages.json"),
  ]);

  assert.equal(staleSource.valid, false);
  assert.equal(staleSource.eventCount, 0);
  assert.match(staleSource.error, /staging is stale/);

  const plan = buildUpsertPlan({
    sourceResults: [staleSource],
    existingPages,
  });
  assert.deepEqual(plan.counts, { create: 0, update: 0, stale: 1 });
  assert.equal(plan.operations[0].eventKey, "moomoo:shared-event");
  assert.deepEqual(plan.operations[0].properties, {
    "Source Status": { select: { name: "Stale" } },
  });
});

async function readJsonFixture(name) {
  return JSON.parse(await readFile(fixtureUrl(name), "utf8"));
}
