import { readFile } from "node:fs/promises";

export const NEWS_EXPECTED_SCHEMA = Object.freeze({
  Headline: "title",
  "News Key": "rich_text",
  Ticker: "rich_text",
  Company: "rich_text",
  Summary: "rich_text",
  "Original Timezone": "rich_text",
  "Published Raw": "rich_text",
  Market: "select",
  "Published At": "date",
  "Fetched At": "date",
  "Last Seen": "date",
  Source: "select",
  "Source Tier": "select",
  Category: "select",
  "Original URL": "url",
  Verification: "select",
  Material: "checkbox",
  "Current Version": "checkbox",
  "Source Status": "select",
});

const MANAGED_PREFIXES = Object.freeze(["moomoo", "sec"]);
const CREATE_ONLY_PROPERTIES = new Set(["Fetched At"]);

export async function loadAndNormalizeCompanyNews(
  absolutePath,
  { maxAgeMinutes, now = new Date() } = {},
) {
  try {
    const envelope = JSON.parse(await readFile(absolutePath, "utf8"));
    assertFreshEnvelope({
      generatedAt: envelope.generatedAt,
      maxAgeMinutes,
      now,
    });
    const records = normalizeCompanyNewsEnvelope(envelope);
    return {
      valid: true,
      generatedAt: envelope.generatedAt,
      records,
      recordCount: records.length,
      managedPrefixes: [...MANAGED_PREFIXES],
      error: null,
    };
  } catch (error) {
    return {
      valid: false,
      generatedAt: null,
      records: [],
      recordCount: 0,
      managedPrefixes: [...MANAGED_PREFIXES],
      error: sanitizeError(error),
    };
  }
}

function assertFreshEnvelope({ generatedAt, maxAgeMinutes, now }) {
  if (maxAgeMinutes === undefined || maxAgeMinutes === null) {
    return;
  }
  const generatedMs = Date.parse(generatedAt ?? "");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(generatedMs) || !Number.isFinite(nowMs)) {
    throw new Error("company-news staging generatedAt is invalid");
  }
  const ageMinutes = (nowMs - generatedMs) / 60000;
  if (ageMinutes < -5) {
    throw new Error("company-news staging generatedAt is in the future");
  }
  if (ageMinutes > maxAgeMinutes) {
    throw new Error(
      `company-news staging is stale (${Math.floor(ageMinutes)} minutes old; limit ${maxAgeMinutes})`,
    );
  }
}

export function normalizeCompanyNewsEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.news)) {
    throw new Error("company-news staging must contain a news array");
  }
  const seen = new Set();
  return envelope.news.map((record, index) => {
    const normalized = normalizeCompanyNewsRecord(record, index);
    if (seen.has(normalized.newsKey)) {
      throw new Error(`company-news staging contains duplicate News Key ${normalized.newsKey}`);
    }
    seen.add(normalized.newsKey);
    return normalized;
  });
}

export function normalizeCompanyNewsRecord(record, index = 0) {
  if (!record || typeof record !== "object") {
    throw new Error(`company-news record ${index} must be an object`);
  }
  const id = requiredText(record.id, `news ${index}.id`);
  const discoveredBy = requiredText(record.discoveredBy, `news ${id}.discoveredBy`);
  const sourceProjection = projectSource(discoveredBy);
  const market = requiredText(record.market, `news ${id}.market`).toUpperCase();
  if (!new Set(["US", "HK"]).has(market)) {
    throw new Error(`news ${id} has unsupported market ${market}`);
  }
  const ticker = requiredText(record.ticker, `news ${id}.ticker`);
  const company = requiredText(record.company, `news ${id}.company`);
  const headline = requiredText(record.title, `news ${id}.title`);
  const fetchedAt = isoDateTimeOrNull(record.fetchedAt, `news ${id}.fetchedAt`);
  const publishedRaw = optionalText(record.publishedAtRaw ?? record.publishedAt);
  const publishedAt = safePublishedDate(optionalText(record.publishedAt));
  const newsKey = `${sourceProjection.keyPrefix}:${id}`;
  const providerMetadata = optionalText(record.source);
  const related = Array.isArray(record.relatedSecurities)
    ? record.relatedSecurities.map(optionalText).filter(Boolean)
    : [];
  const summaryParts = [
    providerMetadata ? `Provider metadata: ${providerMetadata}` : null,
    `Discovered by: ${discoveredBy}`,
    related.length > 0 ? `Related: ${related.join(", ")}` : null,
  ].filter(Boolean);

  return {
    newsKey,
    keyPrefix: sourceProjection.keyPrefix,
    properties: {
      Headline: titleProperty(headline),
      "News Key": richTextProperty(newsKey),
      Ticker: richTextProperty(ticker),
      Company: richTextProperty(company),
      Summary: richTextProperty(summaryParts.join("; ")),
      "Original Timezone": richTextProperty(null),
      "Published Raw": richTextProperty(publishedRaw),
      Market: selectProperty(market),
      "Published At": dateProperty(publishedAt),
      "Fetched At": dateProperty(fetchedAt),
      "Last Seen": dateProperty(fetchedAt),
      Source: selectProperty(sourceProjection.source),
      "Source Tier": selectProperty(sourceProjection.tier),
      Category: selectProperty(sourceProjection.category),
      "Original URL": urlProperty(validHttpUrl(record.url, `news ${id}.url`)),
      Verification: selectProperty("Unverified"),
      "Current Version": checkboxProperty(true),
      "Source Status": selectProperty("Ready"),
    },
  };
}

