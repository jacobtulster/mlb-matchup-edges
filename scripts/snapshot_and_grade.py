#!/usr/bin/env python3
"""Freeze pre-game snapshots and grade Finals into data/history/."""

from __future__ import annotations

import json
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LATEST_PATH = ROOT / "data" / "latest.json"
HISTORY_DIR = ROOT / "data" / "history"
INDEX_PATH = HISTORY_DIR / "index.json"

MLB_UA = "mlb-matchup-edges/1.0"
FREEZE_BEFORE_MS = 15 * 60 * 1000
EDGE_LOGISTIC_SCALE = 6.0
WINDOWS = ("season", "l7", "blend")
UNIT_STAKE = 100.0
SPREAD_ODDS_MIN = -150
SPREAD_ODDS_MAX = 110
SPREAD_ODDS_TARGET = -120


def _eastern_tz():
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo("America/New_York")
    except Exception:
        now = datetime.now(timezone.utc)

        def second_sunday(year: int, month: int) -> datetime:
            d = datetime(year, month, 1, tzinfo=timezone.utc)
            days = (6 - d.weekday()) % 7
            return d + timedelta(days=days + 7)

        def first_sunday(year: int, month: int) -> datetime:
            d = datetime(year, month, 1, tzinfo=timezone.utc)
            days = (6 - d.weekday()) % 7
            return d + timedelta(days=days)

        start = second_sunday(now.year, 3).replace(hour=7)
        end = first_sunday(now.year, 11).replace(hour=6)
        offset = timedelta(hours=-4) if start <= now < end else timedelta(hours=-5)
        return timezone(offset, name="America/New_York")


ET = _eastern_tz()


