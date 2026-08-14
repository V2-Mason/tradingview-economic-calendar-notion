"""Build a private, read-only Moomoo earnings-calendar snapshot.

This collector only opens a quote connection to loopback OpenD. It does not
open a trade context, unlock trading, read account data, or submit orders.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import time as time_module
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from futu import Market, OpenQuoteContext, RET_OK


ROOT = Path(__file__).resolve().parents[1]
MARKET_TIMEZONES = {
    "US": "America/New_York",
    "HK": "Asia/Hong_Kong",
}
PUB_TYPE_TO_SESSION = {
    "BEFORE": "BMO",
    "AFTER": "AMC",
    "REGULAR": "DURING_MARKET",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--watchlist",
        type=Path,
        default=ROOT / ".private" / "watchlist.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / ".private" / "moomoo-earnings-staging.json",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11111)
    parser.add_argument("--days-back", type=int, default=30)
    parser.add_argument("--days-forward", type=int, default=120)
    return parser.parse_args()


def finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    candidate = str(value).strip()
    return None if candidate in {"", "N/A", "None", "nan", "NaN"} else candidate


def zoned_iso(value: datetime, timezone: str) -> str:
    return value.astimezone(ZoneInfo(timezone)).isoformat(timespec="seconds")


def moomoo_security(item: dict[str, Any]) -> str:
    market = item["market"].upper()
    ticker = str(item["ticker"]).upper()
    if market == "HK":
        digits = ticker.removesuffix(".HK")
        return f"HK.{int(digits):05d}"
    return f"US.{ticker.removeprefix('US.')}"


def stable_id(market: str, security: str, earnings_date: str) -> str:
    digest = hashlib.sha256(
        f"MOOMOO|{market}|{security}|{earnings_date}".encode("utf-8")
    ).hexdigest()[:16]
    return f"MM-{market}-{security.replace('.', '-')}-{digest}"


def date_chunks(start: date, end: date):
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=6), end)
        yield cursor, chunk_end
        cursor = chunk_end + timedelta(days=1)


def build_event(
    item: dict[str, Any], row: dict[str, Any], collected_at: datetime
) -> dict[str, Any] | None:
    earnings_date_text = clean_text(row.get("earnings_date"))
    if not earnings_date_text:
        return None
    try:
        earnings_date = date.fromisoformat(earnings_date_text)
    except ValueError:
        return None

    market = item["market"].upper()
    original_timezone = MARKET_TIMEZONES[market]
    pub_type = (clean_text(row.get("pub_type")) or "UNKNOWN").upper()
    timestamp = finite_number(row.get("earnings_timestamp"))
    timestamp_available = timestamp is not None and timestamp > 0
    provider_instant = (
        datetime.fromtimestamp(timestamp, tz=UTC) if timestamp_available else None
    )
    provider_local = (
        provider_instant.astimezone(ZoneInfo(original_timezone))
        if provider_instant
        else None
    )
    placeholder_midnight = bool(
        provider_local
        and provider_local.hour == 0
        and provider_local.minute == 0
        and provider_local.second == 0
        and pub_type in {"REGULAR", "UNKNOWN"}
    )
    date_only = not timestamp_available or placeholder_midnight
    if date_only:
        local_value = datetime.combine(
            earnings_date,
            time(hour=12),
            tzinfo=ZoneInfo(original_timezone),
        )
        instant = local_value.astimezone(UTC)
    else:
        instant = provider_instant
        local_value = instant.astimezone(ZoneInfo(original_timezone))

    session = "UNKNOWN" if placeholder_midnight else PUB_TYPE_TO_SESSION.get(pub_type, "UNKNOWN")
    eps_actual = finite_number(row.get("eps_actual"))
    revenue_actual = finite_number(row.get("revenue_actual"))
    has_actual = eps_actual is not None or revenue_actual is not None
    company = item.get("companyName") or clean_text(row.get("name")) or item["ticker"]
    # The current Python wrapper flattens estimate values but omits the
    # estimate currency carried by the protocol. Do not infer it from venue.
    forecast_currency = "XXX"
    market_currency = "HKD" if market == "HK" else "USD"
    security = clean_text(row.get("security")) or moomoo_security(item)

    return {
        "id": stable_id(market, security, earnings_date_text),
        "market": market,
        "ticker": item["ticker"],
        "issuerKey": item.get("issuerKey"),
        "scopeTags": item.get("scopeTags", []),
        "company": company,
        "eventName": f"{company} earnings announcement",
        "fiscalPeriod": clean_text(row.get("period_text")),
        "scheduledAt": local_value.isoformat(timespec="seconds"),
        "originalTimezone": original_timezone,
        "dateOnly": date_only,
        "timeStatus": "ESTIMATED",
        "session": session,
        "releaseState": "REPORTED_BY_SECONDARY_SOURCE" if has_actual else "UPCOMING",
        "times": {
            "utc": instant.isoformat(timespec="seconds").replace("+00:00", "Z"),
            "newYork": zoned_iso(instant, "America/New_York"),
            "hongKong": zoned_iso(instant, "Asia/Hong_Kong"),
        },
        "eps": {
            "actual": eps_actual,
            "consensus": finite_number(row.get("eps_predict")),
            "ownForecast": finite_number(item.get("ownForecast", {}).get("eps")),
            "currency": forecast_currency,
            "surprisePercent": None,
        },
        "revenue": {
            "actual": revenue_actual,
            "consensus": finite_number(row.get("revenue_predict")),
            "ownForecast": finite_number(item.get("ownForecast", {}).get("revenue")),
            "currency": forecast_currency,
        },
        "marketCap": {
            "value": finite_number(row.get("market_cap")),
            "currency": market_currency,
            "asOf": collected_at.isoformat().replace("+00:00", "Z"),
        },
        "sources": [
            {
                "name": "Moomoo OpenAPI Earnings Calendar",
                "kind": "LICENSED_PROVIDER",
                "url": "https://openapi.moomoo.com/moomoo-api-doc/quote/get-earnings-calendar.html",
                "fetchedAt": collected_at.isoformat().replace("+00:00", "Z"),
            }
        ],
        "dataStatus": "UNVERIFIED_SECONDARY",
        "redistributionStatus": "PERSONAL_USE_ONLY",
        "publicReleaseApproved": False,
    }


def main() -> None:
    args = parse_args()
    if args.host != "127.0.0.1":
        raise SystemExit("Moomoo collector is restricted to loopback OpenD at 127.0.0.1")
    if args.days_back < 0 or args.days_forward < 0:
        raise SystemExit("date-window arguments must be non-negative")

    watchlist = json.loads(args.watchlist.read_text(encoding="utf-8"))
    items = watchlist.get("tickers")
    if not isinstance(items, list) or not items:
        raise SystemExit("watchlist must contain a non-empty tickers array")

    watched = {moomoo_security(item): item for item in items}
    collected_at = datetime.now(UTC)
    window_start = collected_at.date() - timedelta(days=args.days_back)
    window_end = collected_at.date() + timedelta(days=args.days_forward)
    rows_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    collection_errors: list[dict[str, Any]] = []
    successful_requests = 0

    quote_ctx = OpenQuoteContext(host=args.host, port=args.port)
    try:
        for market_name, market in (("HK", Market.HK), ("US", Market.US)):
            if not any(item["market"].upper() == market_name for item in items):
                continue
            for begin, end in date_chunks(window_start, window_end):
                request_started = time_module.monotonic()
                ret, data = quote_ctx.get_earnings_calendar(
                    market=market,
                    begin_date=begin.isoformat(),
                    end_date=end.isoformat(),
                )
                if ret != RET_OK:
                    collection_errors.append(
                        {
                            "market": market_name,
                            "begin": begin.isoformat(),
                            "end": end.isoformat(),
                            "message": str(data)[:300],
                        }
                    )
                    time_module.sleep(max(0.0, 0.55 - (time_module.monotonic() - request_started)))
                    continue
                successful_requests += 1
                for row in data.to_dict(orient="records"):
                    security = (clean_text(row.get("security")) or "").upper()
                    if security in watched:
                        rows_by_key[(security, str(row.get("earnings_date")))] = row
                time_module.sleep(max(0.0, 0.55 - (time_module.monotonic() - request_started)))
    finally:
        quote_ctx.close()

    if successful_requests == 0:
        raise SystemExit("OpenD returned no successful earnings-calendar request; existing snapshot preserved")
    if collection_errors:
        raise SystemExit(
            f"OpenD returned {len(collection_errors)} failed date windows; existing snapshot preserved"
        )

    events = []
    for (security, _), row in rows_by_key.items():
        event = build_event(watched[security], row, collected_at)
        if event:
            events.append(event)
    events.sort(key=lambda event: event["times"]["utc"])

    document = {
        "schemaVersion": "1.0.0",
        "generatedAt": collected_at.isoformat().replace("+00:00", "Z"),
        "dataPolicy": "MOOMOO_PERSONAL_STAGING_ONLY",
        "collector": "MOOMOO_OPEND_EARNINGS_CALENDAR_READ_ONLY",
        "window": {"start": window_start.isoformat(), "end": window_end.isoformat()},
        "coverage": {
            "tickersRequested": len(items),
            "tickersWithEvent": len({event["ticker"] for event in events}),
            "events": len(events),
            "successfulRequests": successful_requests,
            "failedRequests": len(collection_errors),
        },
        "events": events,
        "collectionErrors": collection_errors,
        "limitations": [
            "Moomoo data is a private personal-use snapshot and is never committed to public GitHub Pages.",
            "An earnings timestamp or BEFORE/AFTER label is provider data, not issuer confirmation.",
            "Event occurrence is never inferred from price action.",
            "Issuer IR, SEC, or HKEX remains authoritative for the date, original timezone, and release state.",
        ],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(json.dumps({"output": str(args.output), **document["coverage"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