export function buildCompanyNewsUpsertPlan({ normalized, existingPages }) {
  const existingByKey = indexExisting(existingPages);
  const active = new Set();
  const operations = [];

  for (const record of normalized.records) {
    active.add(record.newsKey);
    const existing = existingByKey.get(record.newsKey);
    if (!existing) {
      operations.push({
        kind: "create",
        newsKey: record.newsKey,
        properties: record.properties,
      });
      continue;
    }
    const changed = diffProperties(existing.properties ?? {}, record.properties);
    if (Object.keys(changed).length > 0) {
      operations.push({
        kind: "update",
        newsKey: record.newsKey,
        pageId: existing.id,
        properties: changed,
      });
    }
  }

  for (const [newsKey, existing] of existingByKey) {
    const prefix = newsKey.split(":", 1)[0];
    if (!normalized.managedPrefixes.includes(prefix) || active.has(newsKey)) {
      continue;
    }
    if (readNewsProperty(existing.properties?.["Source Status"]) === "Stale") {
      continue;
    }
    operations.push({
      kind: "stale",
      newsKey,
      pageId: existing.id,
      properties: {
        "Source Status": selectProperty("Stale"),
      },
    });
  }

  const counts = { create: 0, update: 0, stale: 0 };
  for (const operation of operations) {
    counts[operation.kind] += 1;
  }
  return {
    operations,
    counts,
    unchanged:
      active.size - operations.filter((operation) => operation.kind !== "stale").length,
  };
}

export function validateCompanyNewsSchema(dataSource) {
  const properties = dataSource?.properties;
  if (!properties || typeof properties !== "object") {
    throw new Error("Notion company-news data source response does not contain properties");
  }
  const mismatches = [];
  for (const [name, expectedType] of Object.entries(NEWS_EXPECTED_SCHEMA)) {
    const actualType = properties[name]?.type;
    if (actualType !== expectedType) {
      mismatches.push(`${name}: expected ${expectedType}, got ${actualType ?? "missing"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Notion company-news schema mismatch: ${mismatches.join("; ")}`);
  }
}

export function readNewsProperty(property) {
  if (!property || typeof property !== "object") {
    return null;
  }
  if (Object.hasOwn(property, "title")) {
    return plainText(property.title);
  }
  if (Object.hasOwn(property, "rich_text")) {
    return plainText(property.rich_text);
  }
  if (Object.hasOwn(property, "select")) {
    return property.select?.name ?? null;
  }
  if (Object.hasOwn(property, "date")) {
    return property.date
      ? {
          start: canonicalDateValue(property.date.start),
          end: canonicalDateValue(property.date.end),
        }
      : null;
  }
  if (Object.hasOwn(property, "checkbox")) {
    return Boolean(property.checkbox);
  }
  if (Object.hasOwn(property, "url")) {
    return property.url ?? null;
  }
  return null;
}

function canonicalDateValue(value) {
  if (!value) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const timestamp = Date.parse(value);
  // Notion database date properties are returned at minute precision even
  // when the submitted ISO value included seconds or milliseconds.
  return Number.isFinite(timestamp)
    ? new Date(Math.floor(timestamp / 60000) * 60000).toISOString()
    : value;
}

function projectSource(discoveredBy) {
  if (discoveredBy === "MOOMOO_SEARCH_NEWS") {
    return {
      keyPrefix: "moomoo",
      source: "Moomoo",
      tier: "Discovery",
      category: "Other",
    };
  }
  if (discoveredBy === "SEC_SUBMISSIONS_API") {
    return {
      keyPrefix: "sec",
      source: "SEC",
      tier: "Primary",
      category: "Filing",
    };
  }
  throw new Error(`unsupported news discovery source ${discoveredBy}`);
}

function safePublishedDate(value) {
  if (!value) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && Number.isFinite(Date.parse(value))
  ) {
    return value;
  }
  return null;
}

function isoDateTimeOrNull(value, field) {
  const text = optionalText(value);
  if (!text) {
    return null;
  }
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`${field} must be an ISO date-time`);
  }
  return text;
}

function validHttpUrl(value, field) {
  const text = requiredText(value, field);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error(`${field} must use HTTP or HTTPS`);
  }
  return parsed.toString();
}

function indexExisting(pages) {
  const index = new Map();
  for (const page of pages ?? []) {
    const key = readNewsProperty(page?.properties?.["News Key"]);
    if (!key) {
      continue;
    }
    if (index.has(key)) {
      throw new Error(`Notion contains duplicate News Key ${key}`);
    }
    index.set(key, page);
  }
  return index;
}

function diffProperties(existing, desired) {
  const changed = {};
  for (const [name, desiredProperty] of Object.entries(desired)) {
    if (CREATE_ONLY_PROPERTIES.has(name)) {
      continue;
    }
    if (!deepEqual(readNewsProperty(existing[name]), readNewsProperty(desiredProperty))) {
      changed[name] = desiredProperty;
    }
  }
  return changed;
}

function titleProperty(value) {
  return { title: [{ type: "text", text: { content: clipText(value) } }] };
}

function richTextProperty(value) {
  return {
    rich_text: value
      ? [{ type: "text", text: { content: clipText(value) } }]
      : [],
  };
}

function selectProperty(value) {
  return { select: value ? { name: value } : null };
}

function dateProperty(value) {
  return { date: value ? { start: value } : null };
}

function checkboxProperty(value) {
  return { checkbox: Boolean(value) };
}

function urlProperty(value) {
  return { url: value ?? null };
}

function plainText(items) {
  if (!Array.isArray(items)) {
    return "";
  }
  return items.map((item) => item?.plain_text ?? item?.text?.content ?? "").join("");
}

function requiredText(value, field) {
  const text = optionalText(value);
  if (!text) {
    throw new Error(`${field} is required`);
  }
  return text;
}

function optionalText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function clipText(value) {
  const text = String(value);
  return text.length > 1900 ? text.slice(0, 1900) : text;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
