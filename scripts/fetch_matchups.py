#!/usr/bin/env python3
"""Fetch FanGraphs team stats + MLB schedule; write data/latest.json."""

from __future__ import annotations

import json
import math
import re
import statistics
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "data" / "latest.json"

FG_UA = "okhttp/4.12.0"
MLB_UA = "mlb-matchup-edges/1.0"
ESPN_UA = "mlb-matchup-edges/1.0"
KALSHI_UA = "mlb-matchup-edges/1.0"
KALSHI_SERIES = "KXMLBGAME"
KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2"

# Kalshi MLB abbreviations (same as MLB Stats API for current clubs)
KALSHI_TEAM_ABBS = (
    "ATL",
    "AZ",
    "BAL",
    "BOS",
    "CHC",
    "CIN",
    "CLE",
    "COL",
    "CWS",
    "DET",
    "HOU",
    "KC",
    "LAA",
    "LAD",
    "MIA",
    "MIL",
    "MIN",
    "NYM",
    "NYY",
    "ATH",
    "PHI",
    "PIT",
    "SD",
    "SEA",
    "SF",
    "STL",
    "TB",
    "TEX",
    "TOR",
    "WSH",
)
KALSHI_TEAM_SET = set(KALSHI_TEAM_ABBS)
# Prefer 3-letter codes when splitting AWAYHOME blobs (e.g. ATH before AT)
_KALSHI_SPLIT_ORDER = sorted(KALSHI_TEAM_ABBS, key=len, reverse=True)

_MONTH_ABB = {
    1: "JAN",
    2: "FEB",
    3: "MAR",
    4: "APR",
    5: "MAY",
    6: "JUN",
    7: "JUL",
    8: "AUG",
    9: "SEP",
    10: "OCT",
    11: "NOV",
    12: "DEC",
}


def _eastern_tz():
    """America/New_York when tzdata/zoneinfo is available; else DST-aware UTC offset."""
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("America/New_York")
    except Exception:
        # Windows installs often lack IANA tz data; approximate US Eastern DST.
        now = datetime.now(timezone.utc)

        def second_sunday(year: int, month: int) -> datetime:
            d = datetime(year, month, 1, tzinfo=timezone.utc)
            # weekday Mon=0 … Sun=6
            days = (6 - d.weekday()) % 7
            return d + timedelta(days=days + 7)

        def first_sunday(year: int, month: int) -> datetime:
            d = datetime(year, month, 1, tzinfo=timezone.utc)
            days = (6 - d.weekday()) % 7
            return d + timedelta(days=days)

        start = second_sunday(now.year, 3).replace(hour=7)  # 2am EST = 7 UTC
        end = first_sunday(now.year, 11).replace(hour=6)  # 2am EDT = 6 UTC
        offset = timedelta(hours=-4) if start <= now < end else timedelta(hours=-5)
        return timezone(offset, name="America/New_York")


ET = _eastern_tz()

# FanGraphs TeamNameAbb -> MLB Stats API abbreviation
FG_TO_MLB = {
    "ARI": "AZ",
    "ATH": "ATH",
    "ATL": "ATL",
    "BAL": "BAL",
    "BOS": "BOS",
    "CHC": "CHC",
    "CHW": "CWS",
    "CIN": "CIN",
    "CLE": "CLE",
    "COL": "COL",
    "DET": "DET",
    "HOU": "HOU",
    "KCR": "KC",
    "LAA": "LAA",
    "LAD": "LAD",
    "MIA": "MIA",
    "MIL": "MIL",
    "MIN": "MIN",
    "NYM": "NYM",
    "NYY": "NYY",
    "OAK": "ATH",
    "PHI": "PHI",
    "PIT": "PIT",
    "SDP": "SD",
    "SEA": "SEA",
    "SFG": "SF",
    "STL": "STL",
    "TBR": "TB",
    "TEX": "TEX",
    "TOR": "TOR",
    "WSN": "WSH",
}

# ESPN scoreboard abbreviations -> MLB Stats API abbreviation
ESPN_TO_MLB = {
    "ARI": "AZ",
    "CHW": "CWS",
    "WSH": "WSH",
    "ATH": "ATH",
    "OAK": "ATH",
}


