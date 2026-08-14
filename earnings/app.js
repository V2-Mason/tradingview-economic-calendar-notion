"use strict";

const params = new URLSearchParams(window.location.search);
const demoMode = params.get("demo") === "1";
const compactMode = params.get("compact") === "1";
const requestedTheme = params.get("theme");

if (["light", "dark"].includes(requestedTheme)) {
  document.documentElement.dataset.theme = requestedTheme;
}
if (compactMode) {
  document.body.classList.add("compact");
}

const elements = {
  rows: document.querySelector("#event-rows"),
  empty: document.querySelector("#empty-state"),
  emptyCopy: document.querySelector("#empty-copy"),
  tableScroll: document.querySelector(".table-scroll"),
  notice: document.querySelector("#notice"),
  freshness: document.querySelector("#freshness"),
  freshnessText: document.querySelector("#freshness-text"),
  resultCount: document.querySelector("#result-count"),
  timezone: document.querySelector("#timezone-select"),
  search: document.querySelector("#search-input"),
  dialog: document.querySelector("#event-dialog"),
  dialogContent: document.querySelector("#dialog-content"),
};

const validRanges = new Set([
  "recent",
  "today",
  "tomorrow",
  "this-week",
  "next-week",
  "this-month",
]);
const requestedRange = params.get("range");
const requestedMarkets = (params.get("markets") || "US,HK")
  .toUpperCase()
  .split(",")
  .filter((market) => ["US", "HK"].includes(market));
const requestedTimezone = params.get("timezone");

const state = {
  range: validRanges.has(requestedRange) ? requestedRange : "next-week",
  markets: new Set(requestedMarkets.length ? requestedMarkets : ["US", "HK"]),
  timezone:
    requestedTimezone === "Asia/Hong_Kong" || requestedTimezone === "HKT"
      ? "Asia/Hong_Kong"
      : "America/New_York",
  query: "",
  feed: null,
};

initializeControls();
loadFeed();

function initializeControls() {
  document.querySelectorAll("[data-range]").forEach((button) => {
    const active = button.dataset.range === state.range;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.addEventListener("click", () => {
      state.range = button.dataset.range;
      document.querySelectorAll("[data-range]").forEach((candidate) => {
        const selected = candidate === button;
        candidate.classList.toggle("is-active", selected);
        candidate.setAttribute("aria-selected", String(selected));
      });
      render();
    });
  });

  document.querySelectorAll('input[name="market"]').forEach((checkbox) => {
    checkbox.checked = state.markets.has(checkbox.value);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.markets.add(checkbox.value);
      } else {
        state.markets.delete(checkbox.value);
      }
      render();
    });
  });

  elements.timezone.value = state.timezone;
  elements.timezone.addEventListener("change", () => {
    state.timezone = elements.timezone.value;
    render();
  });

  elements.search.addEventListener("input", () => {
    state.query = elements.search.value.trim().toLocaleLowerCase();
    render();
  });
}

async function loadFeed() {
  const source = demoMode ? "data/events.demo.json" : "data/events.json";
  try {
    const response = await fetch(source, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const feed = await response.json();
    assertFeed(feed);
    state.feed = feed;
    updateFreshness();
    updateNotice();
    render();
  } catch (error) {
    elements.freshnessText.textContent = "数据读取失败";
    elements.notice.hidden = false;
    elements.notice.textContent = `无法读取财报数据：${error.message}`;
    elements.empty.hidden = false;
    elements.tableScroll.hidden = true;
  }
}

function assertFeed(feed) {
  if (!feed || feed.schemaVersion !== "1.0.0" || !Array.isArray(feed.events)) {
    throw new Error("不支持的数据格式");
  }
  for (const event of feed.events) {
    if (
      !event.id ||
      !["US", "HK"].includes(event.market) ||
      !event.ticker ||
      !event.company ||
      !event.scheduledAt
    ) {
      throw new Error("事件缺少必要字段");
    }
  }
}

function updateFreshness() {
  const generatedAt = state.feed.generatedAt
    ? new Date(state.feed.generatedAt)
    : null;
  if (!generatedAt || Number.isNaN(generatedAt.getTime())) {
    elements.freshnessText.textContent = "暂无已审核数据";
    return;
  }
  const ageHours = Math.max(0, (Date.now() - generatedAt.getTime()) / 3_600_000);
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: state.timezone,
  });
  elements.freshnessText.textContent = `更新于 ${formatter.format(generatedAt)}`;
  elements.freshness.classList.toggle("is-fresh", ageHours <= 36);
}

function updateNotice() {
  if (demoMode) {
    elements.notice.hidden = false;
    elements.notice.textContent =
      "当前为合成数据预览，不代表真实公司、预测或财报结果。";
    return;
  }
  if (state.feed.events.length === 0) {
    elements.notice.hidden = false;
    elements.notice.textContent =
      "公开数据源目前为空。yfinance 结果保留在个人暂存层；只有经过官方来源核验且允许公开的数据才会进入这里。";
    return;
  }
  elements.notice.hidden = true;
}