def http_json(url: str) -> dict | list:
    req = urllib.request.Request(url, headers={"User-Agent": MLB_UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def et_today() -> str:
    return datetime.now(ET).strftime("%Y-%m-%d")


def et_yesterday() -> str:
    return (datetime.now(ET) - timedelta(days=1)).strftime("%Y-%m-%d")


def parse_iso_ms(iso: str | None) -> float | None:
    if not iso:
        return None
    s = str(iso).strip()
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp() * 1000
    except Exception:
        return None


def load_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def history_path(date_str: str) -> Path:
    return HISTORY_DIR / f"{date_str}.json"


def empty_day(date_str: str) -> dict:
    return {"date": date_str, "summary": {}, "games": []}


def parse_ml(raw) -> float | None:
    if raw is None:
        return None
    s = str(raw).strip().replace("−", "-").replace("+", "")
    if not s or s.lower() in {"even", "null", "none"}:
        return None
    try:
        n = float(s)
    except ValueError:
        return None
    return n if n != 0 else None


def implied_prob(american: float | None) -> float | None:
    if american is None or american == 0:
        return None
    if american < 0:
        return -american / (-american + 100)
    return 100 / (american + 100)


def edge_to_home_prob(edge) -> float | None:
    try:
        x = float(edge)
    except (TypeError, ValueError):
        return None
    return 1 / (1 + math.exp(-x / EDGE_LOGISTIC_SCALE))


def value_pick(matchup: dict) -> dict | None:
    """Best Val side: model win% − de-vig market win% (mirrors app.js)."""
    home_prob = edge_to_home_prob(matchup.get("overallEdge"))
    odds = matchup.get("odds") or {}
    ih = implied_prob(parse_ml(odds.get("home")))
    ia = implied_prob(parse_ml(odds.get("away")))
    if home_prob is None or ih is None or ia is None:
        return None
    total = ih + ia
    if total <= 0:
        return None
    mkt_home = ih / total
    mkt_away = ia / total
    home_edge = home_prob - mkt_home
    away_edge = (1 - home_prob) - mkt_away
    if home_edge >= away_edge:
        side = "home"
        pick = matchup["home"]
        market_ml = parse_ml(odds.get("home"))
        edge_pct = round(home_edge, 6)
    else:
        side = "away"
        pick = matchup["away"]
        market_ml = parse_ml(odds.get("away"))
        edge_pct = round(away_edge, 6)

    spread_bet = pick_val_spread(odds, side)
    return {
        "pick": pick,
        "side": side,
        "edgePct": edge_pct,
        "marketMl": market_ml,
        "spread": spread_bet,
    }


def pick_val_spread(odds: dict, side: str) -> dict | None:
    """Val-side spread with odds in [-150, +110], closest to -120."""
    spreads_blob = (odds or {}).get("spreads") or {}
    spreads = spreads_blob.get(side) or []
    in_band = []
    for s in spreads:
        if not isinstance(s, dict):
            continue
        try:
            line = float(s["line"])
            odds_n = int(s["odds"])
        except (KeyError, TypeError, ValueError):
            continue
        if SPREAD_ODDS_MIN <= odds_n <= SPREAD_ODDS_MAX:
            in_band.append({"line": line, "odds": odds_n})
    if not in_band:
        return None
    in_band.sort(key=lambda s: (abs(s["odds"] - SPREAD_ODDS_TARGET), abs(s["line"])))
    best = in_band[0]
    return {"line": best["line"], "odds": best["odds"]}


def money_pick(matchup: dict) -> str | None:
    k = matchup.get("kalshi") or {}
    hv = k.get("homeVol")
    av = k.get("awayVol")
    if hv is None or av is None:
        return None
    try:
        hv_f = float(hv)
        av_f = float(av)
    except (TypeError, ValueError):
        return None
    if hv_f == av_f:
        return None
    return matchup["home"] if hv_f > av_f else matchup["away"]


def american_stake_and_profit(ml: float | None, won: bool) -> tuple[float | None, float | None]:
    """
    Flat 1 unit = $100 risk on both favorites and dogs.
    Plus: win (ml/100)*100. Minus: win 100*(100/|ml|). Loss: -$100.
    Push handled by caller (stake may still count; profit 0).
    Returns (stakeDollars, profitDollars).
    """
    if ml is None:
        return None, None
    stake = UNIT_STAKE
    if won:
        if ml > 0:
            profit = (ml / 100.0) * stake
        else:
            profit = stake * (100.0 / abs(ml))
    else:
        profit = -stake
    return stake, round(profit, 2)


def grade_outcome(pick: str | None, winner: str | None) -> str:
    if not pick or not winner or pick == "EVEN":
        return "push"
    if pick == winner:
        return "win"
    return "loss"


def grade_spread_cover(
    side: str,
    line: float,
    away_score: float | None,
    home_score: float | None,
) -> str:
    if away_score is None or home_score is None:
        return "push"
    if side == "home":
        margin = float(home_score) - float(away_score)
    else:
        margin = float(away_score) - float(home_score)
    covered = margin + float(line)
    if covered > 0:
        return "win"
    if covered < 0:
        return "loss"
    return "push"


def combine_leg_outcomes(outcomes: list[str]) -> str:
    meaningful = [o for o in outcomes if o in ("win", "loss", "push")]
    if not meaningful:
        return "push"
    non_push = [o for o in meaningful if o != "push"]
    if not non_push:
        return "push"
    if all(o == "win" for o in non_push):
        return "win"
    if all(o == "loss" for o in non_push):
        return "loss"
    return "mixed"


def build_value_grade(
    val: dict | None,
    winner: str | None,
    away_score: float | None,
    home_score: float | None,
) -> dict:
    empty = {
        "pick": None,
        "edgePct": None,
        "marketMl": None,
        "stakeDollars": None,
        "outcome": "push",
        "profitDollars": None,
        "legs": [],
    }
    if not val or not val.get("pick"):
        return empty

    legs: list[dict] = []
    ml = val.get("marketMl")
    if ml is not None:
        ml_out = grade_outcome(val["pick"], winner)
        if ml_out == "push":
            stake, profit = UNIT_STAKE, 0.0
        else:
            stake, profit = american_stake_and_profit(ml, ml_out == "win")
        legs.append(
            {
                "type": "moneyline",
                "odds": ml,
                "stakeDollars": stake,
                "outcome": ml_out,
                "profitDollars": profit,
            }
        )

    spread = val.get("spread")
    if spread and spread.get("line") is not None and spread.get("odds") is not None:
        sp_odds = parse_ml(spread["odds"])
        sp_line = float(spread["line"])
        sp_out = grade_spread_cover(val["side"], sp_line, away_score, home_score)
        if sp_odds is not None:
            if sp_out == "push":
                stake, profit = UNIT_STAKE, 0.0
            else:
                stake, profit = american_stake_and_profit(sp_odds, sp_out == "win")
            legs.append(
                {
                    "type": "spread",
                    "line": sp_line,
                    "odds": sp_odds,
                    "stakeDollars": stake,
                    "outcome": sp_out,
                    "profitDollars": profit,
                }
            )

    stake_total = sum(leg["stakeDollars"] for leg in legs if leg.get("stakeDollars") is not None)
    profit_total = sum(leg["profitDollars"] for leg in legs if leg.get("profitDollars") is not None)
    outcome = combine_leg_outcomes([leg["outcome"] for leg in legs]) if legs else grade_outcome(
        val["pick"], winner
    )

    return {
        "pick": val["pick"],
        "side": val.get("side"),
        "edgePct": val.get("edgePct"),
        "marketMl": ml,
        "spread": spread,
        "legs": legs,
        "stakeDollars": round(stake_total, 2) if legs else None,
        "outcome": outcome,
        "profitDollars": round(profit_total, 2) if legs else None,
    }


def load_mlb_results(date_str: str) -> dict[int, dict]:
    url = (
        "https://statsapi.mlb.com/api/v1/schedule"
        f"?sportId=1&date={urllib.parse.quote(date_str)}"
        "&hydrate=linescore,team"
    )
    payload = http_json(url)
    out: dict[int, dict] = {}
    for day in payload.get("dates") or []:
        for g in day.get("games") or []:
            pk = g.get("gamePk")
            if pk is None:
                continue
            status = (g.get("status") or {}).get("abstractGameState") or ""
            detailed = (g.get("status") or {}).get("detailedState") or status
            away = g.get("teams", {}).get("away", {})
            home = g.get("teams", {}).get("home", {})
            away_score = away.get("score")
            home_score = home.get("score")
            away_abb = (away.get("team") or {}).get("abbreviation")
            home_abb = (home.get("team") or {}).get("abbreviation")
            winner = None
            if status == "Final" and away_score is not None and home_score is not None:
                if home_score > away_score:
                    winner = home_abb
                elif away_score > home_score:
                    winner = away_abb
            out[int(pk)] = {
                "status": status,
                "detailedState": detailed,
                "awayScore": away_score,
                "homeScore": home_score,
                "winner": winner,
            }
    return out


def freeze_ready(matchup: dict, now_ms: float) -> bool:
    start = parse_iso_ms(matchup.get("gameDate"))
    state = matchup.get("abstractGameState") or ""
    if state in ("Live", "Final"):
        return True
    if start is None:
        return False
    return now_ms >= start - FREEZE_BEFORE_MS


def copy_matchup(m: dict) -> dict:
    return json.loads(json.dumps(m))


def ensure_game_entry(day: dict, matchup: dict, frozen_at: str) -> dict:
    pk = matchup.get("gamePk")
    for g in day["games"]:
        if g.get("gamePk") == pk:
            return g
    entry = {
        "gamePk": pk,
        "away": matchup.get("away"),
        "home": matchup.get("home"),
        "awayName": matchup.get("awayName"),
        "homeName": matchup.get("homeName"),
        "gameDate": matchup.get("gameDate"),
        "gameNumber": matchup.get("gameNumber"),
        "showGameNumber": matchup.get("showGameNumber"),
        "isDoubleHeader": matchup.get("isDoubleHeader"),
        "frozenAt": frozen_at,
        "windows": {},
        "result": None,
    }
    day["games"].append(entry)
    return entry


def freeze_from_latest(latest: dict, day: dict, now_ms: float) -> int:
    frozen_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    windows = latest.get("windows") or {}
    # Prefer l7 slate as the game list source; fall back to season/root
    primary = (windows.get("l7") or windows.get("season") or {}).get("matchups") or latest.get("matchups") or []
    by_pk_windows: dict[int, dict] = {}
    for wid in WINDOWS:
        win = windows.get(wid) or {}
        for m in win.get("matchups") or []:
            pk = m.get("gamePk")
            if pk is None:
                continue
            by_pk_windows.setdefault(int(pk), {})[wid] = m

    # Also include root matchups as season fallback
    for m in latest.get("matchups") or []:
        pk = m.get("gamePk")
        if pk is None:
            continue
        by_pk_windows.setdefault(int(pk), {}).setdefault("season", m)

    existing = {int(g["gamePk"]) for g in day["games"] if g.get("gamePk") is not None}
    added = 0
    for m in primary:
        pk = m.get("gamePk")
        if pk is None or int(pk) in existing:
            continue
        if not freeze_ready(m, now_ms):
            continue
        entry = ensure_game_entry(day, m, frozen_at)
        pack = by_pk_windows.get(int(pk), {})
        for wid in WINDOWS:
            src = pack.get(wid)
            if src:
                entry["windows"][wid] = copy_matchup(src)
        if not entry["windows"]:
            entry["windows"]["l7"] = copy_matchup(m)
        existing.add(int(pk))
        added += 1
        print(f"  froze {entry['away']}@{entry['home']} gamePk={pk}", flush=True)
    return added


def grade_game(entry: dict, mlb: dict[int, dict]) -> bool:
    pk = entry.get("gamePk")
    if pk is None:
        return False
    info = mlb.get(int(pk))
    if not info:
        return False

    prev = entry.get("result") or {}
    if prev.get("status") == "Final" and prev.get("grades") and prev.get("winner"):
        # Already fully graded
        return False

    result = {
        "status": info.get("status"),
        "detailedState": info.get("detailedState"),
        "awayScore": info.get("awayScore"),
        "homeScore": info.get("homeScore"),
        "winner": info.get("winner"),
        "grades": {},
    }

    if info.get("status") != "Final" or not info.get("winner"):
        entry["result"] = result
        return True

    winner = info["winner"]
    grades_by_window: dict[str, dict] = {}

    for wid, matchup in (entry.get("windows") or {}).items():
        model_pick = matchup.get("favored")
        if model_pick == "EVEN":
            model_pick = None
        val = value_pick(matchup)
        mon = money_pick(matchup)

        model_out = grade_outcome(model_pick, winner)
        money_out = grade_outcome(mon, winner)

        value_grade = build_value_grade(
            val,
            winner,
            info.get("awayScore"),
            info.get("homeScore"),
        )

        grades_by_window[wid] = {
            "model": {"pick": model_pick, "outcome": model_out},
            "value": value_grade,
            "money": {"pick": mon, "outcome": money_out},
        }

    # Flatten primary window grades onto result.grades for easy UI, keep all under gradesByWindow
    primary_wid = "l7" if "l7" in grades_by_window else next(iter(grades_by_window), None)
    result["gradesByWindow"] = grades_by_window
    result["grades"] = grades_by_window.get(primary_wid) if primary_wid else {}
    result["gradedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entry["result"] = result
    print(
        f"  graded {entry.get('away')}@{entry.get('home')} winner={winner}",
        flush=True,
    )
    return True


def empty_side_summary() -> dict:
    return {
        "n": 0,
        "wins": 0,
        "losses": 0,
        "pushes": 0,
        "hitRate": None,
        "stakedDollars": 0.0,
        "profitDollars": 0.0,
        "roi": None,
    }


def summarize_day(day: dict) -> dict:
    summary: dict[str, dict] = {}
    for wid in WINDOWS:
        edge = empty_side_summary()
        model = empty_side_summary()
        money = empty_side_summary()

        for entry in day.get("games") or []:
            res = entry.get("result") or {}
            if res.get("status") != "Final":
                continue
            by_win = (res.get("gradesByWindow") or {}).get(wid) or res.get("grades") or {}
            if not by_win:
                continue

            def bump(bucket: dict, outcome: str, stake=None, profit=None, track_money=False):
                if outcome == "win":
                    bucket["wins"] += 1
                    bucket["n"] += 1
                elif outcome == "loss":
                    bucket["losses"] += 1
                    bucket["n"] += 1
                elif outcome == "mixed":
                    bucket["n"] += 1
                else:
                    bucket["pushes"] += 1
                    # Still book stake/profit on push legs (profit usually 0).
                if track_money and stake is not None and profit is not None:
                    bucket["stakedDollars"] = round(bucket["stakedDollars"] + float(stake), 2)
                    bucket["profitDollars"] = round(bucket["profitDollars"] + float(profit), 2)

            m = by_win.get("model") or {}
            bump(model, m.get("outcome") or "push")
            mon = by_win.get("money") or {}
            bump(money, mon.get("outcome") or "push")
            v = by_win.get("value") or {}
            bump(
                edge,
                v.get("outcome") or "push",
                v.get("stakeDollars"),
                v.get("profitDollars"),
                track_money=True,
            )

        def finalize(bucket: dict):
            decided = bucket["wins"] + bucket["losses"]
            bucket["hitRate"] = round(bucket["wins"] / decided, 4) if decided else None
            if bucket["stakedDollars"]:
                bucket["roi"] = round(bucket["profitDollars"] / bucket["stakedDollars"], 4)
            else:
                bucket["roi"] = None

        finalize(edge)
        finalize(model)
        finalize(money)
        summary[wid] = {"edge": edge, "model": model, "money": money}

    day["summary"] = summary
    day["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return summary


def rebuild_index(extra_dates: list[str] | None = None) -> dict:
    dates = set()
    for p in HISTORY_DIR.glob("*.json"):
        if p.name == "index.json":
            continue
        day = load_json(p, {})
        if day.get("games"):
            dates.add(p.stem)
        else:
            try:
                p.unlink()
            except OSError:
                pass
    if extra_dates:
        for d in extra_dates:
            day = load_json(history_path(d), {})
            if day.get("games"):
                dates.add(d)
    sorted_dates = sorted(dates)

    all_time: dict[str, dict] = {}
    for wid in WINDOWS:
        all_time[wid] = empty_side_summary()

    for d in sorted_dates:
        day = load_json(history_path(d), None)
        if not day:
            continue
        for wid in WINDOWS:
            s = ((day.get("summary") or {}).get(wid) or {}).get("edge") or {}
            bucket = all_time[wid]
            bucket["wins"] += int(s.get("wins") or 0)
            bucket["losses"] += int(s.get("losses") or 0)
            bucket["pushes"] += int(s.get("pushes") or 0)
            bucket["n"] = bucket["wins"] + bucket["losses"]
            bucket["stakedDollars"] = round(bucket["stakedDollars"] + float(s.get("stakedDollars") or 0), 2)
            bucket["profitDollars"] = round(bucket["profitDollars"] + float(s.get("profitDollars") or 0), 2)

    for wid in WINDOWS:
        b = all_time[wid]
        decided = b["wins"] + b["losses"]
        b["hitRate"] = round(b["wins"] / decided, 4) if decided else None
        b["roi"] = round(b["profitDollars"] / b["stakedDollars"], 4) if b["stakedDollars"] else None

    index = {
        "dates": sorted_dates,
        "allTimeEdge": all_time,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    write_json(INDEX_PATH, index)
    return index


def process_date(date_str: str, latest: dict | None, now_ms: float, do_freeze: bool) -> dict:
    day = load_json(history_path(date_str), empty_day(date_str))
    day.setdefault("games", [])
    day["date"] = date_str

    if do_freeze and latest and latest.get("date") == date_str:
        n = freeze_from_latest(latest, day, now_ms)
        print(f"  freeze added {n} games for {date_str}", flush=True)

    if not day["games"]:
        # Don't keep empty history files around
        hp = history_path(date_str)
        if hp.exists():
            try:
                hp.unlink()
            except OSError:
                pass
        return day

    print(f"Fetching MLB results for {date_str}...", flush=True)
    mlb = load_mlb_results(date_str)
    for entry in day["games"]:
        grade_game(entry, mlb)

    summarize_day(day)
    day["games"].sort(key=lambda g: parse_iso_ms(g.get("gameDate")) or 0)
    write_json(history_path(date_str), day)
    return day


def main() -> int:
    force_all = "--freeze-all" in sys.argv
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    if force_all:
        # Treat every game as freeze-ready (manual seed / catch-up).
        global FREEZE_BEFORE_MS
        FREEZE_BEFORE_MS = 10**15

    today = et_today()
    yesterday = et_yesterday()

    latest = None
    if LATEST_PATH.exists():
        latest = load_json(LATEST_PATH, None)
        print(f"Loaded latest.json date={latest.get('date') if latest else None}", flush=True)
    else:
        print("No data/latest.json — grading existing history only", flush=True)

    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    dates = {today, yesterday}
    if latest and latest.get("date"):
        dates.add(latest["date"])

    for d in sorted(dates):
        print(f"Processing history {d}...", flush=True)
        do_freeze = bool(latest and latest.get("date") == d)
        process_date(d, latest, now_ms, do_freeze=do_freeze)

    idx = rebuild_index(sorted(dates))
    print(f"Wrote index with {len(idx.get('dates') or [])} dates", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
