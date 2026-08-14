import { readFile } from "node:fs/promises";

export const PRESERVED_PROPERTIES = Object.freeze([
  "My EPS Forecast",
  "My Revenue Forecast",
]);

export const EXPECTED_SCHEMA = Object.freeze({
  Event: "title",
  "Event Key": "rich_text",
  Company: "rich_text",
  Ticker: "rich_text",
  Market: "select",
  Source: "select",
  "Source Status": "select",
  "Event Time": "date",
  "Fetched At": "date",
  "Last Seen": "date",
  "Source Publication Time": "date",
  "Original Timezone": "rich_text",
  "UTC Display": "rich_text",
  "New York Display": "rich_text",
  "Hong Kong Display": "rich_text",
  "Release Session": "select",
  "Release State": "select",
  "Time Confidence": "select",
  Verification: "select",
  "Current Version": "checkbox",
  "EPS Actual": "number",
  "EPS Consensus": "number",
  "Revenue Actual": "number",
  "Revenue Consensus": "number",
  "Market Cap": "number",
  "Source URL": "url",
  "My EPS Forecast": "number",
  "My Revenue Forecast": "number",
});

const SOURCE_DEFINITIONS = Object.freeze({
  moomoo: Object.freeze({
    eventKeyPrefix: "moomoo",
    sourceLabel: "Moomoo",
  }),
  yahoo: Object.freeze({
    eventKeyPrefix: "yahoo",
    sourceLabel: "Yahoo (unofficial)",
  }),
});

const RELEASED_STATES = new Set([
  "RELEASED",
  "REPORTED",
  "REPORTED_BY_SECONDARY_SOURCE",
  "COMPLETED",
]);

const CONFIRMED_DATA_STATES = new Set([
  "CONFIRMED",
  "VERIFIED",
  "PUBLIC_REVIEWED",
]);

export async function readSyncConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw);
  assertNoSecrets(config);
  validateSyncConfig(config);
  return config;
}

export async function loadAndNormalizeSource({
  sourceId,
  sourceConfig,
  absolutePath,
  now = new Date(),
}) {
  const definition = resolveSourceDefinition(sourceId, sourceConfig);
  try {
    const raw = await readFile(absolutePath, "utf8");
    const envelope = JSON.parse(raw);
    assertFreshEnvelope({
      sourceId,
      generatedAt: envelope.generatedAt,
      maxAgeMinutes: sourceConfig.maxAgeMinutes,
      now,
    });
    const normalized = normalizeEnvelope({
      sourceId,
      sourceConfig: definition,
      envelope,
    });
    return {
      sourceId,
      ...definition,
      valid: true,
      eventCount: normalized.length,
      events: normalized,
      error: null,
    };
  } catch (error) {
    return {
      sourceId,
      ...definition,
      valid: false,
      eventCount: 0,
      events: [],
      error: sanitizeError(error),
    };
  }
}

export function normalizeEnvelope({ sourceId, sourceConfig, envelope }) {
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.events)) {
    throw new Error(`${sourceId} staging must contain an events array`);
  }

  const seen = new Set();
  return envelope.events.map((event, index) => {
    const normalized = normalizeEvent({
      sourceId,
      sourceConfig,
      envelope,
      event,
      index,
    });
    if (seen.has(normalized.eventKey)) {
      throw new Error(`${sourceId} staging contains duplicate event key ${normalized.eventKey}`);
    }
    seen.add(normalized.eventKey);
    return normalized;
  });
}