def http_json(url: str, user_agent: str) -> dict | list:
    req = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def et_today() -> str:
    return datetime.now(ET).strftime("%Y-%m-%d")


def season_year(date_str: str) -> int:
    return int(date_str[:4])


def fangraphs_url(stats: str, season: int, month: int = 0) -> str:
    # FanGraphs month presets: 0=season, 1=last 7 days, 2=last 14, 3=last 30, …
    params = {
        "age": "",
        "pos": "all",
        "stats": stats,
        "lg": "all",
        "qual": "0",
        "season": str(season),
        "season1": str(season),
        "startdate": "" if month else f"{season}-03-01",
        "enddate": "" if month else f"{season}-11-01",
        "month": str(month),
        "hand": "",
        "team": "0,ts",
        "pageitems": "50",
        "pagenum": "1",
        "ind": "0",
        "rost": "0",
        "players": "0",
        "type": "8",
        "postseason": "",
        "sortdir": "default",
        "sortstat": "WAR",
    }
    return "https://www.fangraphs.com/api/leaders/major-league/data?" + urllib.parse.urlencode(params)


def abb_from_row(row: dict) -> str | None:
    raw = row.get("TeamNameAbb") or row.get("team_name_abb")
    if not raw:
        return None
    return FG_TO_MLB.get(str(raw).upper(), str(raw).upper())


def serialize_teams(teams: dict[str, dict]) -> dict[str, dict]:
    return {
        abb: {
            "batWAR": round(t.get("batWAR") or 0, 3) if t.get("batWAR") is not None else None,
            "pitWAR": round(t.get("pitWAR") or 0, 3) if t.get("pitWAR") is not None else None,
            "teamWAR": round(t["teamWAR"], 3) if t.get("teamWAR") is not None else None,
            "xFIP": round(t["xFIP"], 3) if t.get("xFIP") is not None else None,
            "xwOBA": round(t["xwOBA"], 4) if t.get("xwOBA") is not None else None,
        }
        for abb, t in sorted(teams.items())
    }


def load_team_stats(season: int, month: int = 0) -> tuple[dict[str, dict], str | None]:
    pit = http_json(fangraphs_url("pit", season, month), FG_UA)
    bat = http_json(fangraphs_url("bat", season, month), FG_UA)
    pit_rows = pit.get("data", []) if isinstance(pit, dict) else pit
    bat_rows = bat.get("data", []) if isinstance(bat, dict) else bat
    date_range = None
    if isinstance(pit, dict):
        date_range = pit.get("dateRange") or pit.get("dateRangeSeason")
    if not date_range and isinstance(bat, dict):
        date_range = bat.get("dateRange") or bat.get("dateRangeSeason")

    teams: dict[str, dict] = {}
    for row in pit_rows:
        abb = abb_from_row(row)
        if not abb:
            continue
        teams.setdefault(abb, {})
        teams[abb]["pitWAR"] = float(row.get("WAR") or 0)
        teams[abb]["xFIP"] = float(row["xFIP"]) if row.get("xFIP") is not None else None
        teams[abb]["fgAbb"] = row.get("TeamNameAbb") or row.get("team_name_abb")

    for row in bat_rows:
        abb = abb_from_row(row)
        if not abb:
            continue
        teams.setdefault(abb, {})
        teams[abb]["batWAR"] = float(row.get("WAR") or 0)
        teams[abb]["xwOBA"] = float(row["xwOBA"]) if row.get("xwOBA") is not None else None
        teams[abb]["fgAbb"] = row.get("TeamNameAbb") or row.get("team_name_abb")

    for abb, t in teams.items():
        bat_w = t.get("batWAR")
        pit_w = t.get("pitWAR")
        if bat_w is not None and pit_w is not None:
            t["teamWAR"] = bat_w + pit_w
        else:
            t["teamWAR"] = None

    return teams, date_range if isinstance(date_range, str) else None


def build_window(window_id: str, label: str, season: int, month: int, games: list[dict]) -> dict:
    teams, date_range = load_team_stats(season, month)
    matchups = build_matchups(games, teams)
    return {
        "id": window_id,
        "label": label,
        "month": month,
        "dateRange": date_range,
        "teamCount": len(teams),
        "teams": serialize_teams(teams),
        "matchups": matchups,
    }


