const WIDGET_SCRIPT =
  "https://s3.tradingview.com/external-embedding/embed-widget-timeline.js";
const MAX_POOLS = 8;
const MAX_SYMBOLS_PER_POOL = 40;

const elements = {
  poolTabs: document.querySelector("#pool-tabs"),
  companySelect: document.querySelector("#company-select"),
  state: document.querySelector("#feed-state"),
  host: document.querySelector("#widget-host"),
};

const settings = parseFragment(location.hash);
let activePoolId = settings.selectedPool;
let activeSymbol = settings.selectedSymbol;

renderPoolTabs();
selectPool(activePoolId, activeSymbol);

elements.companySelect.addEventListener("change", () => {
  activeSymbol = elements.companySelect.value;
  renderFeed(activeSymbol, settings.locale);
  rememberSelection();
});

function parseFragment(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const locale = /^[A-Za-z_]{2,10}$/.test(params.get("locale") ?? "")
    ? params.get("locale")
    : "en";
  const pools = parseEncodedConfig(params.get("config"));
  const poolIds = new Set(pools.map((pool) => pool.id));
  const requestedPool = params.get("pool");
  const selectedPool = poolIds.has(requestedPool)
    ? requestedPool
    : pools[0]?.id ?? null;
  const selectedSymbols = new Set(
    pools.find((pool) => pool.id === selectedPool)?.symbols.map((item) => item.proName),
  );
  const requestedSymbol = params.get("symbol");
  const selectedSymbol = selectedSymbols.has(requestedSymbol)
    ? requestedSymbol
    : pools.find((pool) => pool.id === selectedPool)?.symbols[0]?.proName ?? null;
  return { pools, selectedPool, selectedSymbol, locale, params };
}

function parseEncodedConfig(encoded) {
  if (!encoded) {
    return [];
  }
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const document = JSON.parse(new TextDecoder().decode(bytes));
    if (document?.v === 2) {
      return normalizeCompactPools(document);
    }
    return normalizePools(document?.pools);
  } catch {
    return [];
  }
}

function normalizeCompactPools(document) {
  if (!Array.isArray(document?.s) || !Array.isArray(document?.p)) {
    return [];
  }
  const catalog = document.s.map((entry) => ({
    proName: Array.isArray(entry) ? entry[0] : "",
    label: Array.isArray(entry) ? entry[1] : "",
  }));
  const rawPools = document.p.map((entry) => {
    if (!Array.isArray(entry)) {
      return null;
    }
    const indexes = Array.isArray(entry[2]) ? entry[2] : [];
    return {
      id: entry[0],
      label: entry[1],
      symbols: indexes
        .filter((index) => Number.isInteger(index) && index >= 0 && index < catalog.length)
        .map((index) => catalog[index]),
    };
  });
  return normalizePools(rawPools);
}

function normalizePools(rawPools) {
  if (!Array.isArray(rawPools)) {
    return [];
  }
  const pools = [];
  const seenPools = new Set();
  for (const rawPool of rawPools) {
    if (pools.length >= MAX_POOLS) {
      break;
    }
    const id = String(rawPool?.id ?? "").trim();
    if (!/^[a-z0-9_-]{1,30}$/.test(id) || seenPools.has(id)) {
      continue;
    }
    const symbols = normalizeSymbols(rawPool?.symbols);
    if (symbols.length === 0) {
      continue;
    }
    seenPools.add(id);
    pools.push({
      id,
      label: clip(rawPool?.label || id, 24),
      symbols,
    });
  }
  return pools;
}

function normalizeSymbols(rawSymbols) {
  if (!Array.isArray(rawSymbols)) {
    return [];
  }
  const symbols = [];
  const seen = new Set();
  for (const rawSymbol of rawSymbols) {
    if (symbols.length >= MAX_SYMBOLS_PER_POOL) {
      break;
    }
    const proName = String(rawSymbol?.proName ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9_.-]+:[A-Z0-9_.-]+$/.test(proName) || seen.has(proName)) {
      continue;
    }
    seen.add(proName);
    symbols.push({
      proName,
      label: clip(rawSymbol?.label || proName, 60),
    });
  }
  return symbols;
}

function renderPoolTabs() {
  elements.poolTabs.replaceChildren();
  for (const pool of settings.pools) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pool-tab";
    button.dataset.poolId = pool.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(pool.id === activePoolId));
    button.textContent = pool.label;
    button.addEventListener("click", () => selectPool(pool.id, activeSymbol));
    elements.poolTabs.append(button);
  }
}

function selectPool(poolId, preferredSymbol) {
  const pool = settings.pools.find((candidate) => candidate.id === poolId);
  activePoolId = pool?.id ?? settings.pools[0]?.id ?? null;
  const activePool = settings.pools.find((candidate) => candidate.id === activePoolId);
  for (const tab of elements.poolTabs.querySelectorAll(".pool-tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.poolId === activePoolId));
  }
  elements.companySelect.replaceChildren();
  for (const symbol of activePool?.symbols ?? []) {
    elements.companySelect.append(option(symbol.proName, symbol.label));
  }
  const available = new Set((activePool?.symbols ?? []).map((item) => item.proName));
  activeSymbol = available.has(preferredSymbol)
    ? preferredSymbol
    : activePool?.symbols[0]?.proName ?? null;
  elements.companySelect.value = activeSymbol ?? "";
  renderFeed(activeSymbol, settings.locale);
  rememberSelection();
}

function renderFeed(symbol, locale) {
  elements.host.replaceChildren();
  if (!symbol) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "尚未配置新闻关注池。";
    elements.host.append(empty);
    elements.state.textContent = "未配置";
    return;
  }
  const container = document.createElement("div");
  container.className = "tradingview-widget-container";
  const widget = document.createElement("div");
  widget.className = "tradingview-widget-container__widget";
  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = WIDGET_SCRIPT;
  script.async = true;
  script.textContent = JSON.stringify({
    feedMode: "symbol",
    symbol,
    isTransparent: false,
    displayMode: "regular",
    width: "100%",
    height: "100%",
    colorTheme: "dark",
    locale,
  });
  container.append(widget, script);
  elements.host.append(container);
  elements.state.textContent = `${symbol} · TradingView 精选`;
}

function rememberSelection() {
  const params = new URLSearchParams(settings.params);
  if (activePoolId) {
    params.set("pool", activePoolId);
  }
  if (activeSymbol) {
    params.set("symbol", activeSymbol);
  }
  history.replaceState(null, "", `${location.pathname}${location.search}#${params}`);
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function clip(value, maxLength) {
  const text = String(value || "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