function render() {
  if (!state.feed) {
    return;
  }
  updateFreshness();
  const range = dateRange(state.range, state.timezone);
  const events = state.feed.events
    .filter((event) => state.markets.has(event.market))
    .filter((event) => {
      const key = dateKey(event.scheduledAt, state.timezone);
      return key >= range.start && key <= range.end;
    })
    .filter(matchesSearch)
    .sort((left, right) => new Date(left.scheduledAt) - new Date(right.scheduledAt));

  elements.rows.replaceChildren();
  let previousDate = null;
  for (const event of events) {
    const key = dateKey(event.scheduledAt, state.timezone);
    if (key !== previousDate) {
      elements.rows.append(dateHeadingRow(key, state.timezone));
      previousDate = key;
    }
    elements.rows.append(eventRow(event));
  }

  const empty = events.length === 0;
  elements.empty.hidden = !empty;
  elements.tableScroll.hidden = empty;
  elements.resultCount.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  elements.emptyCopy.textContent =
    state.feed.events.length === 0 && !demoMode
      ? "生产 feed 尚未加入经过核验并允许公开的数据。"
      : "调整日期、市场或搜索条件。";
}

function matchesSearch(event) {
  if (!state.query) {
    return true;
  }
  return [event.ticker, event.company, event.eventName, event.fiscalPeriod]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase()
    .includes(state.query);
}

function eventRow(event) {
  const row = document.createElement("tr");
  row.append(timeCell(event));

  const eventCell = document.createElement("td");
  eventCell.className = "event-cell";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "event-button";
  button.addEventListener("click", () => openDetails(event));

  const tickerLine = element("span", "ticker-line");
  tickerLine.append(document.createTextNode(`${event.market === "US" ? "🇺🇸" : "🇭🇰"} ${event.ticker}`));
  const confidence = element(
    "span",
    `confidence ${event.timeStatus === "CONFIRMED" ? "confirmed" : ""}`,
    event.timeStatus,
  );
  tickerLine.append(confidence);
  button.append(
    tickerLine,
    element("span", "company-name", event.company),
    element(
      "span",
      "event-name",
      [event.eventName, event.fiscalPeriod].filter(Boolean).join(" · "),
    ),
  );
  eventCell.append(button);
  row.append(eventCell);

  row.append(
    metricCell(event.eps?.actual, "eps", event.eps?.currency, "actual"),
    forecastCell(event.eps, "eps"),
    metricCell(event.revenue?.actual, "money", event.revenue?.currency, "actual"),
    forecastCell(event.revenue, "money"),
    metricCell(event.marketCap?.value, "money", event.marketCap?.currency),
    releaseCell(event),
  );
  return row;
}

function timeCell(event) {
  const cell = document.createElement("td");
  cell.className = "time-cell";
  if (event.dateOnly) {
    cell.textContent = "TBD";
    return cell;
  }
  cell.textContent = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: state.timezone,
  }).format(new Date(event.scheduledAt));
  return cell;
}

function metricCell(value, type, currency, modifier = "") {
  const cell = document.createElement("td");
  const missing = value === null || value === undefined || !Number.isFinite(Number(value));
  const metric = element(
    "span",
    `metric ${modifier} ${missing ? "missing" : ""}`.trim(),
    missing ? "—" : formatMetric(Number(value), type, currency),
  );
  cell.append(metric);
  return cell;
}

function forecastCell(metric, type) {
  const cell = metricCell(metric?.consensus, type, metric?.currency);
  if (metric?.ownForecast !== null && metric?.ownForecast !== undefined) {
    cell.append(
      element(
        "span",
        "own-forecast",
        `我的 ${formatMetric(Number(metric.ownForecast), type, metric.currency)}`,
      ),
    );
  }
  return cell;
}

function releaseCell(event) {
  const cell = document.createElement("td");
  const released = event.releaseState === "VERIFIED_RELEASED";
  const secondary = event.releaseState === "REPORTED_BY_SECONDARY_SOURCE";
  let label = sessionLabel(event.session);
  if (released) {
    label = "✓ Released";
  } else if (secondary) {
    label = "Unverified";
  }
  cell.append(element("span", `release-badge ${released ? "released" : ""}`, label));
  return cell;
}

function formatMetric(value, type, currency = "USD") {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (type === "eps") {
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000_000 ? 2 : 1,
  }).format(value);
}

function sessionLabel(session) {
  const labels = {
    BMO: "Before open",
    AMC: "After close",
    DURING_MARKET: "Market hours",
    TAS: "Time supplied",
    TNS: "Time not supplied",
    UNKNOWN: "Time TBD",
  };
  return labels[session] || "Time TBD";
}

function dateHeadingRow(key, timezone) {
  const row = document.createElement("tr");
  row.className = "date-row";
  const heading = document.createElement("th");
  heading.colSpan = 8;
  heading.scope = "rowgroup";
  heading.textContent = formatDateHeading(key, timezone);
  row.append(heading);
  return row;
}

function formatDateHeading(key, timezone) {
  const date = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  }).format(date);
}