def _avg_num(a, b) -> float | None:
    if a is None and b is None:
        return None
    if a is None:
        return float(b)
    if b is None:
        return float(a)
    return (float(a) + float(b)) / 2.0


def blend_windows(season_window: dict, l7_window: dict, games: list[dict]) -> dict:
    """Equal-weight average of season + L7 team stats, then recompute matchup edges."""
    s_teams = season_window.get("teams") or {}
    l_teams = l7_window.get("teams") or {}
    blended: dict[str, dict] = {}
    for abb in sorted(set(s_teams) | set(l_teams)):
        s = s_teams.get(abb) or {}
        l = l_teams.get(abb) or {}
        bat = _avg_num(s.get("batWAR"), l.get("batWAR"))
        pit = _avg_num(s.get("pitWAR"), l.get("pitWAR"))
        xfip = _avg_num(s.get("xFIP"), l.get("xFIP"))
        xwoba = _avg_num(s.get("xwOBA"), l.get("xwOBA"))
        if bat is not None and pit is not None:
            team_war = bat + pit
        else:
            team_war = _avg_num(s.get("teamWAR"), l.get("teamWAR"))
        blended[abb] = {
            "batWAR": bat,
            "pitWAR": pit,
            "teamWAR": team_war,
            "xFIP": xfip,
            "xwOBA": xwoba,
        }

    matchups = build_matchups(games, blended)
    s_range = season_window.get("dateRange") or "season"
    l_range = l7_window.get("dateRange") or "last 7 days"
    return {
        "id": "blend",
        "label": "SZN + L7",
        "month": None,
        "dateRange": f"avg({s_range} / {l_range})",
        "teamCount": len(blended),
        "teams": serialize_teams(blended),
        "matchups": matchups,
    }


def load_games(date_str: str) -> list[dict]:
    url = (
        "https://statsapi.mlb.com/api/v1/schedule"
        f"?sportId=1&date={urllib.parse.quote(date_str)}&hydrate=team"
    )
    payload = http_json(url, MLB_UA)
    games = []
    for day in payload.get("dates") or []:
        for g in day.get("games") or []:
            away = g.get("teams", {}).get("away", {}).get("team", {})
            home = g.get("teams", {}).get("home", {}).get("team", {})
            if not away.get("abbreviation") or not home.get("abbreviation"):
                continue
            dh = g.get("doubleHeader") or "N"
            game_number = int(g.get("gameNumber") or 1)
            games.append(
                {
                    "gamePk": g.get("gamePk"),
                    "away": away["abbreviation"],
                    "home": home["abbreviation"],
                    "awayName": away.get("name") or away["abbreviation"],
                    "homeName": home.get("name") or home["abbreviation"],
                    "gameDate": g.get("gameDate"),
                    "gameNumber": game_number,
                    "doubleHeader": dh,
                    "isDoubleHeader": dh in ("Y", "S"),
                    "description": g.get("description"),
                    "status": (g.get("status") or {}).get("detailedState"),
                    "abstractGameState": (g.get("status") or {}).get("abstractGameState"),
                    "startTimeTBD": bool((g.get("status") or {}).get("startTimeTBD")),
                }
            )

    # Same-day rematches (official DH or makeup twin bill) always get a game label.
    pair_counts: dict[tuple[str, str], int] = {}
    for g in games:
        key = (g["away"], g["home"])
        pair_counts[key] = pair_counts.get(key, 0) + 1
    for g in games:
        key = (g["away"], g["home"])
        g["sameDayPairCount"] = pair_counts[key]
        g["showGameNumber"] = g["isDoubleHeader"] or pair_counts[key] > 1
    return games


def _parse_american(raw) -> str | None:
    if raw is None:
        return None
    s = str(raw).strip().replace("−", "-")
    if not s or s in {"null", "None", "EVEN", "even"}:
        return None
    try:
        n = int(float(s))
    except ValueError:
        if s[0] in "+-" and s[1:].isdigit():
            n = int(s)
        else:
            return None
    if n > 0:
        return f"+{n}"
    return str(n)


def _parse_game_number(*texts: str | None) -> int | None:
    for text in texts:
        if not text:
            continue
        m = re.search(r"Game\s*(\d+)", str(text), flags=re.IGNORECASE)
        if m:
            return int(m.group(1))
    return None


