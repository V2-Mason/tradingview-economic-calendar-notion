#!/usr/bin/env python3
"""Collect personal-use Yahoo Finance earnings staging data with yfinance.

This script deliberately refuses to write into the public GitHub Pages data
directory. Yahoo-derived records stay under `.private/` until the user replaces
or verifies them with sources that permit publication.
"""

# pyright: reportMissingImports=false

from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote
from zoneinfo import ZoneInfo

import yfinance as yf


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WATCHLIST = ROOT / ".private" / "watchlist.json"
DEFAULT_OUTPUT = ROOT / ".private" / "yahoo-earnings-staging.json"
PUBLIC_DATA_DIR = (ROOT / "earnings" / "data").resolve()
MARKET_TIMEZONES = {"US": "America/New_York", "HK": "Asia/Hong_Kong"}
MARKET_CURRENCIES = {"US": "USD", "HK": "HKD"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch US/HK watchlist earnings into a private staging JSON file."
    )
    parser.add_argument("--watchlist", type=Path, default=DEFAULT_WATCHLIST)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--days-back", type=int, default=30)
    parser.add_argument("--days-forward", type=int, default=120)
    return parser.parse_args()


def finite_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def text_value(value: Any) -> str | None:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def safe_get(container: Any, key: str, default: Any = None) -> Any:
    if container is None:
        return default
    try:
        return container.get(key, default)
    except (AttributeError, KeyError, TypeError):
        return default


def safe_call(
    stage: str,
    operation: Callable[[], Any],
    errors: list[dict[str, str]],
) -> Any:
    try:
        return operation()
    except Exception as error:  # yfinance exposes several transport/parser errors
        errors.append(
            {
                "stage": stage,
                "errorType": type(error).__name__,
                "message": str(error)[:300],
            }
        )
        return None


def as_datetime(value: Any, timezone_name: str) -> tuple[datetime | None, bool]:
    if value is None:
        return None, False
    if hasattr(value, "to_pydatetime"):
        value = value.to_pydatetime()
    if isinstance(value, datetime):
        parsed = value
        date_only = False
    elif isinstance(value, date):
        parsed = datetime.combine(value, time.min)
        date_only = True
    elif isinstance(value, str):
        raw = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            return None, False
        date_only = "T" not in raw and " " not in raw
    else:
        return None, False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(timezone_name))
    return parsed, date_only