export function normalizeEvent({
  sourceId,
  sourceConfig,
  envelope,
  event,
  index = 0,
}) {
  if (!event || typeof event !== "object") {
    throw new Error(`${sourceId} event ${index} must be an object`);
  }

  const id = requiredText(event.id, `${sourceId} event ${index}.id`);
  const market = requiredText(event.market, `${sourceId} event ${id}.market`).toUpperCase();
  if (!new Set(["US", "HK"]).has(market)) {
    throw new Error(`${sourceId} event ${id} has unsupported market ${market}`);
  }

  const ticker = requiredText(event.ticker, `${sourceId} event ${id}.ticker`);
  const company = requiredText(event.company, `${sourceId} event ${id}.company`);
  const eventKey = `${sourceConfig.eventKeyPrefix}:${id}`;
  const source = selectPrimarySource(event.sources);
  const fetchedAt = firstIsoDateTime(
    source?.fetchedAt,
    envelope.generatedAt,
  );
  const sourcePublicationTime = firstIsoDateTime(
    event.sourcePublicationTime,
    source?.publishedAt,
    source?.publicationTime,
  );
  const eventTime = normalizeEventTime(event);
  const materializedTimes = event.dateOnly === true ? {} : (event.times ?? {});

  const properties = {
    Event: titleProperty(`${ticker} | ${company}`),
    "Event Key": richTextProperty(eventKey),
    Company: richTextProperty(company),
    Ticker: richTextProperty(ticker),
    Market: selectProperty(market),
    Source: selectProperty(sourceConfig.sourceLabel),
    "Source Status": selectProperty("Ready"),
    "Event Time": dateProperty(eventTime),
    "Fetched At": dateProperty(fetchedAt),
    "Last Seen": dateProperty(fetchedAt),
    "Source Publication Time": dateProperty(sourcePublicationTime),
    "Original Timezone": richTextProperty(optionalText(event.originalTimezone)),
    "UTC Display": richTextProperty(optionalText(materializedTimes.utc)),
    "New York Display": richTextProperty(optionalText(materializedTimes.newYork)),
    "Hong Kong Display": richTextProperty(optionalText(materializedTimes.hongKong)),
    "Release Session": selectProperty(mapSession(event.session)),
    "Release State": selectProperty(mapReleaseState(event.releaseState)),
    "Time Confidence": selectProperty(mapTimeConfidence(event)),
    Verification: selectProperty(mapVerification(event.dataStatus)),
    "Current Version": checkboxProperty(true),
    "EPS Actual": numberProperty(finiteOrNull(event.eps?.actual, `${eventKey}.eps.actual`)),
    "EPS Consensus": numberProperty(
      finiteOrNull(event.eps?.consensus, `${eventKey}.eps.consensus`),
    ),
    "Revenue Actual": numberProperty(
      finiteOrNull(event.revenue?.actual, `${eventKey}.revenue.actual`),
    ),
    "Revenue Consensus": numberProperty(
      finiteOrNull(event.revenue?.consensus, `${eventKey}.revenue.consensus`),
    ),
    "Market Cap": numberProperty(
      finiteOrNull(event.marketCap?.value, `${eventKey}.marketCap.value`),
    ),
    "Source URL": urlProperty(optionalUrl(source?.url)),
  };

  for (const protectedName of PRESERVED_PROPERTIES) {
    if (Object.hasOwn(properties, protectedName)) {
      throw new Error(`protected property ${protectedName} must never be source-managed`);
    }
  }

  return {
    sourceId,
    eventKeyPrefix: sourceConfig.eventKeyPrefix,
    eventKey,
    properties,
  };
}

export function buildUpsertPlan({ sourceResults, existingPages }) {
  const existingByKey = indexExistingPages(existingPages);
  const operations = [];
  const activeKeys = new Set();

  for (const sourceResult of sourceResults) {
    for (const event of sourceResult.events) {
      if (activeKeys.has(event.eventKey)) {
        throw new Error(`duplicate normalized event key ${event.eventKey}`);
      }
      activeKeys.add(event.eventKey);
      const existing = existingByKey.get(event.eventKey);
      if (!existing) {
        operations.push({
          kind: "create",
          sourceId: sourceResult.sourceId,
          eventKey: event.eventKey,
          properties: event.properties,
        });
        continue;
      }

      const changed = diffProperties(existing.properties ?? {}, event.properties);
      if (Object.keys(changed).length > 0) {
        operations.push({
          kind: "update",
          sourceId: sourceResult.sourceId,
          eventKey: event.eventKey,
          pageId: existing.id,
          properties: changed,
        });
      }
    }

    const prefix = `${sourceResult.eventKeyPrefix}:`;
    for (const [eventKey, existing] of existingByKey) {
      if (!eventKey.startsWith(prefix) || activeKeys.has(eventKey)) {
        continue;
      }
      if (readPropertyValue(existing.properties?.["Source Status"]) === "Stale") {
        continue;
      }
      operations.push({
        kind: "stale",
        sourceId: sourceResult.sourceId,
        eventKey,
        pageId: existing.id,
        properties: {
          "Source Status": selectProperty("Stale"),
        },
      });
    }
  }

  return {
    operations,
    counts: countOperations(operations),
    unchanged: activeKeys.size - operations.filter((item) => item.kind !== "stale").length,
  };
}

