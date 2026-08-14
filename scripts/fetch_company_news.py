#!/usr/bin/env python3
"""Collect private US/HK company-news metadata for a watchlist.

Moomoo Search News is the discovery layer. Every Moomoo result must contain
the exact watched security in ``related_securities`` or it is discarded.
SEC submissions can be added as an official US disclosure source when a
compliant ``SEC_USER_AGENT`` is configured.

The collector never opens a trade context, reads an account, writes to Notion,
or stores article/filing body text. The output is private staging data and every
record remains UNVERIFIED until a person or governed workflow opens the source.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import tempfile
import time
from collections.abc import Iterable, Mapping
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
PRIVATE_WATCHLIST = ROOT / ".private" / "watchlist.json"
EXAMPLE_WATCHLIST = ROOT / "config" / "watchlist.example.json"
DEFAULT_OUTPUT = ROOT / ".private" / "company-news-staging.json"
PUBLIC_DIRECTORIES = ((ROOT / "earnings" / "data").resolve(),)
SEC_TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
SEC_ARCHIVES_ROOT = "https://www.sec.gov/Archives/edgar/data"
DEFAULT_SEC_FORMS = (
    "8-K",
    "8-K/A",
    "10-Q",
    "10-Q/A",
    "10-K",
    "10-K/A",
    "6-K",
    "6-K/A",
    "20-F",
    "20-F/A",
    "40-F",
    "40-F/A",
)
SEC_REQUEST_SPACING_SECONDS = 0.15
MOOMOO_REQUEST_SPACING_SECONDS = 3.1


class CollectionFailure(RuntimeError):
    """A fail-closed collection error that must preserve the prior snapshot."""


def default_watchlist() -> Path:
    return PRIVATE_WATCHLIST if PRIVATE_WATCHLIST.is_file() else EXAMPLE_WATCHLIST


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Fetch exact-ticker Moomoo news and optional SEC filing metadata "
            "into a private staging snapshot."
        )
    )
    parser.add_argument("--watchlist", type=Path, default=default_watchlist())
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11111)
    parser.add_argument(
        "--max-count",
        type=int,
        default=5,
        help="Maximum exact-match records retained per ticker.",
    )
    parser.add_argument(
        "--search-max-count",
        type=int,
        default=100,
        help="Provider candidates examined per ticker before exact filtering.",
    )
    parser.add_argument(
        "--moomoo-request-spacing-seconds",
        type=float,
        default=MOOMOO_REQUEST_SPACING_SECONDS,
        help="Keep at or above 3.0 seconds to respect 10 Search News calls/30 seconds.",
    )
    parser.add_argument(
        "--sec-mode",
        choices=("auto", "required", "off"),
        default="auto",
        help=(
            "auto uses SEC when SEC_USER_AGENT/--sec-user-agent is present; "
            "required fails if it is absent; off records the coverage gap."
        ),
    )
    parser.add_argument(
        "--sec-user-agent",
        default=os.environ.get("SEC_USER_AGENT"),
        help="Declared SEC User-Agent containing a real contact email.",
    )
    parser.add_argument("--sec-lookback-days", type=int, default=30)
    parser.add_argument(
        "--sec-forms",
        default=",".join(DEFAULT_SEC_FORMS),
        help="Comma-separated forms to retain from each US issuer submission feed.",
    )
    parser.add_argument("--http-timeout-seconds", type=float, default=20.0)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Collect and validate, but never replace the output snapshot.",
    )
    return parser.parse_args()


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if text in {"", "N/A", "None", "nan", "NaN", "<NA>"}:
        return None
    return text


def utc_now_text() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def user_ticker(item: Mapping[str, Any], market: str) -> str:
    raw = (clean_text(item.get("ticker")) or "").upper()
    if market == "US":
        if raw.startswith("US."):
            raw = raw[3:]
        if raw.endswith(".US"):
            raw = raw[:-3]
        if not re.fullmatch(r"[A-Z0-9][A-Z0-9.\-]{0,19}", raw):
            raise CollectionFailure(f"Invalid US ticker: {item.get('ticker')!r}")
        return raw

    if raw.startswith("HK."):
        raw = raw[3:]
    if raw.endswith(".HK"):
        raw = raw[:-3]
    if not raw.isdigit() or not 1 <= len(raw) <= 5:
        raise CollectionFailure(f"Invalid HK ticker: {item.get('ticker')!r}")
    return f"{int(raw):04d}.HK"


def canonical_security(ticker: str, market: str) -> str:
    if market == "US":
        return f"US.{ticker}"
    digits = ticker.removesuffix(".HK")
    return f"HK.{int(digits):05d}"


def normalize_related_security(value: Any) -> str | None:
    raw = (clean_text(value) or "").upper().replace(" ", "")
    if not raw:
        return None
    match = re.fullmatch(r"HK\.(\d{1,5})", raw)
    if not match:
        match = re.fullmatch(r"(\d{1,5})\.HK", raw)
    if match:
        return f"HK.{int(match.group(1)):05d}"
    match = re.fullmatch(r"US\.([A-Z0-9][A-Z0-9.\-]{0,19})", raw)
    if not match:
        match = re.fullmatch(r"([A-Z0-9][A-Z0-9.\-]{0,19})\.US", raw)
    if match:
        return f"US.{match.group(1)}"
    return raw


def related_security_values(value: Any) -> list[str]:
    if value is None:
        return []
    if hasattr(value, "tolist") and not isinstance(value, str):
        value = value.tolist()
    if isinstance(value, Mapping):
        for key in ("code", "security", "ticker"):
            if key in value:
                return related_security_values(value[key])
        value = list(value.values())
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith(("[", "(", "{")):
            try:
                parsed = ast.literal_eval(stripped)
            except (SyntaxError, ValueError):
                parsed = None
            if parsed is not None and parsed != value:
                return related_security_values(parsed)
        value = [token for token in re.split(r"[,;|\s]+", stripped) if token]
    elif not isinstance(value, Iterable):
        value = [value]

    normalized = {
        security
        for entry in value
        if (security := normalize_related_security(entry)) is not None
    }
    return sorted(normalized)


def read_watchlist(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise CollectionFailure(
            f"Watchlist not found: {path}. Use config/watchlist.example.json or "
            "create .private/watchlist.json."
        )
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CollectionFailure(f"Cannot read watchlist {path}: {error}") from error
    items = document.get("tickers") if isinstance(document, dict) else None
    if not isinstance(items, list) or not items:
        raise CollectionFailure("watchlist must contain a non-empty tickers array")

    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise CollectionFailure(f"tickers[{index}] must be an object")
        market = (clean_text(item.get("market")) or "").upper()
        if market not in {"US", "HK"}:
            raise CollectionFailure(f"tickers[{index}].market must be US or HK")
        ticker = user_ticker(item, market)
        company = clean_text(item.get("companyName"))
        if not company:
            raise CollectionFailure(f"tickers[{index}].companyName is required")
        security = canonical_security(ticker, market)
        if security in seen:
            raise CollectionFailure(f"Duplicate watchlist security: {security}")
        seen.add(security)
        normalized.append(
            {
                **item,
                "ticker": ticker,
                "market": market,
                "companyName": company,
                "moomooSecurity": security,
                "newsSearchKeyword": clean_text(item.get("newsSearchKeyword")) or company,
            }
        )
    return normalized


def records_from_frame(value: Any) -> list[dict[str, Any]]:
    if hasattr(value, "to_dict"):
        try:
            rows = value.to_dict(orient="records")
        except TypeError:
            rows = value.to_dict("records")
        if isinstance(rows, list) and all(isinstance(row, dict) for row in rows):
            return rows
    if isinstance(value, list) and all(isinstance(row, dict) for row in value):
        return value
    raise CollectionFailure("Moomoo Search News returned an unexpected response shape")


def stable_news_id(
    discovered_by: str,
    watched_security: str,
    title: str,
    published_at_raw: str | None,
    url: str,
) -> str:
    semantic = "|".join(
        (discovered_by, watched_security, title, published_at_raw or "", url)
    )
    digest = hashlib.sha256(semantic.encode("utf-8")).hexdigest()[:20]
    return f"NEWS-{digest}"


def build_moomoo_record(
    item: Mapping[str, Any], row: Mapping[str, Any], fetched_at: str
) -> dict[str, Any] | None:
    related = related_security_values(row.get("related_securities"))
    watched_security = str(item["moomooSecurity"])
    if watched_security not in related:
        return None
    title = clean_text(row.get("title"))
    url = clean_text(row.get("url"))
    if not title or not url:
        raise CollectionFailure(
            f"Moomoo returned an exact-ticker result without title/url for {watched_security}"
        )
    published_at_raw = clean_text(row.get("publish_time"))
    source = clean_text(row.get("source")) or "Moomoo Search News"
    return {
        "id": stable_news_id(
            "MOOMOO_SEARCH_NEWS", watched_security, title, published_at_raw, url
        ),
        "market": item["market"],
        "ticker": item["ticker"],
        "company": item["companyName"],
        "title": title,
        "source": source,
        # Search News currently returns values such as "8/10" without a year,
        # clock time, or timezone. Preserve the provider value and never invent
        # an ISO instant from it.
        "publishedAt": None,
        "publishedAtRaw": published_at_raw,
        "url": url,
        "verificationStatus": "UNVERIFIED",
        "sourceKind": "NEWS_AGGREGATOR",
        "discoveredBy": "MOOMOO_SEARCH_NEWS",
        "relatedSecurities": related,
        "fetchedAt": fetched_at,
    }


def collect_moomoo(
    items: list[dict[str, Any]],
    *,
    host: str,
    port: int,
    max_count: int,
    search_max_count: int,
    request_spacing_seconds: float,
    fetched_at: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if host != "127.0.0.1":
        raise CollectionFailure("Moomoo collector is restricted to 127.0.0.1 OpenD")
    if not 1 <= max_count <= 100:
        raise CollectionFailure("--max-count must be between 1 and 100")
    if not 1 <= search_max_count <= 100:
        raise CollectionFailure("--search-max-count must be between 1 and 100")
    if request_spacing_seconds < 3.0:
        raise CollectionFailure(
            "--moomoo-request-spacing-seconds must be >= 3.0 to respect 10 calls/30s"
        )
    try:
        from futu import NewsSubType, OpenQuoteContext, RET_OK
    except ImportError as error:
        raise CollectionFailure(
            "futu-api is not installed; install requirements-moomoo.txt"
        ) from error

    results: dict[str, dict[str, Any]] = {}
    successful_queries = 0
    rows_examined = 0
    exact_matches = 0
    quote_ctx = OpenQuoteContext(host=host, port=port)
    try:
        for index, item in enumerate(items):
            started = time.monotonic()
            ret, data = quote_ctx.get_search_news(
                item["newsSearchKeyword"],
                max_count=search_max_count,
                news_sub_type=NewsSubType.ALL,
            )
            if ret != RET_OK:
                raise CollectionFailure(
                    "Moomoo Search News failed for "
                    f"{item['moomooSecurity']}: {str(data)[:300]}"
                )
            successful_queries += 1
            rows = records_from_frame(data)
            rows_examined += len(rows)
            retained_for_ticker = 0
            for row in rows:
                record = build_moomoo_record(item, row, fetched_at)
                if record is not None:
                    exact_matches += 1
                    if record["id"] not in results:
                        results[record["id"]] = record
                        retained_for_ticker += 1
                    if retained_for_ticker >= max_count:
                        break
            if index + 1 < len(items):
                elapsed = time.monotonic() - started
                time.sleep(max(0.0, request_spacing_seconds - elapsed))
    except Exception as error:
        if isinstance(error, CollectionFailure):
            raise
        raise CollectionFailure(f"Moomoo Search News collection failed: {error}") from error
    finally:
        quote_ctx.close()

    if exact_matches == 0:
        raise CollectionFailure(
            "Moomoo returned no exact related_securities match for the entire watchlist"
        )

    return list(results.values()), {
        "status": "COLLECTED",
        "tickersRequested": len(items),
        "successfulQueries": successful_queries,
        "rowsExamined": rows_examined,
        "exactTickerMatches": exact_matches,
        "maxRecordsPerTicker": max_count,
        "providerRowsPerQuery": search_max_count,
        "records": len(results),
    }


def validate_sec_user_agent(value: str | None) -> str | None:
    text = clean_text(value)
    if text is None:
        return None
    if "@" not in text or len(text) < 10:
        raise CollectionFailure(
            "SEC User-Agent must identify the application and include a real contact email"
        )
    return text


def http_json(url: str, user_agent: str, timeout_seconds: float) -> Any:
    request = Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            payload = response.read()
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise CollectionFailure(f"SEC request failed for {url}: {error}") from error
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CollectionFailure(f"SEC returned invalid JSON for {url}: {error}") from error


def sec_ticker_map(document: Any) -> dict[str, str]:
    if not isinstance(document, dict):
        raise CollectionFailure("SEC ticker map has an unexpected shape")
    result: dict[str, str] = {}
    for entry in document.values():
        if not isinstance(entry, dict):
            continue
        ticker = (clean_text(entry.get("ticker")) or "").upper()
        cik_value = entry.get("cik_str")
        try:
            cik = f"{int(cik_value):010d}"
        except (TypeError, ValueError):
            continue
        if ticker:
            result[ticker] = cik
    if not result:
        raise CollectionFailure("SEC ticker map contains no usable entries")
    return result


def item_sec_cik(item: Mapping[str, Any], mapping: Mapping[str, str]) -> str:
    configured = clean_text(item.get("secCik"))
    if configured is not None:
        digits = re.sub(r"\D", "", configured)
        if not digits or len(digits) > 10:
            raise CollectionFailure(f"Invalid secCik for {item['ticker']}: {configured}")
        return digits.zfill(10)
    ticker = str(item["ticker"]).upper().removesuffix(".HK")
    cik = mapping.get(ticker)
    if not cik:
        raise CollectionFailure(
            f"SEC ticker-to-CIK mapping is missing US ticker {item['ticker']}"
        )
    return cik


def filing_rows(document: Any) -> list[dict[str, Any]]:
    recent = document.get("filings", {}).get("recent") if isinstance(document, dict) else None
    if not isinstance(recent, dict):
        raise CollectionFailure("SEC submissions response lacks filings.recent")
    accession_numbers = recent.get("accessionNumber")
    if not isinstance(accession_numbers, list):
        raise CollectionFailure("SEC submissions response lacks accessionNumber list")
    fields = (
        "accessionNumber",
        "filingDate",
        "reportDate",
        "acceptanceDateTime",
        "form",
        "primaryDocument",
        "primaryDocDescription",
        "items",
    )
    rows: list[dict[str, Any]] = []
    for index in range(len(accession_numbers)):
        row = {}
        for field in fields:
            values = recent.get(field)
            row[field] = values[index] if isinstance(values, list) and index < len(values) else None
        rows.append(row)
    return rows


def parse_filing_date(value: Any) -> date | None:
    text = clean_text(value)
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        return None


def build_sec_record(
    item: Mapping[str, Any],
    cik: str,
    row: Mapping[str, Any],
    fetched_at: str,
) -> dict[str, Any]:
    form = (clean_text(row.get("form")) or "").upper()
    accession = clean_text(row.get("accessionNumber"))
    if not form or not accession:
        raise CollectionFailure(f"SEC returned a filing without form/accession for {item['ticker']}")
    accession_compact = accession.replace("-", "")
    filing_url = (
        f"{SEC_ARCHIVES_ROOT}/{int(cik)}/{accession_compact}/"
        f"{accession}-index.html"
    )
    description = clean_text(row.get("primaryDocDescription"))
    title = f"{form} filing"
    if description and description.upper() != form:
        title = f"{form} — {description}"
    published_at_raw = clean_text(row.get("acceptanceDateTime")) or clean_text(
        row.get("filingDate")
    )
    published_at = (
        published_at_raw
        if published_at_raw
        and re.search(r"(?:Z|[+-][0-9]{2}:[0-9]{2})$", published_at_raw)
        else None
    )
    security = str(item["moomooSecurity"])
    record = {
        "id": stable_news_id(
            "SEC_SUBMISSIONS_API", security, title, published_at_raw, filing_url
        ),
        "market": "US",
        "ticker": item["ticker"],
        "company": item["companyName"],
        "title": title,
        "source": "SEC EDGAR",
        "publishedAt": published_at,
        "publishedAtRaw": published_at_raw,
        "url": filing_url,
        "verificationStatus": "UNVERIFIED",
        "sourceKind": "OFFICIAL_REGULATOR",
        "discoveredBy": "SEC_SUBMISSIONS_API",
        "relatedSecurities": [security],
        "fetchedAt": fetched_at,
        "officialMetadata": {
            "cik": cik,
            "form": form,
            "accessionNumber": accession,
            "filingDate": clean_text(row.get("filingDate")),
            "reportDate": clean_text(row.get("reportDate")),
            "items": clean_text(row.get("items")),
        },
    }
    return record


def collect_sec(
    items: list[dict[str, Any]],
    *,
    user_agent: str,
    lookback_days: int,
    forms: set[str],
    timeout_seconds: float,
    fetched_at: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    us_items = [item for item in items if item["market"] == "US"]
    if not us_items:
        return [], {
            "status": "NOT_APPLICABLE",
            "tickersRequested": 0,
            "successfulRequests": 0,
            "records": 0,
        }
    mapping = sec_ticker_map(http_json(SEC_TICKER_MAP_URL, user_agent, timeout_seconds))
    successful_requests = 1
    cutoff = datetime.now(UTC).date() - timedelta(days=lookback_days)
    results: dict[str, dict[str, Any]] = {}
    for item in us_items:
        cik = item_sec_cik(item, mapping)
        time.sleep(SEC_REQUEST_SPACING_SECONDS)
        document = http_json(
            SEC_SUBMISSIONS_URL.format(cik=cik), user_agent, timeout_seconds
        )
        successful_requests += 1
        for row in filing_rows(document):
            filing_date = parse_filing_date(row.get("filingDate"))
            form = (clean_text(row.get("form")) or "").upper()
            if filing_date is None or filing_date < cutoff or form not in forms:
                continue
            record = build_sec_record(item, cik, row, fetched_at)
            results[record["id"]] = record
    return list(results.values()), {
        "status": "COLLECTED",
        "tickersRequested": len(us_items),
        "successfulRequests": successful_requests,
        "lookbackDays": lookback_days,
        "forms": sorted(forms),
        "records": len(results),
    }


def ensure_private_output(path: Path) -> Path:
    output = path.resolve()
    for public_directory in PUBLIC_DIRECTORIES:
        if output == public_directory or public_directory in output.parents:
            raise CollectionFailure(
                "Refusing to write unverified company news into a public data directory"
            )
    if output.parent != (ROOT / ".private").resolve() and (ROOT / ".private").resolve() not in output.parents:
        raise CollectionFailure("Company-news staging output must remain under .private/")
    return output


def validate_document(document: Mapping[str, Any]) -> None:
    if document.get("schemaVersion") != "1.0.0":
        raise CollectionFailure("Internal document validation failed: schemaVersion")
    news = document.get("news")
    if not isinstance(news, list):
        raise CollectionFailure("Internal document validation failed: news must be an array")
    required = {
        "id",
        "market",
        "ticker",
        "company",
        "title",
        "source",
        "publishedAt",
        "publishedAtRaw",
        "url",
        "verificationStatus",
        "sourceKind",
        "discoveredBy",
        "relatedSecurities",
        "fetchedAt",
    }
    seen: set[str] = set()
    for record in news:
        if not isinstance(record, dict) or not required.issubset(record):
            raise CollectionFailure("Internal document validation failed: malformed news record")
        if record["verificationStatus"] != "UNVERIFIED":
            raise CollectionFailure("Every company-news record must remain UNVERIFIED")
        if record["id"] in seen:
            raise CollectionFailure(f"Duplicate company-news id: {record['id']}")
        seen.add(record["id"])
        forbidden = {"body", "content", "fullText", "articleText"}.intersection(record)
        if forbidden:
            raise CollectionFailure(
                f"News record {record['id']} contains forbidden body fields: {sorted(forbidden)}"
            )


def atomic_write_json(path: Path, document: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            json.dump(document, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> int:
    args = parse_args()
    if args.sec_lookback_days < 0:
        raise SystemExit("--sec-lookback-days must be non-negative")
    if args.http_timeout_seconds <= 0:
        raise SystemExit("--http-timeout-seconds must be positive")
    output = ensure_private_output(args.output)
    try:
        items = read_watchlist(args.watchlist.resolve())
        fetched_at = utc_now_text()
        moomoo_records, moomoo_coverage = collect_moomoo(
            items,
            host=args.host,
            port=args.port,
            max_count=args.max_count,
            search_max_count=args.search_max_count,
            request_spacing_seconds=args.moomoo_request_spacing_seconds,
            fetched_at=fetched_at,
        )

        source_gaps: list[dict[str, str]] = [
            {
                "code": "HKEX_NO_FREE_AUTOMATED_FEED",
                "market": "HK",
                "detail": (
                    "HKEXnews has no free official API/RSS and its website terms prohibit "
                    "programmatic scraping; use HKEX News Alert or licensed IIS separately."
                ),
            }
        ]
        sec_records: list[dict[str, Any]] = []
        sec_user_agent = validate_sec_user_agent(args.sec_user_agent)
        if args.sec_mode == "required" and sec_user_agent is None:
            raise CollectionFailure(
                "SEC collection is required but SEC_USER_AGENT/--sec-user-agent is missing"
            )
        if args.sec_mode == "off":
            sec_coverage: dict[str, Any] = {
                "status": "SKIPPED_BY_REQUEST",
                "tickersRequested": sum(item["market"] == "US" for item in items),
                "records": 0,
            }
            source_gaps.append(
                {
                    "code": "SEC_DISABLED",
                    "market": "US",
                    "detail": "SEC submissions collection was disabled by --sec-mode off.",
                }
            )
        elif sec_user_agent is None:
            sec_coverage = {
                "status": "SKIPPED_MISSING_USER_AGENT",
                "tickersRequested": sum(item["market"] == "US" for item in items),
                "records": 0,
            }
            source_gaps.append(
                {
                    "code": "SEC_USER_AGENT_REQUIRED",
                    "market": "US",
                    "detail": (
                        "Set SEC_USER_AGENT to an application name plus real contact email "
                        "to enable the official SEC submissions source."
                    ),
                }
            )
        else:
            forms = {
                form.strip().upper()
                for form in args.sec_forms.split(",")
                if form.strip()
            }
            if not forms:
                raise CollectionFailure("--sec-forms must contain at least one form")
            sec_records, sec_coverage = collect_sec(
                items,
                user_agent=sec_user_agent,
                lookback_days=args.sec_lookback_days,
                forms=forms,
                timeout_seconds=args.http_timeout_seconds,
                fetched_at=fetched_at,
            )

        combined = {record["id"]: record for record in moomoo_records + sec_records}
        news = sorted(
            combined.values(),
            key=lambda record: (
                record["market"],
                record["ticker"],
                record["publishedAt"] or record["publishedAtRaw"] or "",
                record["discoveredBy"],
                record["title"],
            ),
            reverse=True,
        )
        document = {
            "schemaVersion": "1.0.0",
            "generatedAt": fetched_at,
            "dataPolicy": "PRIVATE_PERSONAL_STAGING_ONLY",
            "collector": "MOOMOO_SEARCH_NEWS_WITH_OPTIONAL_SEC_SUBMISSIONS",
            "watchlist": {
                "file": args.watchlist.name,
                "tickersRequested": len(items),
                "markets": sorted({item["market"] for item in items}),
            },
            "coverage": {
                "moomoo": moomoo_coverage,
                "sec": sec_coverage,
                "records": len(news),
            },
            "news": news,
            "collectionErrors": [],
            "sourceGaps": source_gaps,
            "limitations": [
                "Every record is UNVERIFIED staging metadata until its source URL is opened and reviewed.",
                "Moomoo is a discovery layer; exact related_securities matching does not make an article authoritative.",
                "SEC records are official filing metadata, but the linked filing still requires review before use.",
                "No article, press-release, or filing body text is stored.",
                "This personal-use file must not be committed to or served by public GitHub Pages.",
            ],
        }
        validate_document(document)
        summary = {
            "output": str(output),
            "dryRun": args.dry_run,
            "tickersRequested": len(items),
            "records": len(news),
            "moomooRecords": moomoo_coverage["records"],
            "secStatus": sec_coverage["status"],
            "secRecords": sec_coverage["records"],
        }
        if not args.dry_run:
            atomic_write_json(output, document)
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except CollectionFailure as error:
        raise SystemExit(f"Collection failed; existing snapshot preserved: {error}") from error


if __name__ == "__main__":
    raise SystemExit(main())
