#!/usr/bin/env python3
"""Seed odds_cache from history + ESPN for games that froze without market odds."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import fetch_matchups as fm  # noqa: E402


def main() -> int:
    date_str = sys.argv[1] if len(sys.argv) > 1 else fm.et_today()
    hist_path = ROOT / "data" / "history" / f"{date_str}.json"
    if not hist_path.exists():
        print(f"No history file {hist_path}", flush=True)
        return 1

    day = json.loads(hist_path.read_text(encoding="utf-8"))
    cache = fm.load_odds_cache(date_str)
    by_pk = cache.setdefault("byGamePk", {})
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # 1) Seed from frozen windows that already have odds
    seeded = 0
    missing: list[dict] = []
    for g in day.get("games") or []:
        pk = g.get("gamePk")
        if pk is None:
            continue
        key = str(int(pk))
        win = (g.get("windows") or {}).get("l7") or next(iter((g.get("windows") or {}).values()), {})
        odds = (win or {}).get("odds")
        if odds and odds.get("home") and odds.get("away"):
            by_pk[key] = {
                "away": g.get("away"),
                "home": g.get("home"),
                "gameDate": g.get("gameDate"),
                "odds": odds,
                "savedAt": odds.get("cachedAt") or now,
            }
            seeded += 1
        else:
            missing.append(g)

    print(f"Seeded {seeded} games with frozen odds; {len(missing)} still missing", flush=True)

    # 2) ESPN fallback for missing
    espn = fm.load_espn_odds(date_str)
    by_pair: dict[tuple[str, str], list] = {}
    for ev in espn:
        by_pair.setdefault((ev["away"], ev["home"]), []).append(ev)

    filled = 0
    for g in missing:
        key = str(int(g["gamePk"]))
        events = by_pair.get((g["away"], g["home"])) or []
        pick = None
        g_ms = fm._game_start_ms(g.get("gameDate"))
        if events and g_ms is not None:
            timed = [e for e in events if fm._game_start_ms(e.get("gameDate")) is not None]
            if timed:
                timed.sort(key=lambda e: abs((fm._game_start_ms(e.get("gameDate")) or 0) - g_ms))
                cand = timed[0]
                if abs((fm._game_start_ms(cand.get("gameDate")) or 0) - g_ms) <= 3 * 3600 * 1000:
                    pick = cand
        if pick is None and events:
            pick = events[0]
        if not pick or not pick.get("odds"):
            print(f"  still missing {g['away']}@{g['home']} gamePk={g['gamePk']}", flush=True)
            continue
        odds = {
            "provider": pick["odds"]["provider"],
            "home": pick["odds"]["home"],
            "away": pick["odds"]["away"],
            "espnId": pick.get("espnId"),
            "fromRepair": True,
        }
        by_pk[key] = {
            "away": g.get("away"),
            "home": g.get("home"),
            "gameDate": g.get("gameDate"),
            "odds": odds,
            "savedAt": now,
        }
        filled += 1
        print(f"  ESPN repair {g['away']}@{g['home']} {odds['away']}/{odds['home']}", flush=True)

    fm.save_odds_cache(date_str, cache)
    print(f"Cache now has {len(by_pk)} games; ESPN filled {filled}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