def _game_start_ms(iso: str | None) -> float | None:
    if not iso:
        return None
    s = str(iso).strip()
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", s):
            s = s + ":00+00:00"
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", s):
            s = s + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000
    except Exception:
        return None


def load_espn_odds(date_str: str) -> list[dict]:
    """ESPN scoreboard events with optional DraftKings moneylines (supports doubleheaders)."""
    ymd = date_str.replace("-", "")
    url = (
        "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"
        f"?dates={urllib.parse.quote(ymd)}"
    )
    try:
        payload = http_json(url, ESPN_UA)
    except Exception as exc:
        print(f"  warning: ESPN odds fetch failed: {exc}", flush=True)
        return []

    out: list[dict] = []
    for event in payload.get("events") or []:
        comps = event.get("competitions") or []
        if not comps:
            continue
        comp = comps[0]
        away = home = None
        for c in comp.get("competitors") or []:
            abb = ((c.get("team") or {}).get("abbreviation") or "").upper()
            if not abb:
                continue
            abb = ESPN_TO_MLB.get(abb, abb)
            if c.get("homeAway") == "away":
                away = abb
            elif c.get("homeAway") == "home":
                home = abb
        if not away or not home:
            continue

        note_text = " ".join(
            str(n.get("headline") or "") for n in (comp.get("notes") or [])
        )
        game_number = _parse_game_number(
            note_text,
            event.get("name"),
            event.get("shortName"),
            event.get("description"),
        )

        odds_payload = None
        odds_list = comp.get("odds") or []
        pick = None
        for entry in odds_list:
            name = ((entry.get("provider") or {}).get("name") or "").lower()
            if "draftkings" in name and entry.get("moneyline"):
                pick = entry
                break
        if pick is None:
            for entry in odds_list:
                if entry.get("moneyline"):
                    pick = entry
                    break
        if pick is not None:
            ml = pick.get("moneyline") or {}
            home_raw = ((ml.get("home") or {}).get("close") or {}).get("odds")
            away_raw = ((ml.get("away") or {}).get("close") or {}).get("odds")
            if home_raw is None:
                home_raw = ((ml.get("home") or {}).get("open") or {}).get("odds")
            if away_raw is None:
                away_raw = ((ml.get("away") or {}).get("open") or {}).get("odds")
            home_ml = _parse_american(home_raw)
            away_ml = _parse_american(away_raw)
            if home_ml and away_ml:
                provider = (pick.get("provider") or {}).get("displayName") or (
                    (pick.get("provider") or {}).get("name")
                ) or "ESPN"
                odds_payload = {
                    "provider": provider,
                    "home": home_ml,
                    "away": away_ml,
                }

        out.append(
            {
                "espnId": event.get("id"),
                "away": away,
                "home": home,
                "gameDate": event.get("date") or comp.get("date") or comp.get("startDate"),
                "gameNumber": game_number,
                "note": note_text or None,
                "odds": odds_payload,
            }
        )
    return out


