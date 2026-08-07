#!/usr/bin/env python3
"""Fetch FanGraphs team stats + MLB schedule; write data/latest.json."""

from __future__ import annotations

import json
import math
import statistics
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "data" / "latest.json"

FG_UA = "okhttp/4.12.0"
MLB_UA = "mlb-matchup-edges/1.0"


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


def http_json(url: str, user_agent: str) -> dict | list:
    req = urllib.request.Request(url, headers={"User-Agent": user_agent, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def et_today() -> str:
    return datetime.now(ET).strftime("%Y-%m-%d")


def season_year(date_str: str) -> int:
    return int(date_str[:4])


def fangraphs_url(stats: str, season: int) -> str:
    params = {
        "age": "",
        "pos": "all",
        "stats": stats,
        "lg": "all",
        "qual": "0",
        "season": str(season),
        "season1": str(season),
        "startdate": f"{season}-03-01",
        "enddate": f"{season}-11-01",
        "month": "0",
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


def load_team_stats(season: int) -> dict[str, dict]:
    pit = http_json(fangraphs_url("pit", season), FG_UA)
    bat = http_json(fangraphs_url("bat", season), FG_UA)
    pit_rows = pit.get("data", []) if isinstance(pit, dict) else pit
    bat_rows = bat.get("data", []) if isinstance(bat, dict) else bat

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

    return teams


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
            games.append(
                {
                    "gamePk": g.get("gamePk"),
                    "away": away["abbreviation"],
                    "home": home["abbreviation"],
                    "awayName": away.get("name") or away["abbreviation"],
                    "homeName": home.get("name") or home["abbreviation"],
                    "status": (g.get("status") or {}).get("detailedState"),
                }
            )
    return games


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
                "status": g["status"],
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
    print(f"Fetching FanGraphs team stats for {season}...", flush=True)
    teams = load_team_stats(season)
    print(f"  {len(teams)} teams loaded", flush=True)
    print(f"Fetching MLB schedule for {date_str}...", flush=True)
    games = load_games(date_str)
    print(f"  {len(games)} games", flush=True)
    matchups = build_matchups(games, teams)
    missing = [
        g
        for g in games
        if g["away"] not in teams or g["home"] not in teams
    ]
    if missing:
        print(f"  warning: {len(missing)} games missing FG stats", flush=True)

    payload = {
        "date": date_str,
        "timezone": "America/New_York",
        "season": season,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": {
            "fangraphs": "leaders/major-league team splits (type=8)",
            "mlb": "statsapi.mlb.com schedule",
        },
        "formulas": {
            "diffTeamWAR": "(batWAR_h + pitWAR_h) - (batWAR_a + pitWAR_a)",
            "diffXFIP": "xFIP_a - xFIP_h",
            "diffXwOBA": "xwOBA_h - xwOBA_a",
            "overallEdge": "z(diffTeamWAR) + z(diffXFIP) + z(diffXwOBA)",
            "note": "Positive diffs / Overall Edge favor the home team.",
        },
        "teams": {
            abb: {
                "batWAR": round(t.get("batWAR") or 0, 3) if t.get("batWAR") is not None else None,
                "pitWAR": round(t.get("pitWAR") or 0, 3) if t.get("pitWAR") is not None else None,
                "teamWAR": round(t["teamWAR"], 3) if t.get("teamWAR") is not None else None,
                "xFIP": round(t["xFIP"], 3) if t.get("xFIP") is not None else None,
                "xwOBA": round(t["xwOBA"], 4) if t.get("xwOBA") is not None else None,
            }
            for abb, t in sorted(teams.items())
        },
        "matchups": matchups,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH} ({len(matchups)} matchups)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
