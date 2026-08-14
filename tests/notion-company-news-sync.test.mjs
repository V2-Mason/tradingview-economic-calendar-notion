import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  NEWS_EXPECTED_SCHEMA,
  buildCompanyNewsUpsertPlan,
  loadAndNormalizeCompanyNews,
  readNewsProperty,
  validateCompanyNewsSchema,
} from "../scripts/notion_company_news_sync_lib.mjs";
import {
  buildDashboardFeedChildren,
  dashboardFeedMatches,
  selectDashboardNews,
} from "../scripts/notion_dashboard_news_feed_lib.mjs";

const fixtureUrl = (name) => new URL(`./fixtures/notion-news/${name}`, import.meta.url);

test("keeps Moomoo discovery unverified even when provider metadata says SEC", async () => {
  const normalized = await loadAndNormalizeCompanyNews(
    fixtureUrl("company-news-staging.json"),
  );
  assert.equal(normalized.valid, true);
  assert.equal(normalized.recordCount, 2);

  const moomoo = normalized.records[0];
  assert.equal(moomoo.newsKey, "moomoo:NEWS-11111111111111111111");
  assert.equal(readNewsProperty(moomoo.properties.Source), "Moomoo");
  assert.equal(readNewsProperty(moomoo.properties["Source Tier"]), "Discovery");
  assert.equal(readNewsProperty(moomoo.properties.Verification), "Unverified");
  assert.equal(readNewsProperty(moomoo.properties["Published Raw"]), "8/10");
  assert.equal(readNewsProperty(moomoo.properties["Published At"]), null);
  assert.match(readNewsProperty(moomoo.properties.Summary), /Provider metadata: SEC/);

  const sec = normalized.records[1];
  assert.equal(sec.newsKey, "sec:NEWS-22222222222222222222");
  assert.equal(readNewsProperty(sec.properties.Source), "SEC");
  assert.equal(readNewsProperty(sec.properties["Source Tier"]), "Primary");
  assert.equal(readNewsProperty(sec.properties.Category), "Filing");
  assert.deepEqual(readNewsProperty(sec.properties["Published At"]), {
    start: "2026-08-12",
    end: null,
  });
});

test("upserts by News Key, preserves Material, and keeps Fetched At create-only", async () => {
  const [normalized, existingPages] = await Promise.all([
    loadAndNormalizeCompanyNews(fixtureUrl("company-news-staging.json")),
    readJson("existing-pages.json"),
  ]);
  const plan = buildCompanyNewsUpsertPlan({ normalized, existingPages });
  assert.deepEqual(plan.counts, { create: 1, update: 1, stale: 1 });

  const update = plan.operations.find((operation) => operation.kind === "update");
  assert.equal(update.newsKey, "moomoo:NEWS-11111111111111111111");
  assert.equal(Object.hasOwn(update.properties, "Fetched At"), false);
  assert.equal(Object.hasOwn(update.properties, "Material"), false);
  assert.deepEqual(update.properties["Last Seen"], {
    date: { start: "2026-08-14T22:00:00Z" },
  });

  const stale = plan.operations.find((operation) => operation.kind === "stale");
  assert.deepEqual(stale.properties, {
    "Source Status": { select: { name: "Stale" } },
  });
  assert.equal(Object.hasOwn(stale.properties, "Material"), false);
});

test("validates the Company News data-source contract", () => {
  const properties = Object.fromEntries(
    Object.entries(NEWS_EXPECTED_SCHEMA).map(([name, type]) => [name, { type }]),
  );
  assert.doesNotThrow(() => validateCompanyNewsSchema({ properties }));
  assert.throws(
    () => validateCompanyNewsSchema({ properties: { ...properties, "News Key": { type: "title" } } }),
    /News Key: expected rich_text, got title/,
  );
});

test("compares Notion news date-times at the minute precision returned by the API", () => {
  const submitted = readNewsProperty({
    date: { start: "2026-08-14T22:00:42.900Z" },
  });
  const returned = readNewsProperty({
    date: { start: "2026-08-14T22:00:00.000+00:00" },
  });
  assert.deepEqual(submitted, returned);
});

test("builds a balanced compact dashboard feed with direct article links", async () => {
  const normalized = await loadAndNormalizeCompanyNews(
    fixtureUrl("company-news-staging.json"),
  );
  const hongKong = structuredClone(normalized.records[0]);
  hongKong.newsKey = "moomoo:NEWS-HK-DASHBOARD";
  hongKong.properties.Market = { select: { name: "HK" } };
  hongKong.properties.Ticker = {
    rich_text: [{ type: "text", text: { content: "3896.HK" } }],
  };
  hongKong.properties.Headline = {
    title: [{ type: "text", text: { content: "Kingsoft Cloud update" } }],
  };
  hongKong.properties["Original URL"] = {
    url: "https://example.com/hk-news",
  };

  const selected = selectDashboardNews(
    [normalized.records[0], normalized.records[1], hongKong],
    2,
  );
  assert.deepEqual(selected.map((item) => item.market), ["US", "HK"]);
  const children = buildDashboardFeedChildren({
    items: selected,
    fullNewsUrl: "https://www.notion.so/example-news",
    generatedAt: normalized.generatedAt,
    totalRecords: 3,
  });
  assert.equal(children.length, 4);
  assert.equal(
    children[0].paragraph.rich_text[1].text.link.url,
    "https://example.com/test-news",
  );
  assert.equal(
    children[1].paragraph.rich_text[1].text.link.url,
    "https://example.com/hk-news",
  );
  assert.equal(
    children[3].paragraph.rich_text[0].text.link.url,
    "https://www.notion.so/example-news",
  );
  assert.equal(dashboardFeedMatches(children, structuredClone(children)), true);
});

test("stale retained company-news staging cannot restore Ready rows", async () => {
  const [normalized, existingPages] = await Promise.all([
    loadAndNormalizeCompanyNews(fixtureUrl("company-news-staging.json"), {
      maxAgeMinutes: 180,
      now: new Date("2026-08-15T01:00:01Z"),
    }),
    readJson("existing-pages.json"),
  ]);

  assert.equal(normalized.valid, false);
  assert.equal(normalized.recordCount, 0);
  assert.match(normalized.error, /staging is stale/);

  const plan = buildCompanyNewsUpsertPlan({ normalized, existingPages });
  assert.deepEqual(plan.counts, { create: 0, update: 0, stale: 2 });
  assert.equal(
    plan.operations.every(
      (operation) =>
        operation.kind === "stale" &&
        readNewsProperty(operation.properties["Source Status"]) === "Stale",
    ),
    true,
  );
});

async function readJson(name) {
  return JSON.parse(await readFile(fixtureUrl(name), "utf8"));
}