def apply_odds(matchups: list[dict], espn_events: list[dict]) -> None:
    """Attach odds per game, distinguishing doubleheaders by game number / start time."""
    by_pair: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for ev in espn_events:
        by_pair[(ev["away"], ev["home"])].append(ev)

    for events in by_pair.values():
        events.sort(
            key=lambda e: (
                _game_start_ms(e.get("gameDate")) is None,
                _game_start_ms(e.get("gameDate")) or 0,
            )
        )

    # Fill missing ESPN game numbers within a pair by start-time order.
    for events in by_pair.values():
        if len(events) <= 1:
            continue
        if all(e.get("gameNumber") for e in events):
            continue
        for idx, ev in enumerate(events, start=1):
            if not ev.get("gameNumber"):
                ev["gameNumber"] = idx

    used_espn_ids: set[str] = set()

    def take_event(events: list[dict], pred) -> dict | None:
        for ev in events:
            eid = str(ev.get("espnId") or "")
            if eid and eid in used_espn_ids:
                continue
            if pred(ev):
                if eid:
                    used_espn_ids.add(eid)
                return ev
        return None

    pair_matchups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for m in matchups:
        pair_matchups[(m["away"], m["home"])].append(m)
    for group in pair_matchups.values():
        group.sort(
            key=lambda m: (
                _game_start_ms(m.get("gameDate")) is None,
                _game_start_ms(m.get("gameDate")) or 0,
                m.get("gameNumber") or 1,
            )
        )

    for m in matchups:
        m["odds"] = None
        key = (m["away"], m["home"])
        events = by_pair.get(key) or []
        if not events:
            continue

        want_num = m.get("gameNumber")
        ev = None
        if want_num and any(e.get("gameNumber") == want_num for e in events):
            ev = take_event(events, lambda e, n=want_num: e.get("gameNumber") == n)

        if ev is None:
            m_ms = _game_start_ms(m.get("gameDate"))
            if m_ms is not None:
                candidates = [
                    e
                    for e in events
                    if (not e.get("espnId") or str(e.get("espnId")) not in used_espn_ids)
                    and _game_start_ms(e.get("gameDate")) is not None
                ]
                if candidates:
                    candidates.sort(
                        key=lambda e: abs((_game_start_ms(e.get("gameDate")) or 0) - m_ms)
                    )
                    best = candidates[0]
                    if abs((_game_start_ms(best.get("gameDate")) or 0) - m_ms) <= 3 * 3600 * 1000:
                        ev = take_event(events, lambda e, b_id=best.get("espnId"): e.get("espnId") == b_id)

        if ev is None:
            group = pair_matchups[key]
            try:
                idx = group.index(m)
            except ValueError:
                idx = 0
            unused = [
                e
                for e in events
                if not e.get("espnId") or str(e.get("espnId")) not in used_espn_ids
            ]
            if idx < len(unused):
                ev = unused[idx]
                eid = str(ev.get("espnId") or "")
                if eid:
                    used_espn_ids.add(eid)

        if ev and ev.get("odds"):
            m["odds"] = {
                "provider": ev["odds"]["provider"],
                "home": ev["odds"]["home"],
                "away": ev["odds"]["away"],
                "espnId": ev.get("espnId"),
                "espnGameNumber": ev.get("gameNumber"),
            }