function openDetails(event) {
  elements.dialogContent.replaceChildren();
  elements.dialogContent.append(
    element("p", "dialog-kicker", `${event.market === "US" ? "🇺🇸" : "🇭🇰"} ${event.ticker} · ${event.timeStatus}`),
    element("h2", "dialog-title", event.company, { id: "dialog-title" }),
    element(
      "p",
      "dialog-subtitle",
      [event.eventName, event.fiscalPeriod, sessionLabel(event.session)]
        .filter(Boolean)
        .join(" · "),
    ),
  );

  const metrics = document.createElement("dl");
  metrics.className = "detail-grid";
  addDetail(metrics, "EPS Actual", formatNullable(event.eps?.actual, "eps", event.eps?.currency));
  addDetail(metrics, "EPS Consensus", formatNullable(event.eps?.consensus, "eps", event.eps?.currency));
  addDetail(metrics, "My EPS Forecast", formatNullable(event.eps?.ownForecast, "eps", event.eps?.currency));
  addDetail(metrics, "Revenue Actual", formatNullable(event.revenue?.actual, "money", event.revenue?.currency));
  addDetail(metrics, "Revenue Consensus", formatNullable(event.revenue?.consensus, "money", event.revenue?.currency));
  addDetail(metrics, "My Revenue Forecast", formatNullable(event.revenue?.ownForecast, "money", event.revenue?.currency));
  addDetail(metrics, "Market Cap", formatNullable(event.marketCap?.value, "money", event.marketCap?.currency));
  addDetail(metrics, "Release State", event.releaseState.replaceAll("_", " "));
  elements.dialogContent.append(metrics);

  const timesSection = element("section", "dialog-section");
  timesSection.append(element("h3", "", "Event time"));
  const times = document.createElement("dl");
  times.className = "detail-grid";
  addDetail(times, `Original · ${event.originalTimezone}`, formatTimestamp(event.scheduledAt, event.originalTimezone, event.dateOnly));
  addDetail(times, "UTC", formatTimestamp(event.times?.utc, "UTC", event.dateOnly));
  addDetail(times, "New York", formatTimestamp(event.times?.newYork, "America/New_York", event.dateOnly));
  addDetail(times, "Hong Kong", formatTimestamp(event.times?.hongKong, "Asia/Hong_Kong", event.dateOnly));
  timesSection.append(times);
  elements.dialogContent.append(timesSection);

  const sourcesSection = element("section", "dialog-section");
  sourcesSection.append(element("h3", "", "Sources"));
  const list = document.createElement("ul");
  list.className = "source-list";
  for (const source of event.sources || []) {
    const item = document.createElement("li");
    const link = safeLink(source.url, source.name);
    item.append(link, document.createTextNode(` · ${source.kind}`));
    list.append(item);
  }
  sourcesSection.append(list);
  elements.dialogContent.append(sourcesSection);

  const note = element(
    "p",
    "dialog-note",
    event.dataStatus === "PUBLIC_REVIEWED"
      ? "该记录已进入公开审核层。事件是否发生以原始官方来源为准，不根据价格行为反推。"
      : "这是合成预览记录。真实事件必须核验原始来源、原始时区，并写入受治理事件日历。",
  );
  elements.dialogContent.append(note);
  elements.dialog.showModal();
}

function addDetail(list, label, value) {
  const card = document.createElement("div");
  card.className = "detail-card";
  card.append(element("dt", "", label), element("dd", "", value));
  list.append(card);
}

function formatNullable(value, type, currency) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "—"
    : formatMetric(Number(value), type, currency);
}

function formatTimestamp(value, timezone, dateOnly) {
  if (!value) {
    return "—";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }),
    timeZone: timezone,
    timeZoneName: dateOnly ? undefined : "short",
  }).format(new Date(value));
}

function safeLink(url, label) {
  const link = document.createElement("a");
  link.textContent = label || "Source";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("unsupported protocol");
    }
    link.href = parsed.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  } catch {
    link.removeAttribute("href");
  }
  return link;
}

function element(tag, className = "", text = "", attributes = {}) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined && text !== null) {
    node.textContent = text;
  }
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  return node;
}

function dateKey(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateRange(rangeName, timezone) {
  const today = dateKey(new Date(), timezone);
  if (rangeName === "recent") {
    return { start: addDays(today, -7), end: today };
  }
  if (rangeName === "today") {
    return { start: today, end: today };
  }
  if (rangeName === "tomorrow") {
    const tomorrow = addDays(today, 1);
    return { start: tomorrow, end: tomorrow };
  }
  if (rangeName === "this-month") {
    const [year, month] = today.split("-").map(Number);
    const last = new Date(Date.UTC(year, month, 0));
    return {
      start: `${year}-${String(month).padStart(2, "0")}-01`,
      end: last.toISOString().slice(0, 10),
    };
  }
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  const thisMonday = addDays(today, mondayOffset);
  const start = rangeName === "next-week" ? addDays(thisMonday, 7) : thisMonday;
  return { start, end: addDays(start, 6) };
}

function addDays(key, amount) {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