def iso_z(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def read_watchlist(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise SystemExit(
            f"Watchlist not found: {path}. Copy config/watchlist.example.json "
            "to .private/watchlist.json first."
        )
    document = json.loads(path.read_text(encoding="utf-8"))
    tickers = document.get("tickers") if isinstance(document, dict) else None
    if not isinstance(tickers, list) or not tickers:
        raise SystemExit("watchlist must contain a non-empty tickers array")
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(tickers):
        if not isinstance(item, dict):
            raise SystemExit(f"tickers[{index}] must be an object")
        ticker = text_value(item.get("ticker"))
        market = (text_value(item.get("market")) or "").upper()
        if not ticker or market not in MARKET_TIMEZONES:
            raise SystemExit(f"tickers[{index}] requires ticker and market US/HK")
        if market == "HK" and not ticker.upper().endswith(".HK"):
            raise SystemExit(f"HK ticker must use Yahoo's .HK suffix: {ticker}")
        normalized.append({**item, "ticker": ticker.upper(), "market": market})
    return normalized


def calendar_dates(calendar: Any) -> list[Any]:
    raw = safe_get(calendar, "Earnings Date", [])
    if raw is None:
        return []
    return list(raw) if isinstance(raw, (list, tuple)) else [raw]


def zero_quarter_revenue_estimate(frame: Any) -> float | None:
    if frame is None or getattr(frame, "empty", True):
        return None
    try:
        if "0q" in frame.index and "avg" in frame.columns:
            return finite_number(frame.loc["0q", "avg"])
    except (AttributeError, KeyError, TypeError):
        return None
    return None


def event_identifier(market: str, ticker: str, scheduled_at: datetime) -> str:
    semantic = f"{market}|{ticker}|{scheduled_at.isoformat()}"
    digest = hashlib.sha256(semantic.encode("utf-8")).hexdigest()[:16]
    return f"YF-{market}-{ticker.replace('.', '-')}-{digest}"


def collect_ticker(
    item: dict[str, Any],
    window_start: datetime,
    window_end: datetime,
    collected_at: datetime,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    ticker_code = item["ticker"]
    market = item["market"]
    timezone_name = MARKET_TIMEZONES[market]
    errors: list[dict[str, str]] = []
    ticker = yf.Ticker(ticker_code)

    info = safe_call("get_info", ticker.get_info, errors) or {}
    fast_info = safe_call("fast_info", lambda: ticker.fast_info, errors) or {}
    calendar = safe_call("get_calendar", ticker.get_calendar, errors) or {}
    revenue_estimates = safe_call(
        "get_revenue_estimate", ticker.get_revenue_estimate, errors
    )

    company = (
        text_value(item.get("companyName"))
        or text_value(safe_get(info, "shortName"))
        or text_value(safe_get(info, "longName"))
        or ticker_code
    )
    market_currency = (
        text_value(safe_get(info, "currency"))
        or text_value(safe_get(fast_info, "currency"))
        or MARKET_CURRENCIES[market]
    )
    metric_currency = text_value(safe_get(info, "financialCurrency")) or "XXX"
    market_cap = finite_number(safe_get(fast_info, "market_cap"))
    if market_cap is None:
        market_cap = finite_number(safe_get(info, "marketCap"))

    # Yahoo's ticker-filtered earnings HTML has been observed returning unrelated
    # symbols even when `symbol=` is present. yfinance drops the Symbol column
    # after scraping, so downstream code cannot safely prove row ownership.
    # Use the ticker-scoped quoteSummary calendar instead; it provides the next
    # date and consensus fields but not a governed exact release time or safely
    # aligned historical actuals.
    rows = [(candidate, {}) for candidate in calendar_dates(calendar)]

    raw_events: list[dict[str, Any]] = []
    for raw_date, _row in rows:
        scheduled, _date_only = as_datetime(raw_date, timezone_name)
        if scheduled is None:
            continue
        scheduled_utc = scheduled.astimezone(UTC)
        if scheduled_utc < window_start or scheduled_utc > window_end:
            continue
        local = scheduled.astimezone(ZoneInfo(timezone_name))
        event_name = f"{company} earnings announcement"
        raw_events.append(
            {
                "id": event_identifier(market, ticker_code, local),
                "market": market,
                "ticker": ticker_code,
                "company": company,
                "eventName": event_name,
                "fiscalPeriod": None,
                "scheduledAt": local.isoformat(),
                "originalTimezone": timezone_name,
                "dateOnly": True,
                "timeStatus": "ESTIMATED",
                "session": "UNKNOWN",
                "releaseState": "UPCOMING",
                "times": {
                    "utc": iso_z(local),
                    "newYork": local.astimezone(
                        ZoneInfo("America/New_York")
                    ).isoformat(),
                    "hongKong": local.astimezone(
                        ZoneInfo("Asia/Hong_Kong")
                    ).isoformat(),
                },
                "eps": {
                    "actual": None,
                    "consensus": None,
                    "ownForecast": None,
                    "currency": metric_currency,
                    "surprisePercent": None,
                },
                "revenue": {
                    "actual": None,
                    "consensus": None,
                    "ownForecast": None,
                    "currency": metric_currency,
                },
                "marketCap": {
                    "value": market_cap if market_cap and market_cap > 0 else None,
                    "currency": market_currency,
                    "asOf": iso_z(collected_at),
                },
                "sources": [
                    {
                        "name": "Yahoo Finance via yfinance",
                        "kind": "UNVERIFIED_SECONDARY",
                        "url": (
                            "https://finance.yahoo.com/quote/"
                            f"{quote(ticker_code, safe='')}/calendar/"
                        ),
                        "fetchedAt": iso_z(collected_at),
                    }
                ],
                "dataStatus": "UNVERIFIED_SECONDARY",
                "redistributionStatus": "PERSONAL_USE_ONLY",
                "publicReleaseApproved": False,
            }
        )

    upcoming = [
        event
        for event in raw_events
        if datetime.fromisoformat(event["scheduledAt"]).astimezone(UTC)
        >= collected_at
    ]
    if upcoming:
        nearest = min(upcoming, key=lambda event: event["scheduledAt"])
        revenue_consensus = finite_number(safe_get(calendar, "Revenue Average"))
        if revenue_consensus is None:
            revenue_consensus = zero_quarter_revenue_estimate(revenue_estimates)
        if nearest["eps"]["consensus"] is None:
            nearest["eps"]["consensus"] = finite_number(
                safe_get(calendar, "Earnings Average")
            )
        nearest["revenue"]["consensus"] = revenue_consensus
        own_forecast = item.get("ownForecast")
        if isinstance(own_forecast, dict):
            own_eps = finite_number(own_forecast.get("eps"))
            own_revenue = finite_number(own_forecast.get("revenue"))
            nearest["eps"]["ownForecast"] = own_eps
            nearest["revenue"]["ownForecast"] = own_revenue
            forecast_currency = text_value(own_forecast.get("currency"))
            if forecast_currency and (
                own_eps is not None or own_revenue is not None
            ):
                nearest["eps"]["currency"] = forecast_currency
                nearest["revenue"]["currency"] = forecast_currency

    return sorted(raw_events, key=lambda event: event["scheduledAt"]), errors


def main() -> int:
    args = parse_args()
    if args.days_back < 0 or args.days_forward < 1:
        raise SystemExit("days-back must be >= 0 and days-forward must be >= 1")
    output = args.output.resolve()
    if output == PUBLIC_DATA_DIR or PUBLIC_DATA_DIR in output.parents:
        raise SystemExit(
            "Refusing to write Yahoo-derived personal-use data into the public "
            "earnings/data directory. Use a .private output path."
        )

    watchlist = read_watchlist(args.watchlist.resolve())
    collected_at = datetime.now(UTC)
    window_start = collected_at - timedelta(days=args.days_back)
    window_end = collected_at + timedelta(days=args.days_forward)
    all_events: list[dict[str, Any]] = []
    collection_errors: list[dict[str, str]] = []

    for item in watchlist:
        events, errors = collect_ticker(
            item, window_start, window_end, collected_at
        )
        all_events.extend(events)
        for error in errors:
            collection_errors.append(
                {"ticker": item["ticker"], "market": item["market"], **error}
            )

    document = {
        "schemaVersion": "1.0.0",
        "generatedAt": iso_z(collected_at),
        "dataPolicy": "YFINANCE_PERSONAL_STAGING_ONLY",
        "window": {
            "start": iso_z(window_start),
            "end": iso_z(window_end),
        },
        "events": sorted(all_events, key=lambda event: event["scheduledAt"]),
        "collectionErrors": collection_errors,
        "limitations": [
            "Yahoo Finance via yfinance is an unverified secondary source.",
            "Only ticker-scoped quoteSummary calendar data is used; the Yahoo "
            "earnings HTML table is not trusted for ticker ownership.",
            "The returned date is treated as date-only and BMO/AMC remains "
            "unknown.",
            "Revenue actuals are not auto-aligned to an earnings event.",
            "Event occurrence and exact time require issuer/exchange/regulator verification.",
            "This file is personal-use staging data and is not approved for public Pages.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {len(document['events'])} staging events for {len(watchlist)} "
        f"tickers to {output}; {len(collection_errors)} collection errors."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