def kalshi_date_prefix(date_str: str) -> str:
    """2026-08-07 → 26AUG07 (Kalshi event slug date)."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return f"{dt.year % 100:02d}{_MONTH_ABB[dt.month]}{dt.day:02d}"


def split_kalshi_teams(blob: str) -> tuple[str, str] | None:
    """Split AWAYHOME (e.g. NYMPIT, LADAZ, ATHBOS) into known team codes."""
    blob = (blob or "").upper()
    for away in _KALSHI_SPLIT_ORDER:
        if not blob.startswith(away):
            continue
        home = blob[len(away) :]
        if home in KALSHI_TEAM_SET:
            return away, home
    return None


def parse_kalshi_event_ticker(event_ticker: str) -> dict | None:
    """
    KXMLBGAME-26AUG071840NYMPIT → date 26AUG07, HHMM 1840 (ET), away NYM, home PIT.
    """
    prefix = f"{KALSHI_SERIES}-"
    raw = (event_ticker or "").upper()
    if not raw.startswith(prefix):
        return None
    rest = raw[len(prefix) :]
    m = re.match(r"^(\d{2}[A-Z]{3}\d{2})(\d{4})([A-Z]+)$", rest)
    if not m:
        return None
    teams = split_kalshi_teams(m.group(3))
    if not teams:
        return None
    hhmm = m.group(2)
    try:
        minutes = int(hhmm[:2]) * 60 + int(hhmm[2:])
    except ValueError:
        minutes = None
    return {
        "eventTicker": raw,
        "datePrefix": m.group(1),
        "hhmm": hhmm,
        "etMinutes": minutes,
        "away": teams[0],
        "home": teams[1],
    }


def _kalshi_vol(market: dict) -> float:
    raw = market.get("volume_fp")
    if raw is None:
        raw = market.get("volume")
    try:
        return float(raw or 0)
    except (TypeError, ValueError):
        return 0.0


def _kalshi_cents(market: dict) -> float | None:
    for key in ("last_price_dollars", "yes_ask_dollars", "yes_bid_dollars"):
        raw = market.get(key)
        if raw is None:
            continue
        try:
            return round(float(raw) * 100)
        except (TypeError, ValueError):
            continue
    return None


def _team_from_market_ticker(market_ticker: str, event_ticker: str) -> str | None:
    et = (event_ticker or "").upper()
    mt = (market_ticker or "").upper()
    if et and mt.startswith(et + "-"):
        code = mt[len(et) + 1 :]
        return code if code in KALSHI_TEAM_SET else None
    return None


def enrich_kalshi_sides(away_vol: float, home_vol: float, away_cents: float | None, home_cents: float | None) -> dict:
    """Volume ratio vs the other side (same idea as Ticker Tracker Game Winner Volume Ratio)."""
    away_mult = (away_vol / home_vol) if home_vol > 0 else (float("nan") if away_vol <= 0 else float("inf"))
    home_mult = (home_vol / away_vol) if away_vol > 0 else (float("nan") if home_vol <= 0 else float("inf"))

    def finite_or_none(x: float) -> float | None:
        if x is None or not math.isfinite(x):
            return None
        return round(x, 4)

    away_m = finite_or_none(away_mult)
    home_m = finite_or_none(home_mult)
    max_mult = max(v for v in (away_m or 0, home_m or 0))

    fav = None
    if away_cents is not None and home_cents is not None:
        if away_cents > home_cents:
            fav = "away"
        elif home_cents > away_cents:
            fav = "home"

    # Favorite with less relative money → green (contrarian); heavy skew → yellow/red
    tone = "muted"
    if fav == "away" and away_m is not None and home_m is not None and away_m < home_m:
        tone = "green"
    elif fav == "home" and home_m is not None and away_m is not None and home_m < away_m:
        tone = "green"
    elif max_mult >= 5:
        tone = "red"
    elif max_mult >= 2:
        tone = "yellow"

    if away_vol >= home_vol:
        high_side = "away"
        high_team_mult = away_m
    else:
        high_side = "home"
        high_team_mult = home_m

    return {
        "awayVol": round(away_vol, 2),
        "homeVol": round(home_vol, 2),
        "awayCents": away_cents,
        "homeCents": home_cents,
        "awayMult": away_m,
        "homeMult": home_m,
        "maxMult": round(max_mult, 4) if max_mult else None,
        "totalVol": round(away_vol + home_vol, 2),
        "highSide": high_side,
        "highMult": high_team_mult,
        "favoriteSide": fav,
        "tone": tone,
    }


def load_kalshi_events(date_str: str) -> list[dict]:
    """Kalshi MLB Game Winner events for the slate date, with nested markets."""
    want = kalshi_date_prefix(date_str)
    out: list[dict] = []
    cursor = ""
    for _ in range(8):
        params = {
            "series_ticker": KALSHI_SERIES,
            "limit": "200",
            "with_nested_markets": "true",
        }
        if cursor:
            params["cursor"] = cursor
        url = f"{KALSHI_API}/events?" + urllib.parse.urlencode(params)
        data = http_json(url, KALSHI_UA)
        for evt in data.get("events") or []:
            parsed = parse_kalshi_event_ticker(evt.get("event_ticker") or "")
            if not parsed or parsed["datePrefix"] != want:
                continue
            markets = evt.get("markets") or []
            by_team: dict[str, dict] = {}
            for mk in markets:
                code = _team_from_market_ticker(mk.get("ticker") or "", parsed["eventTicker"])
                if not code:
                    # Fallback: yes_sub_title often is city / short name — skip; ticker is reliable
                    continue
                by_team[code] = mk
            away_mk = by_team.get(parsed["away"])
            home_mk = by_team.get(parsed["home"])
            if not away_mk or not home_mk:
                continue
            sides = enrich_kalshi_sides(
                _kalshi_vol(away_mk),
                _kalshi_vol(home_mk),
                _kalshi_cents(away_mk),
                _kalshi_cents(home_mk),
            )
            out.append({**parsed, **sides})
        cursor = data.get("cursor") or ""
        if not cursor:
            break
    return out


def apply_kalshi_volume(matchups: list[dict], kalshi_events: list[dict]) -> None:
    """Attach Kalshi Game Winner dollar volume per matchup (DH-aware via start time)."""
    by_pair: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for ev in kalshi_events:
        by_pair[(ev["away"], ev["home"])].append(ev)

    used: set[str] = set()

    def et_minutes_from_iso(iso: str | None) -> int | None:
        if not iso:
            return None
        try:
            dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(ET)
            return dt.hour * 60 + dt.minute
        except Exception:
            return None

    for m in matchups:
        m["kalshi"] = None
        key = (m["away"], m["home"])
        events = [e for e in (by_pair.get(key) or []) if e["eventTicker"] not in used]
        if not events:
            continue

        pick = None
        if len(events) == 1:
            pick = events[0]
        else:
            want = et_minutes_from_iso(m.get("gameDate"))
            if want is not None:
                scored = [
                    (abs((e.get("etMinutes") if e.get("etMinutes") is not None else 10**9) - want), e)
                    for e in events
                ]
                scored.sort(key=lambda t: t[0])
                if scored and scored[0][0] <= 180:  # within 3 hours
                    pick = scored[0][1]
            if pick is None:
                pick = events[0]

        used.add(pick["eventTicker"])
        m["kalshi"] = {
            "eventTicker": pick["eventTicker"],
            "awayVol": pick["awayVol"],
            "homeVol": pick["homeVol"],
            "awayCents": pick["awayCents"],
            "homeCents": pick["homeCents"],
            "awayMult": pick["awayMult"],
            "homeMult": pick["homeMult"],
            "maxMult": pick["maxMult"],
            "totalVol": pick["totalVol"],
            "highSide": pick["highSide"],
            "highMult": pick["highMult"],
            "favoriteSide": pick["favoriteSide"],
            "tone": pick["tone"],
        }


def zscores(values: list[float]) -> list[float]:
    if not values:
        return []
    if len(values) == 1:
        return [0.0]
    mean = statistics.mean(values)
    sd = statistics.pstdev(values)
    if sd == 0 or math.isclose(sd, 0.0):
        return [0.0 for _ in values]
    return [(v - mean) / sd for v in values]


def build_matchups(games: list[dict], teams: dict[str, dict]) -> list[dict]:
    raw = []
    for g in games:
        a = teams.get(g["away"])
        h = teams.get(g["home"])
        if not a or not h:
            continue
        if a.get("teamWAR") is None or h.get("teamWAR") is None:
            continue
        if a.get("xFIP") is None or h.get("xFIP") is None:
            continue
        if a.get("xwOBA") is None or h.get("xwOBA") is None:
            continue

        d_war = h["teamWAR"] - a["teamWAR"]
        d_xfip = a["xFIP"] - h["xFIP"]  # lower xFIP better → positive favors home
        d_xwoba = h["xwOBA"] - a["xwOBA"]

        raw.append(
            {
                "gamePk": g["gamePk"],
                "away": g["away"],
                "home": g["home"],
                "awayName": g["awayName"],
                "homeName": g["homeName"],
                "gameDate": g.get("gameDate"),
                "gameNumber": g.get("gameNumber") or 1,
                "doubleHeader": g.get("doubleHeader") or "N",
                "isDoubleHeader": bool(g.get("isDoubleHeader")),
                "showGameNumber": bool(g.get("showGameNumber")),
                "description": g.get("description"),
                "status": g["status"],
                "abstractGameState": g.get("abstractGameState"),
                "startTimeTBD": g.get("startTimeTBD", False),
                "awayStats": {
                    "batWAR": round(a["batWAR"], 3),
                    "pitWAR": round(a["pitWAR"], 3),
                    "teamWAR": round(a["teamWAR"], 3),
                    "xFIP": round(a["xFIP"], 3),
                    "xwOBA": round(a["xwOBA"], 4),
                },
                "homeStats": {
                    "batWAR": round(h["batWAR"], 3),
                    "pitWAR": round(h["pitWAR"], 3),
                    "teamWAR": round(h["teamWAR"], 3),
                    "xFIP": round(h["xFIP"], 3),
                    "xwOBA": round(h["xwOBA"], 4),
                },
                "diffTeamWAR": d_war,
                "diffXFIP": d_xfip,
                "diffXwOBA": d_xwoba,
            }
        )

    z_war = zscores([m["diffTeamWAR"] for m in raw])
    z_xfip = zscores([m["diffXFIP"] for m in raw])
    z_xwoba = zscores([m["diffXwOBA"] for m in raw])

    out = []
    for i, m in enumerate(raw):
        overall = z_war[i] + z_xfip[i] + z_xwoba[i]
        favored = m["home"] if overall > 0 else m["away"] if overall < 0 else "EVEN"
        out.append(
            {
                **m,
                "diffTeamWAR": round(m["diffTeamWAR"], 3),
                "diffXFIP": round(m["diffXFIP"], 3),
                "diffXwOBA": round(m["diffXwOBA"], 4),
                "zTeamWAR": round(z_war[i], 4),
                "zXFIP": round(z_xfip[i], 4),
                "zXwOBA": round(z_xwoba[i], 4),
                "overallEdge": round(overall, 4),
                "favored": favored,
            }
        )

    out.sort(key=lambda m: m["overallEdge"], reverse=True)
    return out


def main() -> int:
    date_str = sys.argv[1] if len(sys.argv) > 1 else et_today()
    season = season_year(date_str)
    print(f"Fetching MLB schedule for {date_str}...", flush=True)
    games = load_games(date_str)
    print(f"  {len(games)} games", flush=True)

    print("Fetching ESPN moneylines...", flush=True)
    odds_events = load_espn_odds(date_str)
    print(f"  {len(odds_events)} ESPN events ({sum(1 for e in odds_events if e.get('odds'))} with moneylines)", flush=True)

    print("Fetching Kalshi Game Winner volumes...", flush=True)
    kalshi_events = load_kalshi_events(date_str)
    print(f"  {len(kalshi_events)} Kalshi events for {kalshi_date_prefix(date_str)}", flush=True)

    print(f"Fetching FanGraphs season team stats for {season}...", flush=True)
    season_window = build_window("season", "Season", season, 0, games)
    apply_odds(season_window["matchups"], odds_events)
    apply_kalshi_volume(season_window["matchups"], kalshi_events)
    print(f"  season: {season_window['teamCount']} teams, {len(season_window['matchups'])} matchups, range={season_window['dateRange']}", flush=True)

    print("Fetching FanGraphs last-7-days team stats...", flush=True)
    l7_window = build_window("l7", "Last 7 days", season, 1, games)
    apply_odds(l7_window["matchups"], odds_events)
    apply_kalshi_volume(l7_window["matchups"], kalshi_events)
    print(f"  l7: {l7_window['teamCount']} teams, {len(l7_window['matchups'])} matchups, range={l7_window['dateRange']}", flush=True)

    print("Building SZN + L7 blend...", flush=True)
    blend_window = blend_windows(season_window, l7_window, games)
    apply_odds(blend_window["matchups"], odds_events)
    apply_kalshi_volume(blend_window["matchups"], kalshi_events)
    print(f"  blend: {blend_window['teamCount']} teams, {len(blend_window['matchups'])} matchups", flush=True)

    payload = {
        "date": date_str,
        "timezone": "America/New_York",
        "season": season,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "defaultWindow": "l7",
        "source": {
            "fangraphs": "leaders/major-league team splits (type=8); month=0 season, month=1 last 7 days; blend=equal-weight avg",
            "mlb": "statsapi.mlb.com schedule",
            "odds": "ESPN scoreboard DraftKings moneylines (site.api.espn.com)",
            "kalshi": "Kalshi MLB Game Winner markets (api.elections.kalshi.com) volume_fp per side",
        },
        "formulas": {
            "diffTeamWAR": "(batWAR_h + pitWAR_h) - (batWAR_a + pitWAR_a)",
            "diffXFIP": "xFIP_a - xFIP_h",
            "diffXwOBA": "xwOBA_h - xwOBA_a",
            "overallEdge": "z(diffTeamWAR) + z(diffXFIP) + z(diffXwOBA)",
            "kalshiMult": "side_volume / other_side_volume (Ticker Tracker Game Winner volume ratio)",
            "note": "Positive diffs / Overall Edge favor the home team. Edges are recomputed per stats window. SZN + L7 averages season and last-7 team stats equally before diffs/z-scores. Money column is Kalshi Game Winner dollar volume per team.",
        },
        "windows": {
            "season": season_window,
            "l7": l7_window,
            "blend": blend_window,
        },
        # Back-compat aliases (season window)
        "teams": season_window["teams"],
        "matchups": season_window["matchups"],
        "dateRange": season_window["dateRange"],
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {OUT_PATH} (season={len(season_window['matchups'])}, l7={len(l7_window['matchups'])}, blend={len(blend_window['matchups'])})",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
