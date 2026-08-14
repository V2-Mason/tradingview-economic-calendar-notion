import { readNewsProperty } from "./notion_company_news_sync_lib.mjs";

const SUPPORTED_MARKETS = new Set(["US", "HK"]);

export function selectDashboardNews(records, maxItems = 6) {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 20) {
    throw new Error("dashboard feed maxItems must be an integer from 1 to 20");
  }

  const byMarket = { US: [], HK: [] };
  const seenTickers = new Set();
  for (const record of records ?? []) {
    const item = projectRecord(record);
    if (!item || seenTickers.has(item.ticker)) {
      continue;
    }
    seenTickers.add(item.ticker);
    byMarket[item.market].push(item);
  }

  const selected = [];
  let index = 0;
  while (selected.length < maxItems) {
    let added = false;
    for (const market of ["US", "HK"]) {
      const candidate = byMarket[market][index];
      if (candidate && selected.length < maxItems) {
        selected.push(candidate);
        added = true;
      }
    }
    if (!added) {
      break;
    }
    index += 1;
  }
  return selected;
}

export function buildDashboardFeedChildren({
  items,
  fullNewsUrl,
  generatedAt,
  totalRecords,
}) {
  assertHttpUrl(fullNewsUrl, "dashboard feed fullNewsUrl");
  const children = (items ?? []).map((item) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      color: "default",
      rich_text: [
        textItem(`${marketIcon(item.market)} ${item.ticker}  `, {
          bold: true,
          color: item.market === "US" ? "blue" : "red",
        }),
        textItem(clip(item.headline, 180), { link: item.url }),
        textItem(`  · ${item.publishedRaw ?? "时间待确认"}`, { color: "gray" }),
      ],
    },
  }));

  children.push({ object: "block", type: "divider", divider: {} });
  children.push({
    object: "block",
    type: "paragraph",
    paragraph: {
      color: "default",
      rich_text: [
        textItem(`查看全部 ${totalRecords ?? 0} 条新闻 →`, {
          bold: true,
          color: "blue",
          link: fullNewsUrl,
        }),
        textItem(`  · Moomoo 发现层 / 待核验 · ${formatUtcMinute(generatedAt)}`, {
          color: "gray",
        }),
      ],
    },
  });
  return children;
}

export function buildDashboardFeedCallout(children) {
  return {
    object: "block",
    type: "callout",
    callout: {
      rich_text: [textItem("Top Stories", { bold: true })],
      icon: { type: "emoji", emoji: "📰" },
      color: "gray_background",
      children,
    },
  };
}

export function dashboardFeedMatches(existingBlocks, desiredBlocks) {
  return JSON.stringify((existingBlocks ?? []).map(canonicalBlock)) ===
    JSON.stringify((desiredBlocks ?? []).map(canonicalBlock));
}

export function canonicalBlock(block) {
  if (block?.type === "divider" || Object.hasOwn(block ?? {}, "divider")) {
    return { type: "divider" };
  }
  const type = block?.type;
  if (type !== "paragraph") {
    return { type: type ?? "unknown" };
  }
  const payload = block.paragraph ?? {};
  return {
    type,
    color: payload.color ?? "default",
    richText: (payload.rich_text ?? []).map((item) => ({
      content: item.plain_text ?? item.text?.content ?? "",
      link: item.href ?? item.text?.link?.url ?? null,
      bold: item.annotations?.bold ?? false,
      italic: item.annotations?.italic ?? false,
      color: item.annotations?.color ?? "default",
    })),
  };
}

function projectRecord(record) {
  const properties = record?.properties;
  if (!properties) {
    return null;
  }
  const market = readNewsProperty(properties.Market);
  const ticker = readNewsProperty(properties.Ticker);
  const headline = readNewsProperty(properties.Headline);
  const url = readNewsProperty(properties["Original URL"]);
  if (!SUPPORTED_MARKETS.has(market) || !ticker || !headline || !url) {
    return null;
  }
  assertHttpUrl(url, `dashboard news ${ticker} URL`);
  return {
    market,
    ticker,
    headline,
    url,
    publishedRaw: readNewsProperty(properties["Published Raw"]),
  };
}

function textItem(content, { bold = false, italic = false, color = "default", link } = {}) {
  return {
    type: "text",
    text: {
      content,
      link: link ? { url: link } : null,
    },
    annotations: {
      bold,
      italic,
      strikethrough: false,
      underline: false,
      code: false,
      color,
    },
  };
}

function marketIcon(market) {
  return market === "US" ? "🇺🇸" : "🇭🇰";
}

function clip(value, maxLength) {
  const text = String(value).trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function formatUtcMinute(value) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) {
    return "更新时间待确认";
  }
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function assertHttpUrl(value, field) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (!new Set(["https:", "http:"]).has(parsed.protocol)) {
    throw new Error(`${field} must use HTTP or HTTPS`);
  }
}
