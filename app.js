(() => {
  const tbody = document.querySelector("#matchups tbody");
  const meta = document.querySelector("#meta");
  const refreshEl = document.querySelector("#refresh");
  const histSummaryEl = document.querySelector("#hist-summary");
  const equityWrap = document.querySelector("#equity-wrap");
  const equityChart = document.querySelector("#equity-chart");
  const equityMeta = document.querySelector("#equity-meta");
  const edgeFilterWrap = document.querySelector("#edge-filter-wrap");
  const edgeFilterBtns = [...document.querySelectorAll(".edge-filter-btn")];
  const empty = document.querySelector("#empty");
  const headers = [...document.querySelectorAll("#matchups thead th")];
  const sortKeyEl = document.querySelector("#sort-key");
  const sortDirBtn = document.querySelector("#sort-dir");
  const modeBtns = [...document.querySelectorAll(".mode-btn")];
  const histDateWrap = document.querySelector("#hist-date-wrap");
  const histDateEl = document.querySelector("#hist-date");

  let rows = [];
  let sortKey = "valueAbs";
  let sortDir = "desc";
  let countdownTimer = null;
  let payload = null;
  let livePayload = null;
  let histIndex = null;
  let histDay = null;
  let histCache = new Map(); // date -> day json
  let edgeTopN = 0; // 0 = all, 3, 5
  let viewMode = "live"; // live | historical
  let histDate = null;
  let activeWindow = localStorage.getItem("mlbEdgeWindowV2") || "l7";
  const windowBtns = [...document.querySelectorAll(".window-btn")];
  // Columns activated via click/dropdown — avoids the first click on the
  // pre-sorted Model header flipping highest-edge-first into ascending.
  const sortActivated = new Set();
  let moneyLiveAt = null;
  let moneyLiveStatus = "pending"; // pending | live | cached | error

  const KALSHI_SERIES = "KXMLBGAME";
  const KALSHI_TEAM_SET = new Set([
    "ATL", "AZ", "BAL", "BOS", "CHC", "CIN", "CLE", "COL", "CWS", "DET",
    "HOU", "KC", "LAA", "LAD", "MIA", "MIL", "MIN", "NYM", "NYY", "ATH",
    "PHI", "PIT", "SD", "SEA", "SF", "STL", "TB", "TEX", "TOR", "WSH",
  ]);
  const KALSHI_SPLIT_ORDER = [...KALSHI_TEAM_SET].sort((a, b) => b.length - a.length);
  const KALSHI_MONTHS = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ];

  function fmt(n, digits) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toFixed(digits);
  }

  /** Positive homeDiff means home is better on that metric (xFIP already flipped in JSON). */
  function edgeFor(homeDiff, away, home, digits) {
    if (homeDiff == null || Number.isNaN(homeDiff)) {
      return { text: "—", team: null, cls: "" };
    }
    if (Math.abs(homeDiff) < 1e-12) {
      return { text: "EVEN", team: null, cls: "edge-even" };
    }
    const team = homeDiff > 0 ? home : away;
    return {
      text: `+${Math.abs(homeDiff).toFixed(digits)} ${team}`,
      team,
      cls: "edge-fav",
    };
  }

  function gameStartMs(m) {
    const t = Date.parse(m.gameDate);
    return Number.isFinite(t) ? t : null;
  }

  function isGameStartedOrFinal(m) {
    const state = m.abstractGameState || "";
    if (state === "Live" || state === "Final") return true;
    const detailed = (m.status || "").toLowerCase();
    return (
      detailed.includes("final") ||
      detailed.includes("completed") ||
      detailed.includes("in progress") ||
      detailed === "live"
    );
  }

  function isGamePast(m, now = Date.now()) {
    if (isGameStartedOrFinal(m)) return true;
    const t = gameStartMs(m);
    return t != null && t <= now;
  }

  function formatStartEt(iso) {
    if (!iso) return "TBD";
    try {
      return (
        new Date(iso).toLocaleString("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
        }) + " ET"
      );
    } catch {
      return "TBD";
    }
  }

  function formatCountdown(m, now = Date.now()) {
    if (m.startTimeTBD && !m.gameDate) return "TBD";
    const state = m.abstractGameState || "";
    if (state === "Live" || (m.status || "").toLowerCase().includes("in progress")) {
      return "Live";
    }
    if (state === "Final" || (m.status || "").toLowerCase().includes("final")) {
      return m.status && m.status !== "Final" ? m.status : "Final";
    }
    const t = gameStartMs(m);
    if (t == null) return "TBD";
    const diff = t - now;
    if (diff <= 0) {
      return state === "Preview" ? "Starting soon" : m.status || "Started";
    }
    const totalSec = Math.floor(diff / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  function startCellHtml(m) {
    const time = formatStartEt(m.gameDate);
    const count = formatCountdown(m);
    const past = isGamePast(m);
    const res = m._result;
    let scoreHtml = "";
    if (res && (res.awayScore != null || res.homeScore != null)) {
      scoreHtml = `<span class="final-score">${m.away} ${res.awayScore ?? "—"}–${res.homeScore ?? "—"} ${m.home}${
        res.winner ? ` · ${res.winner} win` : ""
      }</span>`;
    }
    return `
      <td class="start ${past ? "past" : "upcoming"}" data-label="Start" data-game-pk="${m.gamePk || ""}">
        <span class="start-time">${time}</span>
        <span class="start-sep">|</span>
        <span class="countdown">${count}</span>
        ${scoreHtml}
      </td>
    `;
  }

  function gradeBadge(grade, { showPnl = false } = {}) {
    if (!grade || viewMode !== "historical") return "";
    const outcome = grade.outcome || "push";
    const label =
      outcome === "win" ? "W" : outcome === "loss" ? "L" : outcome === "mixed" ? "M" : "—";
    let pnl = "";
    if (showPnl && grade.profitDollars != null && Number.isFinite(Number(grade.profitDollars))) {
      const p = Number(grade.profitDollars);
      pnl = ` <span class="grade-pnl ${p >= 0 ? "plus" : "minus"}">${p >= 0 ? "+" : ""}$${p.toFixed(0)}</span>`;
    }
    const legs = Array.isArray(grade.legs) ? grade.legs : [];
    const legHint = legs
      .map((leg) => {
        if (leg.type === "spread") {
          const line = Number(leg.line);
          const lineStr = Number.isFinite(line)
            ? `${line > 0 ? "+" : ""}${line}`
            : "?";
          return `spread ${lineStr} @ ${leg.odds} → ${leg.outcome}`;
        }
        return `ML @ ${leg.odds} → ${leg.outcome}`;
      })
      .join("; ");
    const title =
      legHint ||
      `${grade.pick || "—"} @ ${grade.marketMl != null ? grade.marketMl : "n/a"}`;
    return `<span class="grade-badge grade-${outcome}" title="${escapeAttr(title)}">${label}${pnl}</span>`;
  }

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function formatAmericanRaw(n) {
    if (n == null || !Number.isFinite(Number(n)) || Number(n) === 0) return "—";
    const v = Math.round(Number(n));
    return v > 0 ? `+${v}` : String(v);
  }

  function formatSpreadLine(line) {
    const n = Number(line);
    if (!Number.isFinite(n)) return "—";
    return n > 0 ? `+${n}` : String(n);
  }

  function pickValSpread(odds, side) {
    const spreads = odds && odds.spreads && odds.spreads[side];
    if (!Array.isArray(spreads) || !spreads.length) return null;
    const min = -150;
    const max = 110;
    const target = -120;
    const inBand = [];
    for (const s of spreads) {
      const oddsN = Number(s.odds);
      const line = Number(s.line);
      if (!Number.isFinite(oddsN) || !Number.isFinite(line)) continue;
      if (oddsN >= min && oddsN <= max) inBand.push({ line, odds: oddsN });
    }
    if (!inBand.length) return null;
    // Baseball: prefer ±1.5 run line when in-band, then closest to -120.
    inBand.sort(
      (a, b) =>
        (Math.abs(a.line) === 1.5 ? 0 : 1) - (Math.abs(b.line) === 1.5 ? 0 : 1) ||
        Math.abs(a.odds - target) - Math.abs(b.odds - target) ||
        Math.abs(a.line) - Math.abs(b.line)
    );
    return inBand[0];
  }

  function gradesFor(m) {
    const res = m._result;
    if (!res) return null;
    const byWin = res.gradesByWindow || {};
    return byWin[activeWindow] || res.grades || null;
  }

  function formatMoneySigned(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    const v = Number(n);
    const sign = v > 0 ? "+" : v < 0 ? "−" : "";
    return `${sign}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
  }

  function compare(a, b) {
    if (sortKey === "matchup") {
      const as = `${a.away} @ ${a.home}`;
      const bs = `${b.away} @ ${b.home}`;
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    }

    if (sortKey === "gameStart") {
      const aDone = isGameStartedOrFinal(a);
      const bDone = isGameStartedOrFinal(b);
      if (aDone !== bDone) return aDone ? 1 : -1; // upcoming first; live/final at bottom
      const at = gameStartMs(a);
      const bt = gameStartMs(b);
      if (at == null && bt == null) return 0;
      if (at == null) return 1;
      if (bt == null) return -1;
      // asc = closest tip first among games still to be played
      return sortDir === "asc" ? at - bt : bt - at;
    }

    if (sortKey === "homeMl") {
      const an = parseMl(a.odds && a.odds.home);
      const bn = parseMl(b.odds && b.odds.home);
      if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
      if (Number.isNaN(an)) return 1;
      if (Number.isNaN(bn)) return -1;
      return sortDir === "asc" ? an - bn : bn - an;
    }

    if (sortKey === "moneyMaxMult" || sortKey === "moneyTotal") {
      const an = Number(a[sortKey]);
      const bn = Number(b[sortKey]);
      if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
      if (Number.isNaN(an)) return 1;
      if (Number.isNaN(bn)) return -1;
      return sortDir === "asc" ? an - bn : bn - an;
    }

    if (sortKey === "valueAbs") {
      // Highest Val % first (desc). Missing market odds sink to bottom.
      const an = Number(a.valueAbs);
      const bn = Number(b.valueAbs);
      if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
      if (Number.isNaN(an)) return 1;
      if (Number.isNaN(bn)) return -1;
      return sortDir === "asc" ? an - bn : bn - an;
    }

    const an = Number(a[sortKey]);
    const bn = Number(b[sortKey]);
    if (Number.isNaN(an) && Number.isNaN(bn)) return 0;
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    return sortDir === "asc" ? an - bn : bn - an;
  }

  function updateHeaderState() {
    headers.forEach((th) => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.key === sortKey) {
        th.classList.add(sortDir === "asc" ? "sorted-asc" : "sorted-desc");
      }
    });
  }

  function betterClasses(homeDiff) {
    if (homeDiff == null || Number.isNaN(homeDiff) || Math.abs(homeDiff) < 1e-12) {
      return { away: "", home: "" };
    }
    return homeDiff > 0
      ? { away: "worse", home: "better" }
      : { away: "better", home: "worse" };
  }

  function metricCell(awayVal, homeVal, homeDiff, away, home, digits, label) {
    const edge = edgeFor(homeDiff, away, home, digits);
    const cls = betterClasses(homeDiff);
    return `
      <td class="metric" data-label="${label}">
        <div class="stack">
          <div class="stat-line ${cls.away}"><span class="abb">${away}</span><span class="val">${fmt(awayVal, digits)}</span></div>
          <div class="stat-line ${cls.home}"><span class="abb">${home}</span><span class="val">${fmt(homeVal, digits)}</span></div>
          <div class="edge ${edge.cls}">${edge.text}</div>
        </div>
      </td>
    `;
  }

  function parseMl(raw) {
    if (raw == null) return NaN;
    const n = Number(String(raw).replace("+", ""));
    return Number.isFinite(n) ? n : NaN;
  }

  function impliedProb(american) {
    const n = parseMl(american);
    if (!Number.isFinite(n) || n === 0) return null;
    if (n < 0) return -n / (-n + 100);
    return 100 / (n + 100);
  }

  // Overall Edge → home win prob. Scale scales with # of z-components (~7 now).
  const EDGE_LOGISTIC_SCALE = 6;

  function edgeToHomeProb(edge, scale = EDGE_LOGISTIC_SCALE) {
    const x = Number(edge);
    if (!Number.isFinite(x)) return null;
    return 1 / (1 + Math.exp(-x / scale));
  }

  function probToAmerican(p) {
    if (p == null || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
    if (Math.abs(p - 0.5) < 1e-12) return 100;
    if (p > 0.5) return Math.round((-100 * p) / (1 - p));
    return Math.round((100 * (1 - p)) / p);
  }

  function formatAmerican(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const v = Math.round(Number(n));
    return v > 0 ? `+${v}` : `${v}`;
  }

  function modelOddsFromEdge(edge) {
    const homeProb = edgeToHomeProb(edge);
    if (homeProb == null) return null;
    return {
      homeProb,
      awayProb: 1 - homeProb,
      home: probToAmerican(homeProb),
      away: probToAmerican(1 - homeProb),
    };
  }

  /** Multiplicative (proportional) de-vig of two-way American moneylines. */
  function devigMoneylines(homeMl, awayMl) {
    const ih = impliedProb(homeMl);
    const ia = impliedProb(awayMl);
    if (ih == null || ia == null) return null;
    const total = ih + ia;
    if (!(total > 0)) return null;
    const homeProb = ih / total;
    const awayProb = ia / total;
    return {
      homeProb,
      awayProb,
      home: formatAmerican(probToAmerican(homeProb)),
      away: formatAmerican(probToAmerican(awayProb)),
      homeRaw: homeMl,
      awayRaw: awayMl,
      overround: total - 1,
    };
  }

  function oddsHighlight(homeProb, awayProb) {
    let homeCls = "home";
    let awayCls = "away";
    if (homeProb != null && awayProb != null) {
      if (homeProb > awayProb + 1e-9) {
        homeCls += " better";
        awayCls += " worse";
      } else if (awayProb > homeProb + 1e-9) {
        awayCls += " better";
        homeCls += " worse";
      }
    }
    return { homeCls, awayCls };
  }

  function valueVsMarket(m) {
    const model = modelOddsFromEdge(m.overallEdge);
    const market = m.odds ? devigMoneylines(m.odds.home, m.odds.away) : null;
    if (!model || !market) return null;
    const homeEdge = model.homeProb - market.homeProb;
    const awayEdge = model.awayProb - market.awayProb;
    let side;
    let team;
    let edge;
    if (homeEdge >= awayEdge) {
      side = "home";
      team = m.home;
      edge = homeEdge;
    } else {
      side = "away";
      team = m.away;
      edge = awayEdge;
    }
    const spread = pickValSpread(m.odds, side);
    return { team, edge, side, spread };
  }

  function modelCell(m) {
    const model = modelOddsFromEdge(m.overallEdge);
    const hl = model
      ? oddsHighlight(model.homeProb, model.awayProb)
      : { homeCls: "home", awayCls: "away" };
    const homePrice = model ? formatAmerican(model.home) : "—";
    const awayPrice = model ? formatAmerican(model.away) : "—";
    const value = valueVsMarket(m);
    const g = gradesFor(m);
    const modelBadge = gradeBadge(g && g.model);
    const valueBadge = gradeBadge(g && g.value, { showPnl: true });
    let valueHtml = `<div class="value-line spacer" aria-hidden="true">&nbsp;</div>`;
    if (value && Math.abs(value.edge) >= 0.005) {
      valueHtml = `<div class="value-line ${value.edge > 0 ? "plus" : "minus"}" title="Model win% minus de-vigged market win% (best side)">
             Val ${value.team} ${value.edge > 0 ? "+" : ""}${(value.edge * 100).toFixed(1)}%${valueBadge}
           </div>`;
    }
    return `
      <td class="odds model-cell" data-label="Model">
        <div class="odds-stack">
          <div class="odds-line ${hl.awayCls}"><span class="abb">${m.away}</span><span class="price">${awayPrice}</span></div>
          <div class="odds-line ${hl.homeCls}"><span class="abb">${m.home}</span><span class="price">${homePrice}</span></div>
        </div>
        ${valueHtml}
        ${modelBadge ? `<div class="grade-row">Model ${modelBadge}</div>` : ""}
      </td>
    `;
  }

  function marketCell(m) {
    const o = m.odds;
    const fair = o ? devigMoneylines(o.home, o.away) : null;
    if (!fair) {
      return `
        <td class="odds market-cell" data-label="Market">
          <div class="odds-stack">
            <div class="odds-line"><span class="abb">${m.away}</span><span class="price">—</span></div>
            <div class="odds-line"><span class="abb">${m.home}</span><span class="price">—</span></div>
          </div>
          <div class="value-line spacer" aria-hidden="true">&nbsp;</div>
        </td>
      `;
    }
    const hl = oddsHighlight(fair.homeProb, fair.awayProb);
    const value = valueVsMarket(m);
    const sp = value && value.spread ? value.spread : null;
    const title = escapeAttr(
      `${o.provider || "market"} raw ${o.away}/${o.home}${
        sp ? ` · Val ${value.team} ${formatSpreadLine(sp.line)} ${formatAmericanRaw(sp.odds)}` : ""
      }`
    );
    const spreadHtml = sp
      ? `<div class="value-spread" title="Val spread leg (prefer ±1.5 when in −150…+110)">${value.team} ${formatSpreadLine(sp.line)} (${formatAmericanRaw(sp.odds)})</div>`
      : `<div class="value-line spacer" aria-hidden="true">&nbsp;</div>`;
    return `
      <td class="odds market-cell" data-label="Market" title="${title}">
        <div class="odds-stack">
          <div class="odds-line ${hl.awayCls}"><span class="abb">${m.away}</span><span class="price">${fair.away}</span></div>
          <div class="odds-line ${hl.homeCls}"><span class="abb">${m.home}</span><span class="price">${fair.home}</span></div>
        </div>
        ${spreadHtml}
      </td>
    `;
  }

  function formatUsd(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    const v = Math.round(Number(n));
    const abs = Math.abs(v);
    if (abs >= 1_000_000) {
      const m = v / 1_000_000;
      return `$${m.toFixed(m >= 10 ? 0 : 1)}M`;
    }
    if (abs >= 10_000) return `$${Math.round(v / 1000)}k`;
    if (abs >= 1000) {
      const k = v / 1000;
      return `$${k.toFixed(1)}k`;
    }
    return `$${v.toLocaleString("en-US")}`;
  }

  function formatMult(n) {
    if (n == null || !Number.isFinite(Number(n)) || Number(n) <= 0) return "—";
    return `${Number(n).toFixed(1)}x`;
  }

  function moneyTone(maxMult) {
    const n = Number(maxMult);
    if (!Number.isFinite(n) || n < 2) return "muted";
    if (n >= 5) return "red";
    return "yellow";
  }

  function moneyCell(m) {
    const k = m.kalshi;
    if (!k) {
      return `
        <td class="odds money-cell" data-label="Money">
          <div class="odds-stack">
            <div class="odds-line"><span class="abb">${m.away}</span><span class="price">—</span></div>
            <div class="odds-line"><span class="abb">${m.home}</span><span class="price">—</span></div>
          </div>
          <div class="value-line spacer" aria-hidden="true">&nbsp;</div>
        </td>
      `;
    }
    // Always derive from ratio — ignore any baked "green underrated fav" tone.
    const tone = moneyTone(k.maxMult ?? k.highMult);
    k.tone = tone;
    const homeHigh = (k.homeVol || 0) > (k.awayVol || 0) + 1e-9;
    const awayHigh = (k.awayVol || 0) > (k.homeVol || 0) + 1e-9;
    const homeCls =
      homeHigh && tone !== "muted" ? `money-hl money-hl-${tone}` : "";
    const awayCls =
      awayHigh && tone !== "muted" ? `money-hl money-hl-${tone}` : "";
    const highTeam = k.highSide === "home" ? m.home : m.away;
    const title = `Kalshi ${k.eventTicker || ""} · total ${formatUsd(k.totalVol)} · ${formatMult(k.highMult)}`;
    const moneyBadge = gradeBadge(gradesFor(m) && gradesFor(m).money);
    return `
      <td class="odds money-cell" data-label="Money" title="${title}">
        <div class="odds-stack money-stack">
          <div class="odds-line ${awayCls}"><span class="abb">${m.away}</span><span class="price">${formatUsd(k.awayVol)}</span></div>
          <div class="odds-line ${homeCls}"><span class="abb">${m.home}</span><span class="price">${formatUsd(k.homeVol)}</span></div>
        </div>
        <div class="value-line money-mult money-${tone}">${formatMult(k.highMult)} ${highTeam}${moneyBadge}</div>
      </td>
    `;
  }

  function syncSortControls() {
    if (sortKeyEl) sortKeyEl.value = sortKey;
    if (sortDirBtn) sortDirBtn.textContent = sortDir === "asc" ? "↑" : "↓";
  }

  function defaultDirFor(key) {
    if (key === "matchup") return "asc";
    if (key === "gameStart") return "asc";
    // Model edge / value / metrics: strongest first
    return "desc";
  }

  function setSort(key, { forceDefault = false, toggle = false } = {}) {
    if (forceDefault || sortKey !== key) {
      sortKey = key;
      sortDir = defaultDirFor(key);
    } else if (toggle) {
      if (!sortActivated.has(key)) {
        // First interaction on the initially active column: keep preferred dir
        sortDir = defaultDirFor(key);
      } else {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      }
    } else {
      sortDir = defaultDirFor(key);
    }
    sortActivated.add(key);
  }

  function render() {
    const sorted = [...rows].sort(compare);
    tbody.replaceChildren();

    if (!sorted.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const frag = document.createDocumentFragment();
    for (const m of sorted) {
      const a = m.awayStats || {};
      const h = m.homeStats || {};
      const tr = document.createElement("tr");
      if (isGamePast(m)) tr.classList.add("game-past");
      tr.innerHTML = `
        <td class="matchup" data-label="Matchup">
          <span class="away">${m.away}</span>
          <span class="at">@</span>
          <span class="home">${m.home}</span>
          ${
            m.showGameNumber || m.isDoubleHeader || (m.gameNumber && Number(m.gameNumber) > 1)
              ? `<span class="game-num">G${m.gameNumber || "?"}</span>`
              : ""
          }
        </td>
        ${startCellHtml(m)}
        ${metricCell(a.teamWAR, h.teamWAR, m.diffTeamWAR, m.away, m.home, 1, "Team WAR")}
        ${metricCell(a.wRCp, h.wRCp, m.diffWRCp, m.away, m.home, 0, "wRC+")}
        ${metricCell(a.BsR, h.BsR, m.diffBsR, m.away, m.home, 1, "BsR")}
        ${metricCell(a.xwOBA, h.xwOBA, m.diffXwOBA, m.away, m.home, 3, "xwOBA")}
        ${metricCell(a.xFIP, h.xFIP, m.diffXFIP, m.away, m.home, 2, "xFIP")}
        ${metricCell(a.SIERA, h.SIERA, m.diffSIERA, m.away, m.home, 2, "SIERA")}
        ${metricCell(a.OAA, h.OAA, m.diffOAA, m.away, m.home, 0, "OAA")}
        ${modelCell(m)}
        ${marketCell(m)}
        ${moneyCell(m)}
      `;
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    updateHeaderState();
    syncSortControls();
  }

  function refreshCountdowns() {
    if (sortKey === "gameStart") {
      render();
      return;
    }
    for (const m of rows) {
      const cell = tbody.querySelector(`.start[data-game-pk="${m.gamePk}"]`);
      if (!cell) continue;
      const cd = cell.querySelector(".countdown");
      if (cd) cd.textContent = formatCountdown(m);
      cell.classList.toggle("past", isGamePast(m));
      cell.classList.toggle("upcoming", !isGamePast(m));
      const tr = cell.closest("tr");
      if (tr) tr.classList.toggle("game-past", isGamePast(m));
    }
  }

  if (sortKeyEl) {
    sortKeyEl.addEventListener("change", () => {
      setSort(sortKeyEl.value, { forceDefault: true });
      render();
    });
  }
  if (sortDirBtn) {
    sortDirBtn.addEventListener("click", () => {
      sortDir = sortDir === "asc" ? "desc" : "asc";
      sortActivated.add(sortKey);
      render();
    });
  }

  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortKey !== key) {
        setSort(key, { forceDefault: true });
      } else {
        setSort(key, { toggle: true });
      }
      render();
    });
  });

  function formatUpdated(iso) {
    if (!iso) return "unknown";
    try {
      return (
        new Date(iso).toLocaleString("en-US", {
          timeZone: "America/New_York",
          dateStyle: "medium",
          timeStyle: "short",
        }) + " ET"
      );
    } catch {
      return iso;
    }
  }

  // Cron: every 6 hours at :00 UTC → next boundary below.
  function nextCronUtc(from = new Date()) {
    const out = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), from.getUTCHours(), 0, 0, 0)
    );
    const h = Math.floor(from.getUTCHours() / 6) * 6;
    out.setUTCHours(h, 0, 0, 0);
    if (out.getTime() <= from.getTime()) {
      out.setUTCHours(h + 6, 0, 0, 0);
    }
    return out;
  }

  function formatNextRefresh(isoUpdated) {
    const next = nextCronUtc(new Date());
    const nextEt = next.toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    });
    const updatedNote = isoUpdated ? `Last stats/odds pull: ${formatUpdated(isoUpdated)}. ` : "";
    const moneyNote =
      moneyLiveStatus === "live" && moneyLiveAt
        ? `Money (Kalshi) refreshed live at ${formatUpdated(moneyLiveAt)}. `
        : moneyLiveStatus === "error"
          ? "Money live refresh failed — showing last saved volumes. "
          : moneyLiveStatus === "cached"
            ? "Money from last saved data (live refresh unavailable). "
            : "Refreshing Money from Kalshi… ";
    return `${updatedNote}${moneyNote}Next scheduled stats refresh: ~${nextEt} ET (every 6 hours).`;
  }

  function kalshiDatePrefix(dateStr) {
    const parts = String(dateStr || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return "";
    const [y, m, d] = parts;
    return `${String(y % 100).padStart(2, "0")}${KALSHI_MONTHS[m - 1]}${String(d).padStart(2, "0")}`;
  }

  function splitKalshiTeams(blob) {
    const s = String(blob || "").toUpperCase();
    for (const away of KALSHI_SPLIT_ORDER) {
      if (!s.startsWith(away)) continue;
      const home = s.slice(away.length);
      if (KALSHI_TEAM_SET.has(home)) return [away, home];
    }
    return null;
  }

  function parseKalshiEventTicker(eventTicker) {
    const raw = String(eventTicker || "").toUpperCase();
    const prefix = `${KALSHI_SERIES}-`;
    if (!raw.startsWith(prefix)) return null;
    const rest = raw.slice(prefix.length);
    const m = rest.match(/^(\d{2}[A-Z]{3}\d{2})(\d{4})([A-Z]+)$/);
    if (!m) return null;
    const teams = splitKalshiTeams(m[3]);
    if (!teams) return null;
    const hhmm = m[2];
    const etMinutes = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2));
    return {
      eventTicker: raw,
      datePrefix: m[1],
      hhmm,
      etMinutes: Number.isFinite(etMinutes) ? etMinutes : null,
      away: teams[0],
      home: teams[1],
    };
  }

  function kalshiVol(market) {
    const raw = market?.volume_fp ?? market?.volume ?? 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function kalshiCents(market) {
    for (const key of ["last_price_dollars", "yes_ask_dollars", "yes_bid_dollars"]) {
      const n = Number(market?.[key]);
      if (Number.isFinite(n)) return Math.round(n * 100);
    }
    return null;
  }

  function enrichKalshiSides(awayVol, homeVol, awayCents, homeCents) {
    const awayMult = homeVol > 0 ? awayVol / homeVol : awayVol > 0 ? Infinity : NaN;
    const homeMult = awayVol > 0 ? homeVol / awayVol : homeVol > 0 ? Infinity : NaN;
    const finite = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
    const awayM = finite(awayMult);
    const homeM = finite(homeMult);
    const maxMult = Math.max(awayM || 0, homeM || 0);
    let favoriteSide = null;
    if (awayCents != null && homeCents != null) {
      if (awayCents > homeCents) favoriteSide = "away";
      else if (homeCents > awayCents) favoriteSide = "home";
    }
    // Ratio bands: <2 none, 2–4.99 yellow, 5+ red
    let tone = "muted";
    if (maxMult >= 5) tone = "red";
    else if (maxMult >= 2) tone = "yellow";
    const highSide = awayVol >= homeVol ? "away" : "home";
    return {
      awayVol: Math.round(awayVol * 100) / 100,
      homeVol: Math.round(homeVol * 100) / 100,
      awayCents,
      homeCents,
      awayMult: awayM,
      homeMult: homeM,
      maxMult: maxMult || null,
      totalVol: Math.round((awayVol + homeVol) * 100) / 100,
      highSide,
      highMult: highSide === "away" ? awayM : homeM,
      favoriteSide,
      tone,
    };
  }

  function teamFromMarketTicker(marketTicker, eventTicker) {
    const et = String(eventTicker || "").toUpperCase();
    const mt = String(marketTicker || "").toUpperCase();
    if (et && mt.startsWith(`${et}-`)) {
      const code = mt.slice(et.length + 1);
      return KALSHI_TEAM_SET.has(code) ? code : null;
    }
    return null;
  }

  function buildKalshiFromMarkets(parsed, markets) {
    const byTeam = {};
    for (const mk of markets || []) {
      const code = teamFromMarketTicker(mk.ticker, parsed.eventTicker);
      if (code) byTeam[code] = mk;
    }
    const awayMk = byTeam[parsed.away];
    const homeMk = byTeam[parsed.home];
    if (!awayMk || !homeMk) return null;
    return {
      ...parsed,
      ...enrichKalshiSides(
        kalshiVol(awayMk),
        kalshiVol(homeMk),
        kalshiCents(awayMk),
        kalshiCents(homeMk)
      ),
    };
  }

  function buildKalshiFromEvent(evt) {
    const parsed = parseKalshiEventTicker(evt?.event_ticker);
    if (!parsed) return null;
    return buildKalshiFromMarkets(parsed, evt.markets || []);
  }

  /** Kalshi blocks browser Origin; jina.ai returns the JSON with CORS. */
  async function fetchKalshiViaProxy(apiUrl) {
    const res = await fetch(`https://r.jina.ai/${apiUrl}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
    const wrap = await res.json();
    const content = wrap?.data?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("empty proxy payload");
    }
    return JSON.parse(content);
  }

  async function loadLiveKalshiEvents(dateStr) {
    const want = kalshiDatePrefix(dateStr);
    if (!want) return [];

    // Prefer event tickers already matched in latest.json (fast path on refresh).
    const known = new Set();
    const groups = [];
    if (payload?.windows) {
      for (const win of Object.values(payload.windows)) {
        if (win?.matchups) groups.push(win.matchups);
      }
    }
    if (payload?.matchups) groups.push(payload.matchups);
    for (const list of groups) {
      for (const m of list) {
        const t = m?.kalshi?.eventTicker;
        if (t) known.add(String(t).toUpperCase());
      }
    }

    let parsedList = [...known]
      .map((t) => parseKalshiEventTicker(t))
      .filter((p) => p && p.datePrefix === want);

    // Fallback: discover today's slate from Kalshi events list
    if (!parsedList.length) {
      parsedList = [];
      let cursor = "";
      for (let page = 0; page < 8; page++) {
        const qs = new URLSearchParams({
          series_ticker: KALSHI_SERIES,
          limit: "200",
        });
        if (cursor) qs.set("cursor", cursor);
        const apiUrl = `https://api.elections.kalshi.com/trade-api/v2/events?${qs.toString()}`;
        const data = await fetchKalshiViaProxy(apiUrl);
        let pageHits = 0;
        for (const evt of data.events || []) {
          const parsed = parseKalshiEventTicker(evt?.event_ticker);
          if (!parsed || parsed.datePrefix !== want) continue;
          parsedList.push(parsed);
          pageHits += 1;
        }
        cursor = data.cursor || "";
        if (!cursor) break;
        if (pageHits === 0 && parsedList.length > 0) break;
      }
    }

    if (!parsedList.length) return [];

    // Fetch Game Winner volumes per event in parallel
    const results = await Promise.all(
      parsedList.map(async (parsed) => {
        const qs = new URLSearchParams({
          event_ticker: parsed.eventTicker,
          limit: "20",
        });
        const apiUrl = `https://api.elections.kalshi.com/trade-api/v2/markets?${qs.toString()}`;
        try {
          const data = await fetchKalshiViaProxy(apiUrl);
          return buildKalshiFromMarkets(parsed, data.markets || []);
        } catch (err) {
          console.warn("[Money] markets fetch failed", parsed.eventTicker, err);
          return null;
        }
      })
    );
    return results.filter(Boolean);
  }

  function etMinutesFromIso(iso) {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return null;
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(d);
      const hour = Number(parts.find((p) => p.type === "hour")?.value);
      const minute = Number(parts.find((p) => p.type === "minute")?.value);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
      return hour * 60 + minute;
    } catch {
      return null;
    }
  }

  function matchKalshiToGame(m, events, used) {
    const candidates = events.filter(
      (e) => e.away === m.away && e.home === m.home && !used.has(e.eventTicker)
    );
    if (!candidates.length) {
      if (m.kalshi?.eventTicker) {
        return events.find((e) => e.eventTicker === m.kalshi.eventTicker) || null;
      }
      return null;
    }
    if (candidates.length === 1) return candidates[0];
    const want = etMinutesFromIso(m.gameDate);
    if (want != null) {
      candidates.sort(
        (a, b) =>
          Math.abs((a.etMinutes ?? 1e9) - want) - Math.abs((b.etMinutes ?? 1e9) - want)
      );
      if (Math.abs((candidates[0].etMinutes ?? 1e9) - want) <= 180) return candidates[0];
    }
    return candidates[0];
  }

  function kalshiPayloadFromEvent(ev) {
    return {
      eventTicker: ev.eventTicker,
      awayVol: ev.awayVol,
      homeVol: ev.homeVol,
      awayCents: ev.awayCents,
      homeCents: ev.homeCents,
      awayMult: ev.awayMult,
      homeMult: ev.homeMult,
      maxMult: ev.maxMult,
      totalVol: ev.totalVol,
      highSide: ev.highSide,
      highMult: ev.highMult,
      favoriteSide: ev.favoriteSide,
      tone: ev.tone,
    };
  }

  function applyLiveKalshiToPayload(events) {
    if (!payload) return 0;
    const used = new Set();
    let applied = 0;
    const groups = [];
    if (payload.windows) {
      for (const win of Object.values(payload.windows)) {
        if (win?.matchups) groups.push(win.matchups);
      }
    }
    if (payload.matchups) groups.push(payload.matchups);

    // Match once from the first group (same games across windows), then copy by gamePk.
    const primary = groups[0] || [];
    const byPk = new Map();
    for (const m of primary) {
      const ev = matchKalshiToGame(m, events, used);
      if (!ev) continue;
      used.add(ev.eventTicker);
      const k = kalshiPayloadFromEvent(ev);
      byPk.set(m.gamePk, k);
      m.kalshi = k;
      applied += 1;
    }
    for (let i = 1; i < groups.length; i++) {
      for (const m of groups[i]) {
        if (byPk.has(m.gamePk)) m.kalshi = { ...byPk.get(m.gamePk) };
      }
    }
    return applied;
  }

  async function refreshMoneyLive() {
    if (viewMode !== "live") return;
    if (!payload?.date) return;
    moneyLiveStatus = "pending";
    refreshEl.textContent = formatNextRefresh(payload.updatedAt);
    try {
      const events = await loadLiveKalshiEvents(payload.date);
      const n = applyLiveKalshiToPayload(events);
      if (n > 0) {
        moneyLiveAt = new Date().toISOString();
        moneyLiveStatus = "live";
        applyWindow(activeWindow, { persist: false });
      } else {
        moneyLiveStatus = "cached";
      }
    } catch (err) {
      console.warn("[Money] live Kalshi refresh failed", err);
      moneyLiveStatus = "error";
    }
    refreshEl.textContent = formatNextRefresh(payload.updatedAt);
  }

  function windowData(id) {
    if (payload?.windows?.[id]) return payload.windows[id];
    if (id === "season" || !payload?.windows) {
      return {
        id: "season",
        label: "Season",
        dateRange: payload?.dateRange || null,
        matchups: payload?.matchups || [],
      };
    }
    return payload.windows.season || { matchups: [] };
  }

  function renderHistSummary() {
    if (!histSummaryEl) return;
    if (viewMode !== "historical" || !histDay) {
      histSummaryEl.hidden = true;
      histSummaryEl.textContent = "";
      if (equityWrap) equityWrap.hidden = true;
      return;
    }

    const dayStats = summarizeFilteredDay(histDay, activeWindow, edgeTopN);
    const allStats = summarizeAllTime(activeWindow, edgeTopN);
    const series = buildEquitySeries(activeWindow, edgeTopN);
    renderEquityChart(series, allStats);

    const decided = dayStats.wins + dayStats.losses;
    const hit =
      decided > 0
        ? `${dayStats.wins}-${dayStats.losses} (${((dayStats.hitRate || 0) * 100).toFixed(0)}%)`
        : "—";
    const dayPnL = formatMoneySigned(dayStats.profitDollars);
    const dayRoi =
      dayStats.roi != null ? `${(dayStats.roi * 100).toFixed(1)}% ROI` : "—";
    const atDecided = allStats.wins + allStats.losses;
    const atHit =
      atDecided > 0
        ? `${allStats.wins}-${allStats.losses} (${((allStats.hitRate || 0) * 100).toFixed(0)}%)`
        : "—";
    const atPnL = formatMoneySigned(allStats.profitDollars);
    const filterLabel = edgeTopN > 0 ? `Top ${edgeTopN}/day` : "All edges";
    histSummaryEl.hidden = false;
    histSummaryEl.innerHTML = `
      <strong>Edge (${filterLabel})</strong> ${hit} · ${dayPnL} · ${dayRoi}
      <span class="hist-sep">·</span>
      <strong>All-time</strong> ${atHit} · ${atPnL}
      ${
        allStats.roi != null
          ? `<span class="hist-sep">·</span> ${(allStats.roi * 100).toFixed(1)}% ROI`
          : ""
      }
    `;
  }

  function valueGradeFromGame(game, wid) {
    const res = game.result || {};
    const byWin = res.gradesByWindow || {};
    const g = byWin[wid] || res.grades || {};
    return g.value || null;
  }

  function edgePctOf(game, wid) {
    const v = valueGradeFromGame(game, wid);
    if (v && v.edgePct != null && Number.isFinite(Number(v.edgePct))) {
      return Number(v.edgePct);
    }
    // Fallback: recompute from frozen matchup if ungraded yet
    const m = (game.windows || {})[wid];
    if (!m) return Number.NEGATIVE_INFINITY;
    const value = valueVsMarket(m);
    return value ? Number(value.edge) : Number.NEGATIVE_INFINITY;
  }

  function topEdgeGamesForDay(day, wid, topN) {
    const games = [...(day.games || [])];
    if (!topN || topN <= 0) return games;
    return [...games]
      .sort((a, b) => edgePctOf(b, wid) - edgePctOf(a, wid))
      .slice(0, topN);
  }

  function summarizeFromBets(bets) {
    const out = {
      wins: 0,
      losses: 0,
      pushes: 0,
      stakedDollars: 0,
      profitDollars: 0,
      hitRate: null,
      roi: null,
    };
    for (const b of bets) {
      const outcome = b.outcome || "push";
      if (outcome === "win") out.wins += 1;
      else if (outcome === "loss") out.losses += 1;
      else if (outcome === "mixed") {
        /* split result — count toward sample via stake/P&L only */
      } else {
        out.pushes += 1;
      }
      if (b.stakeDollars != null && b.profitDollars != null && outcome !== "push") {
        out.stakedDollars += Number(b.stakeDollars);
        out.profitDollars += Number(b.profitDollars);
      } else if (b.stakeDollars != null && b.profitDollars != null && outcome === "push") {
        out.stakedDollars += Number(b.stakeDollars);
        out.profitDollars += Number(b.profitDollars);
      }
    }
    out.stakedDollars = Math.round(out.stakedDollars * 100) / 100;
    out.profitDollars = Math.round(out.profitDollars * 100) / 100;
    const decided = out.wins + out.losses;
    out.hitRate = decided ? out.wins / decided : null;
    out.roi = out.stakedDollars ? out.profitDollars / out.stakedDollars : null;
    return out;
  }

  function summarizeFilteredDay(day, wid, topN) {
    const picked = topEdgeGamesForDay(day, wid, topN);
    const bets = picked
      .map((g) => valueGradeFromGame(g, wid))
      .filter((v) => v && v.outcome && v.outcome !== "push" && v.profitDollars != null);
    // Also count W/L without requiring profit (missing ML)
    const allOutcomes = picked
      .map((g) => valueGradeFromGame(g, wid))
      .filter(Boolean);
    if (!bets.length && allOutcomes.length) {
      return summarizeFromBets(allOutcomes);
    }
    return summarizeFromBets(bets.length ? bets : allOutcomes);
  }

  function summarizeAllTime(wid, topN) {
    const bets = [];
    const dates = (histIndex && histIndex.dates) || [...histCache.keys()].sort();
    for (const d of dates) {
      const day = histCache.get(d);
      if (!day) continue;
      for (const g of topEdgeGamesForDay(day, wid, topN)) {
        const v = valueGradeFromGame(g, wid);
        if (v) bets.push(v);
      }
    }
    return summarizeFromBets(bets);
  }

  function buildEquitySeries(wid, topN) {
    const points = [];
    let cum = 0;
    const dates = (histIndex && histIndex.dates) || [...histCache.keys()].sort();
    for (const d of dates) {
      const day = histCache.get(d);
      if (!day) continue;
      const games = topEdgeGamesForDay(day, wid, topN).sort(
        (a, b) => (parseIsoMs(a.gameDate) || 0) - (parseIsoMs(b.gameDate) || 0)
      );
      for (const g of games) {
        const v = valueGradeFromGame(g, wid);
        if (!v || v.profitDollars == null || !Number.isFinite(Number(v.profitDollars))) continue;
        if (v.outcome !== "win" && v.outcome !== "loss") continue;
        cum += Number(v.profitDollars);
        points.push({
          date: d,
          gamePk: g.gamePk,
          label: `${g.away}@${g.home}`,
          profit: Number(v.profitDollars),
          cum: Math.round(cum * 100) / 100,
          t: parseIsoMs(g.gameDate) || 0,
        });
      }
    }
    return points;
  }

  function parseIsoMs(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  }

  function renderEquityChart(series, allStats) {
    if (!equityWrap || !equityChart) return;
    if (viewMode !== "historical") {
      equityWrap.hidden = true;
      return;
    }
    equityWrap.hidden = false;
    const filterLabel = edgeTopN > 0 ? `Top ${edgeTopN}/day` : "All edges";
    if (equityMeta) {
      equityMeta.textContent = series.length
        ? `${filterLabel} · ${formatMoneySigned(allStats.profitDollars)} cumulative · ${series.length} bets`
        : `${filterLabel} · No graded edge bets yet`;
    }

    const W = 800;
    const H = 220;
    const pad = { t: 16, r: 16, b: 28, l: 48 };
    const innerW = W - pad.l - pad.r;
    const innerH = H - pad.t - pad.b;

    if (!series.length) {
      equityChart.innerHTML = `
        <rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
        <text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#9aa6b5" font-size="14">
          Equity curve fills in as Finals grade
        </text>`;
      return;
    }

    const vals = series.map((p) => p.cum);
    let ymin = Math.min(0, ...vals);
    let ymax = Math.max(0, ...vals);
    if (ymin === ymax) {
      ymin -= 50;
      ymax += 50;
    }
    const yPad = (ymax - ymin) * 0.08;
    ymin -= yPad;
    ymax += yPad;

    const xAt = (i) => pad.l + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
    const yAt = (v) => pad.t + ((ymax - v) / (ymax - ymin)) * innerH;
    const y0 = yAt(0);

    // Build segments that stay on one side of zero for green/red fills
    function areaPaths() {
      const pos = [];
      const neg = [];
      for (let i = 0; i < series.length - 1; i++) {
        const a = series[i].cum;
        const b = series[i + 1].cum;
        const x1 = xAt(i);
        const x2 = xAt(i + 1);
        const y1 = yAt(a);
        const y2 = yAt(b);
        if (a >= 0 && b >= 0) {
          pos.push(`M ${x1} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x2} ${y0} Z`);
        } else if (a <= 0 && b <= 0) {
          neg.push(`M ${x1} ${y0} L ${x1} ${y1} L ${x2} ${y2} L ${x2} ${y0} Z`);
        } else {
          // Crosses zero — split at intercept
          const t = Math.abs(a) / (Math.abs(a) + Math.abs(b) || 1);
          const xc = x1 + (x2 - x1) * t;
          if (a > 0) {
            pos.push(`M ${x1} ${y0} L ${x1} ${y1} L ${xc} ${y0} Z`);
            neg.push(`M ${xc} ${y0} L ${x2} ${y2} L ${x2} ${y0} Z`);
          } else {
            neg.push(`M ${x1} ${y0} L ${x1} ${y1} L ${xc} ${y0} Z`);
            pos.push(`M ${xc} ${y0} L ${x2} ${y2} L ${x2} ${y0} Z`);
          }
        }
      }
      if (series.length === 1) {
        const x = xAt(0);
        const y = yAt(series[0].cum);
        const bucket = series[0].cum >= 0 ? pos : neg;
        bucket.push(`M ${x - 6} ${y0} L ${x - 6} ${y} L ${x + 6} ${y} L ${x + 6} ${y0} Z`);
      }
      return { pos, neg };
    }

    const { pos: posPaths, neg: negPaths } = areaPaths();
    const linePts = series.map((p, i) => `${xAt(i).toFixed(2)},${yAt(p.cum).toFixed(2)}`).join(" ");
    const end = series[series.length - 1].cum;
    const stroke = end >= 0 ? "#22c55e" : "#ef4444";

    // Multi-color line: draw per-segment
    let lineSegs = "";
    for (let i = 0; i < series.length - 1; i++) {
      const a = series[i].cum;
      const b = series[i + 1].cum;
      const mid = (a + b) / 2;
      const col = mid >= 0 ? "#22c55e" : "#ef4444";
      lineSegs += `<line x1="${xAt(i).toFixed(2)}" y1="${yAt(a).toFixed(2)}" x2="${xAt(i + 1).toFixed(2)}" y2="${yAt(b).toFixed(2)}" stroke="${col}" stroke-width="2.6" stroke-linecap="round"/>`;
    }

    equityChart.setAttribute("viewBox", `0 0 ${W} ${H}`);
    equityChart.innerHTML = `
      <defs>
        <linearGradient id="eqPosGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(34,197,94,0.45)"/>
          <stop offset="100%" stop-color="rgba(34,197,94,0.04)"/>
        </linearGradient>
        <linearGradient id="eqNegGrad" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="rgba(239,68,68,0.45)"/>
          <stop offset="100%" stop-color="rgba(239,68,68,0.04)"/>
        </linearGradient>
        <filter id="eqGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="2" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <line x1="${pad.l}" y1="${y0.toFixed(2)}" x2="${(W - pad.r).toFixed(2)}" y2="${y0.toFixed(2)}"
        stroke="#3d4b5c" stroke-width="1" stroke-dasharray="4 4"/>
      ${posPaths.map((d) => `<path d="${d}" fill="url(#eqPosGrad)"/>`).join("")}
      ${negPaths.map((d) => `<path d="${d}" fill="url(#eqNegGrad)"/>`).join("")}
      <g filter="url(#eqGlow)">${lineSegs}</g>
      <circle cx="${xAt(series.length - 1).toFixed(2)}" cy="${yAt(end).toFixed(2)}" r="4.5"
        fill="${stroke}" stroke="#0e1218" stroke-width="2"/>
      <text x="${pad.l - 8}" y="${yAt(ymax).toFixed(2)}" text-anchor="end" fill="#9aa6b5" font-size="11">${Math.round(ymax)}</text>
      <text x="${pad.l - 8}" y="${y0.toFixed(2)}" text-anchor="end" fill="#9aa6b5" font-size="11">0</text>
      <text x="${pad.l - 8}" y="${yAt(ymin).toFixed(2)}" text-anchor="end" fill="#9aa6b5" font-size="11">${Math.round(ymin)}</text>
      <text x="${pad.l}" y="${H - 8}" fill="#9aa6b5" font-size="11">${series[0].date}</text>
      <text x="${W - pad.r}" y="${H - 8}" text-anchor="end" fill="#9aa6b5" font-size="11">${series[series.length - 1].date}</text>
    `;
  }

  function applyWindow(id, { persist = true } = {}) {
    if (!payload) return;
    if (!payload.windows?.[id]) {
      id = payload.windows?.l7 ? "l7" : "season";
    }
    activeWindow = id;
    if (persist) localStorage.setItem("mlbEdgeWindowV2", id);

    windowBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.window === id);
    });

    const win = windowData(id);
    let matchups = win.matchups || [];

    // Historical top-N filter: only show that day's largest Val edges
    if (viewMode === "historical" && histDay && edgeTopN > 0) {
      const topPks = new Set(
        topEdgeGamesForDay(histDay, activeWindow, edgeTopN).map((g) => g.gamePk)
      );
      matchups = matchups.filter((m) => topPks.has(m.gamePk));
    }

    rows = matchups.map((m) => {
      const value = valueVsMarket(m);
      const k = m.kalshi;
      return {
        ...m,
        overallAbs: Math.abs(Number(m.overallEdge) || 0),
        valueAbs: value ? Math.abs(value.edge) : Number.NaN,
        moneyMaxMult: k && k.maxMult != null ? Number(k.maxMult) : Number.NaN,
        moneyTotal: k && k.totalVol != null ? Number(k.totalVol) : Number.NaN,
      };
    });
    const n = rows.length;
    const range = win.dateRange ? ` · FG ${win.dateRange}` : "";
    const moneyBit =
      viewMode === "live" && moneyLiveStatus === "live" && moneyLiveAt
        ? ` · Money live ${formatUpdated(moneyLiveAt)}`
        : viewMode === "historical"
          ? " · Pre-game freeze"
          : "";
    const modeBit = viewMode === "historical" ? "Historical" : "Live";
    const filterBit =
      viewMode === "historical" && edgeTopN > 0 ? ` · Top ${edgeTopN} edges` : "";
    meta.textContent = `${modeBit} · Slate: ${payload.date || "—"} (ET) · ${win.label || id} stats${range}${filterBit} · ${n} game${n === 1 ? "" : "s"} · Updated ${formatUpdated(payload.updatedAt || histDay?.updatedAt)}${moneyBit}`;
    renderHistSummary();
    render();
  }

  function historyToPayload(day) {
    const windows = {};
    for (const wid of ["season", "l7", "blend"]) {
      const matchups = [];
      for (const g of day.games || []) {
        const m = (g.windows || {})[wid];
        if (!m) continue;
        matchups.push({
          ...m,
          _result: g.result || null,
          _frozenAt: g.frozenAt || null,
        });
      }
      windows[wid] = {
        id: wid,
        label: wid === "l7" ? "Last 7 days" : wid === "blend" ? "SZN + L7" : "Season",
        matchups,
        dateRange: null,
      };
    }
    return {
      date: day.date,
      updatedAt: day.updatedAt || null,
      windows,
      matchups: (windows.l7 || windows.season || { matchups: [] }).matchups,
    };
  }

  function fillHistDates() {
    if (!histDateEl) return;
    const dates = (histIndex && histIndex.dates) || [];
    histDateEl.replaceChildren();
    if (!dates.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No history yet";
      histDateEl.appendChild(opt);
      return;
    }
    for (const d of [...dates].reverse()) {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      histDateEl.appendChild(opt);
    }
    if (!histDate || !dates.includes(histDate)) {
      histDate = dates[dates.length - 1];
    }
    histDateEl.value = histDate;
  }

  async function loadHistIndex() {
    const r = await fetch(`data/history/index.json?t=${Date.now()}`);
    if (!r.ok) throw new Error(`history index HTTP ${r.status}`);
    histIndex = await r.json();
    fillHistDates();
  }

  async function loadAllHistoryDays() {
    const dates = (histIndex && histIndex.dates) || [];
    await Promise.all(
      dates.map(async (d) => {
        if (histCache.has(d)) return;
        const r = await fetch(`data/history/${d}.json?t=${Date.now()}`);
        if (!r.ok) return;
        histCache.set(d, await r.json());
      })
    );
  }

  async function loadHistDay(dateStr) {
    if (!histCache.has(dateStr)) {
      const r = await fetch(`data/history/${dateStr}.json?t=${Date.now()}`);
      if (!r.ok) throw new Error(`history ${dateStr} HTTP ${r.status}`);
      histCache.set(dateStr, await r.json());
    }
    histDay = histCache.get(dateStr);
    histDate = dateStr;
    payload = historyToPayload(histDay);
    applyWindow(activeWindow, { persist: false });
    refreshEl.textContent = `Historical freeze · ${dateStr}. Games lock ~15 min before first pitch; edge P&L uses Val @ 4casters (1u ML + 1u spread when odds are −150…+110). Top 3/5 filters keep only the largest Val edges that day.`;
  }

  async function setViewMode(mode) {
    viewMode = mode;
    modeBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    if (histDateWrap) histDateWrap.hidden = mode !== "historical";
    if (edgeFilterWrap) edgeFilterWrap.hidden = mode !== "historical";

    if (mode === "live") {
      histDay = null;
      if (histSummaryEl) {
        histSummaryEl.hidden = true;
        histSummaryEl.textContent = "";
      }
      if (equityWrap) equityWrap.hidden = true;
      payload = livePayload;
      if (!payload) {
        meta.textContent = "Loading live slate…";
        return;
      }
      refreshEl.textContent = formatNextRefresh(payload.updatedAt);
      applyWindow(activeWindow, { persist: false });
      await refreshMoneyLive();
      return;
    }

    try {
      if (!histIndex) await loadHistIndex();
      else fillHistDates();
      await loadAllHistoryDays();
      if (!histDate) {
        meta.textContent = "No historical freezes yet. They appear once games lock ~15 min before start.";
        refreshEl.textContent = "";
        rows = [];
        if (equityWrap) equityWrap.hidden = true;
        render();
        return;
      }
      await loadHistDay(histDate);
    } catch (err) {
      meta.textContent = `Historical load failed: ${err.message}`;
      refreshEl.textContent = "History builds after the first pre-game freezes land.";
      rows = [];
      if (equityWrap) equityWrap.hidden = true;
      render();
    }
  }

  windowBtns.forEach((btn) => {
    btn.addEventListener("click", () => applyWindow(btn.dataset.window));
  });

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => setViewMode(btn.dataset.mode));
  });

  edgeFilterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      edgeTopN = Number(btn.dataset.top) || 0;
      edgeFilterBtns.forEach((b) => b.classList.toggle("active", b === btn));
      if (viewMode === "historical") applyWindow(activeWindow, { persist: false });
    });
  });

  if (histDateEl) {
    histDateEl.addEventListener("change", () => {
      if (viewMode === "historical" && histDateEl.value) {
        loadHistDay(histDateEl.value).catch((err) => {
          meta.textContent = `Historical load failed: ${err.message}`;
        });
      }
    });
  }

  fetch(`data/latest.json?t=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(async (data) => {
      livePayload = data;
      payload = data;
      if (!data.windows?.l7 && activeWindow === "l7") activeWindow = "season";
      refreshEl.textContent = formatNextRefresh(data.updatedAt);
      applyWindow(activeWindow, { persist: false });
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(refreshCountdowns, 1000);
      await refreshMoneyLive();
      // Prefetch history index so Historical is ready
      loadHistIndex().catch(() => {});
    })
    .catch((err) => {
      meta.textContent = `Failed to load data: ${err.message}`;
      refreshEl.textContent = "";
      empty.hidden = false;
      empty.textContent =
        "Could not load data/latest.json. Run scripts/fetch_matchups.py or wait for the GitHub Action.";
    });
})();
