import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNewsWidgetUrl,
  buildWidgetPools,
  validateNewsWatchlistSchema,
  widgetUrlMatches,
} from "../scripts/news_widget_config_lib.mjs";

test("builds ordered switchable pools from active Notion rows", () => {
  const pages = [
    page({
      ticker: "NVDA",
      company: "NVIDIA",
      symbol: "NASDAQ:NVDA",
      market: "US",
      pools: ["US 关注", "研究候选"],
      order: 2,
    }),
    page({
      ticker: "3896.HK",
      company: "Kingsoft Cloud",
      symbol: "HKEX:3896",
      market: "HK",
      pools: ["最近观察持仓", "HK 关注"],
      order: 1,
    }),
    page({
      ticker: "OLD",
      company: "Inactive",
      symbol: "NYSE:OLD",
      market: "US",
      pools: ["US 关注"],
      active: false,
    }),
  ];
  const pools = buildWidgetPools(pages);
  assert.deepEqual(pools.map(({ id, label }) => ({ id, label })), [
    { id: "positions", label: "最近观察持仓" },
    { id: "us", label: "US 关注" },
    { id: "hk", label: "HK 关注" },
    { id: "candidates", label: "研究候选" },
  ]);
  assert.equal(pools[1].symbols[0].proName, "NASDAQ:NVDA");
  assert.equal(JSON.stringify(pools).includes("OLD"), false);
});

test("encodes configuration in a URL fragment", () => {
  const pools = [{
    id: "us",
    label: "US 关注",
    symbols: [{ proName: "NASDAQ:NVDA", label: "NVDA | NVIDIA" }],
  }];
  const url = buildNewsWidgetUrl({
    baseUrl: "https://example.test/news/",
    pools,
  });
  const parsed = new URL(url);
  assert.equal(parsed.search, "");
  assert.match(parsed.hash, /^#config=/);
  const params = new URLSearchParams(parsed.hash.slice(1));
  const decoded = JSON.parse(Buffer.from(params.get("config"), "base64url").toString("utf8"));
  assert.equal(decoded.v, 2);
  assert.deepEqual(decoded.s, [["NASDAQ:NVDA", "NVDA | NVIDIA"]]);
  assert.deepEqual(decoded.p, [["us", "US 关注", [0]]]);
  assert.equal(widgetUrlMatches(url, url), true);
});

test("stores a repeated company once across multiple pools", () => {
  const symbol = { proName: "NASDAQ:NVDA", label: "NVDA | NVIDIA" };
  const url = buildNewsWidgetUrl({
    baseUrl: "https://example.test/news/",
    pools: [
      { id: "us", label: "US 关注", symbols: [symbol] },
      { id: "candidates", label: "研究候选", symbols: [symbol] },
    ],
  });
  const config = new URLSearchParams(new URL(url).hash.slice(1)).get("config");
  const decoded = JSON.parse(Buffer.from(config, "base64url").toString("utf8"));
  assert.equal(decoded.s.length, 1);
  assert.deepEqual(decoded.p.map((pool) => pool[2]), [[0], [0]]);
});

test("validates the minimal editable Notion schema", () => {
  const properties = Object.fromEntries(
    Object.entries({
      Name: "title",
      Ticker: "rich_text",
      Company: "rich_text",
      "TradingView Symbol": "rich_text",
      Market: "select",
      Pools: "multi_select",
      Active: "checkbox",
      Order: "number",
    }).map(([name, type]) => [name, { type }]),
  );
  assert.doesNotThrow(() => validateNewsWatchlistSchema({ properties }));
});

function page({ ticker, company, symbol, market, pools, order = 0, active = true }) {
  const richText = (value) => ({
    type: "rich_text",
    rich_text: [{ plain_text: value }],
  });
  return {
    properties: {
      Name: { type: "title", title: [{ plain_text: `${ticker} | ${company}` }] },
      Ticker: richText(ticker),
      Company: richText(company),
      "TradingView Symbol": richText(symbol),
      Market: { type: "select", select: { name: market } },
      Pools: {
        type: "multi_select",
        multi_select: pools.map((name) => ({ name })),
      },
      Active: { type: "checkbox", checkbox: active },
      Order: { type: "number", number: order },
    },
  };
}