export function validateDataSourceSchema(dataSource) {
  const properties = dataSource?.properties;
  if (!properties || typeof properties !== "object") {
    throw new Error("Notion data source response does not contain properties");
  }

  const mismatches = [];
  for (const [name, expectedType] of Object.entries(EXPECTED_SCHEMA)) {
    const actualType = properties[name]?.type;
    if (actualType !== expectedType) {
      mismatches.push(`${name}: expected ${expectedType}, got ${actualType ?? "missing"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Notion data source schema mismatch: ${mismatches.join("; ")}`);
  }
}

export function readPropertyValue(property) {
  if (!property || typeof property !== "object") {
    return null;
  }
  if (property.type === "title" || Object.hasOwn(property, "title")) {
    return plainText(property.title);
  }
  if (property.type === "rich_text" || Object.hasOwn(property, "rich_text")) {
    return plainText(property.rich_text);
  }
  if (property.type === "number" || Object.hasOwn(property, "number")) {
    return property.number ?? null;
  }
  if (property.type === "select" || Object.hasOwn(property, "select")) {
    return property.select?.name ?? null;
  }
  if (property.type === "date" || Object.hasOwn(property, "date")) {
    return property.date
      ? {
          start: canonicalDateValue(property.date.start),
          end: canonicalDateValue(property.date.end),
          time_zone: property.date.time_zone ?? null,
        }
      : null;
  }
  if (property.type === "checkbox" || Object.hasOwn(property, "checkbox")) {
    return Boolean(property.checkbox);
  }
  if (property.type === "url" || Object.hasOwn(property, "url")) {
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

export function assertNoSecrets(value, path = "config") {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/(?:token|secret|api[_-]?key|authorization|password)/i.test(key)) {
      throw new Error(`${path}.${key} is forbidden; ntn must use the user's keychain`);
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function validateSyncConfig(config) {
  if (config.schemaVersion !== "1.0.0") {
    throw new Error("notion sync config schemaVersion must be 1.0.0");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    config.dataSourceId ?? "",
  )) {
    throw new Error("notion sync config dataSourceId must be a UUID");
  }
  if (!/^ntn@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(config.notionCliPackage ?? "")) {
    throw new Error("notionCliPackage must pin an ntn version, for example ntn@0.22.3");
  }
  if (!config.sources || typeof config.sources !== "object") {
    throw new Error("notion sync config must define sources");
  }
  for (const sourceId of ["moomoo", "yahoo"]) {
    const source = config.sources[sourceId];
    if (!source || !optionalText(source.stagingFile)) {
      throw new Error(`notion sync config must define sources.${sourceId}.stagingFile`);
    }
    if (!Number.isFinite(source.maxAgeMinutes) || source.maxAgeMinutes <= 0) {
      throw new Error(`sources.${sourceId}.maxAgeMinutes must be a positive number`);
    }
  }
}

function assertFreshEnvelope({ sourceId, generatedAt, maxAgeMinutes, now }) {
  if (maxAgeMinutes === undefined || maxAgeMinutes === null) {
    return;
  }
  const generatedMs = Date.parse(generatedAt ?? "");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(generatedMs) || !Number.isFinite(nowMs)) {
    throw new Error(`${sourceId} staging generatedAt is invalid`);
  }
  const ageMinutes = (nowMs - generatedMs) / 60000;
  if (ageMinutes < -5) {
    throw new Error(`${sourceId} staging generatedAt is in the future`);
  }
  if (ageMinutes > maxAgeMinutes) {
    throw new Error(
      `${sourceId} staging is stale (${Math.floor(ageMinutes)} minutes old; limit ${maxAgeMinutes})`,
    );
  }
}

function resolveSourceDefinition(sourceId, sourceConfig = {}) {
  const base = SOURCE_DEFINITIONS[sourceId];
  if (!base) {
    throw new Error(`unsupported source ${sourceId}`);
  }
  const eventKeyPrefix = optionalText(sourceConfig.eventKeyPrefix) ?? base.eventKeyPrefix;
  const sourceLabel = optionalText(sourceConfig.sourceLabel) ?? base.sourceLabel;
  if (!/^[a-z][a-z0-9_-]*$/.test(eventKeyPrefix)) {
    throw new Error(`invalid event key prefix for ${sourceId}`);
  }
  if (sourceLabel !== base.sourceLabel) {
    throw new Error(`source label for ${sourceId} must be ${base.sourceLabel}`);
  }
  return { eventKeyPrefix, sourceLabel };
}

function indexExistingPages(existingPages) {
  const index = new Map();
  for (const page of existingPages ?? []) {
    const key = readPropertyValue(page?.properties?.["Event Key"]);
    if (!key) {
      continue;
    }
    if (index.has(key)) {
      throw new Error(`Notion contains duplicate Event Key ${key}`);
    }
    index.set(key, page);
  }
  return index;
}

function diffProperties(existingProperties, desiredProperties) {
  const changed = {};
  for (const [name, desired] of Object.entries(desiredProperties)) {
    if (PRESERVED_PROPERTIES.includes(name)) {
      continue;
    }
    const existingValue = readPropertyValue(existingProperties[name]);
    const desiredValue = readPropertyValue(desired);
    if (!deepEqual(existingValue, desiredValue)) {
      changed[name] = desired;
    }
  }
  return changed;
}

function countOperations(operations) {
  const counts = { create: 0, update: 0, stale: 0 };
  for (const operation of operations) {
    counts[operation.kind] += 1;
  }
  return counts;
}

function normalizeEventTime(event) {
  const scheduledAt = optionalText(event.scheduledAt);
  if (!scheduledAt) {
    return null;
  }
  if (event.dateOnly === true) {
    const match = scheduledAt.match(/^\d{4}-\d{2}-\d{2}/);
    if (!match) {
      throw new Error(`date-only event ${event.id} has invalid scheduledAt`);
    }
    return match[0];
  }
  if (!Number.isFinite(Date.parse(scheduledAt))) {
    throw new Error(`event ${event.id} has invalid scheduledAt`);
  }
  return scheduledAt;
}

function mapSession(value) {
  const normalized = optionalText(value)?.toUpperCase();
  if (["BMO", "BEFORE_OPEN", "BEFORE MARKET OPEN"].includes(normalized)) {
    return "Before Open";
  }
  if (["AMC", "AFTER_CLOSE", "AFTER MARKET CLOSE"].includes(normalized)) {
    return "After Close";
  }
  if (["DURING_SESSION", "DURING MARKET"].includes(normalized)) {
    return "During Session";
  }
  return "Unknown";
}

function mapReleaseState(value) {
  const normalized = optionalText(value)?.toUpperCase();
  if (normalized === "UPCOMING") {
    return "Upcoming";
  }
  if (RELEASED_STATES.has(normalized)) {
    return "Released";
  }
  return "Unknown";
}

function mapTimeConfidence(event) {
  if (event.dateOnly === true) {
    return "Date Only";
  }
  const normalized = optionalText(event.timeStatus)?.toUpperCase();
  if (normalized === "CONFIRMED") {
    return "Confirmed";
  }
  if (normalized === "ESTIMATED") {
    return "Estimated";
  }
  return "TBD";
}

function mapVerification(value) {
  const normalized = optionalText(value)?.toUpperCase();
  if (CONFIRMED_DATA_STATES.has(normalized)) {
    return "Confirmed";
  }
  if (["UNVERIFIED", "UNVERIFIED_SECONDARY"].includes(normalized)) {
    return "Unverified";
  }
  return "Review Required";
}

function selectPrimarySource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }
  return sources.find((source) => source && typeof source === "object") ?? null;
}

function firstIsoDateTime(...values) {
  for (const value of values) {
    const text = optionalText(value);
    if (!text) {
      continue;
    }
    if (!Number.isFinite(Date.parse(text))) {
      throw new Error(`invalid ISO date-time ${text}`);
    }
    return text;
  }
  return null;
}

function optionalUrl(value) {
  const text = optionalText(value);
  if (!text) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`invalid source URL ${text}`);
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new Error(`unsupported source URL protocol ${parsed.protocol}`);
  }
  return parsed.toString();
}

function finiteOrNull(value, field) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number or null`);
  }
  return value;
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
  return text.length > 0 ? text : null;
}

function titleProperty(value) {
  return {
    title: value ? [{ type: "text", text: { content: clipText(value) } }] : [],
  };
}

function richTextProperty(value) {
  return {
    rich_text: value ? [{ type: "text", text: { content: clipText(value) } }] : [],
  };
}

function numberProperty(value) {
  return { number: value };
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
  return items
    .map((item) => item?.plain_text ?? item?.text?.content ?? "")
    .join("");
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
