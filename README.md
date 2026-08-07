# MLB Matchup Edges

Static GitHub Pages site that ranks today’s MLB games by FanGraphs team edges:

- **Δ Team WAR** — (bat WAR + pit WAR) home − away  
- **Δ xFIP** — away − home (lower is better)  
- **Δ xwOBA** — home − away  
- **Overall Edge** — equal-weight z-scores of the three diffs (positive favors home)

Live site (once Pages is enabled):  
https://jacobtulster.github.io/mlb-matchup-edges/

## How it works

GitHub Actions cannot be skipped: the browser cannot call FanGraphs (CORS / Cloudflare). A scheduled workflow runs `scripts/fetch_matchups.py`, which pulls:

1. FanGraphs leaders API (team splits: `team=0,ts`, `type=8`) for pitching and batting  
2. MLB Stats API schedule for today’s date (America/New_York)

…then writes `data/latest.json`. The static page only reads that file.

## Local refresh

```bash
python scripts/fetch_matchups.py
# optional: python scripts/fetch_matchups.py 2026-08-07
```

Requires Python 3.10+. No third-party packages (on Windows, `pip install tzdata` is optional for precise IANA timezones; the script falls back to a US Eastern DST estimate).

## Create the GitHub repo + Pages

From this folder:

```bash
git init
git add .
git commit -m "Initial MLB Matchup Edges site"
gh repo create jacobtulster/mlb-matchup-edges --public --source=. --remote=origin --push
```

Then:

1. **Settings → Pages** → Build and deployment → Source: **Deploy from a branch** → Branch: `main` / `/ (root)` → Save  
2. **Actions** tab → enable workflows if prompted → run **Update matchup data** once (`workflow_dispatch`)  
3. Site URL: https://jacobtulster.github.io/mlb-matchup-edges/

The cron job runs every 6 hours and commits updated `data/latest.json` when the slate or stats change.

## If FanGraphs blocks Actions

If the workflow gets Cloudflare challenges, run the script locally and push:

```bash
python scripts/fetch_matchups.py
git add data/latest.json
git commit -m "Manual data refresh"
git push
```
