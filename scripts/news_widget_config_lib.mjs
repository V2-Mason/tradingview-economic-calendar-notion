const KNOWN_POOL_ORDER = new Map([
  ["最近观察持仓", 0],
  ["US 关注", 1],
  ["HK 关注", 2],
  ["研究候选", 3],
]);

export const NEWS_WATCHLIST_EXPECTED_SCHEMA = Object.freeze({
  Name: "title",
  Ticker: "rich_text",
  Company: "rich_text",
  "TradingView Symbol": "rich_text",
  Market: "select",
  Pools: "multi_select",
  Active: "checkbox",
  Order: "number",
});

export function validateNewsWatchlistSchema(dataSource) {
  const properties = dataSource?.properties;
  if (!properties || typeof properties !== "object") {
    throw new Error("Notion news-watchlist data source does not contain properties");
  }
  const mismatches = [];
  for (const [name, expectedType] of Object.entries(NEWS_WATCHLIST_EXPECTED_SCHEMA)) {
    const actualType = properties[name]?.type;
    if (actualType !== expectedType) {
      mismatches.push(`${name}: expected ${expectedType}, got ${actualType ?? "missing"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Notion news-watchlist schema mismatch: ${mismatches.join("; ")}`);
  }
}

export function buildWidgetPools(pages, { maxPools = 8, maxSymbolsPerPool = 40 } = {}) {
  const poolSymbols = new Map();
  for (const page of pages ?? []) {
    const properties = page?.properties ?? {};
    if (!readCheckbox(properties.Active)) {
      continue;
    }
    const ticker = readPlainText(properties.Ticker);
    const company = readPlainText(properties.Company);
    const proName = readPlainText(properties["TradingView Symbol"]).toUpperCase();
    const order = readNumber(properties.Order) ?? Number.MAX_SAFE_INTEGER;
    const poolNames = readMultiSelect(properties.Pools);
    if (!ticker || !company || !isTradingViewSymbol(proName) || poolNames.length === 0) {
      continue;
    }
    for (const poolName of poolNames) {
      const cleanName = clip(poolName, 24);
      if (!poolSymbols.has(cleanName)) {
        poolSymbols.set(cleanName, new Map());
      }
      const symbols = poolSymbols.get(cleanName);
      const existing = symbols.get(proName);
      if (!existing || order < existing.order) {
        symbols.set(proName, {
          proName,
          label: clip(`${ticker} | ${company}`, 60),
          order,
        });
      }
    }
  }

  const pools = [...poolSymbols]
    .map(([label, symbols]) => ({
      id: poolId(label),
      label,
      order: KNOWN_POOL_ORDER.get(label) ?? 100,
      symbols: [...symbols.values()]
        .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
        .slice(0, maxSymbolsPerPool)
        .map(({ proName, label: symbolLabel }) => ({ proName, label: symbolLabel })),
    }))
    .filter((pool) => pool.symbols.length > 0)
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
    .slice(0, maxPools)
    .map(({ order: _order, ...pool }) => pool);

  const seenIds = new Set();
  for (const pool of pools) {
    if (seenIds.has(pool.id)) {
      throw new Error(`news-watchlist pool ID collision for ${pool.label}`);
    }
    seenIds.add(pool.id);
  }
  if (pools.length === 0) {
    throw new Error("Notion news-watchlist has no active, valid pool members");
  }
  return pools;
}

export function buildNewsWidgetUrl({ baseUrl, pools, locale = "en" }) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("news widget baseUrl must use HTTPS");
  }
  const encoded = Buffer.from(
    JSON.stringify({ version: 1, pools }),
    "utf8",
  ).toString("base64url");
  const firstPool = pools[0];
  const params = new URLSearchParams({
    config: encoded,
    pool: firstPool.id,
    symbol: firstPool.symbols[0].proName,
    locale,
  });
  url.hash = params.toString();
  return url.toString();
}

export function widgetUrlMatches(currentUrl, desiredUrl) {
  try {
    return new URL(currentUrl).toString() === new URL(desiredUrl).toString();
  } catch {
    return false;
  }
}

function poolId(label) {
  const known = new Map([
    ["最近观察持仓", "positions"],
    ["US 关注", "us"],
    ["HK 关注", "hk"],
    ["研究候选", "candidates"],
  ]).get(label);
  if (known) {
    return known;
  }
  let hash = 2166136261;
  for (const character of label) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `pool-${hash.toString(36)}`;
}

function readPlainText(property) {
  const items = property?.title ?? property?.rich_text;
  if (!Array.isArray(items)) {
    return "";
  }
  return items
    .map((item) => item?.plain_text ?? item?.text?.content ?? "")
    .join("")
    .trim();
}

function readCheckbox(property) {
  return property?.type === "checkbox" ? Boolean(property.checkbox) : false;
}

function readNumber(property) {
  return property?.type === "number" && Number.isFinite(property.number)
    ? property.number
    : null;
}

function readMultiSelect(property) {
  if (property?.type !== "multi_select" || !Array.isArray(property.multi_select)) {
    return [];
  }
  return property.multi_select
    .map((option) => String(option?.name ?? "").trim())
    .filter(Boolean);
}

function isTradingViewSymbol(value) {
  return /^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/.test(value);
}

function clip(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
