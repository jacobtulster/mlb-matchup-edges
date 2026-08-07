(() => {
  const tbody = document.querySelector("#matchups tbody");
  const meta = document.querySelector("#meta");
  const refreshEl = document.querySelector("#refresh");
  const empty = document.querySelector("#empty");
  const headers = [...document.querySelectorAll("#matchups thead th")];
  const sortKeyEl = document.querySelector("#sort-key");
  const sortDirBtn = document.querySelector("#sort-dir");

  let rows = [];
  let sortKey = "valueAbs";
  let sortDir = "desc";
  let countdownTimer = null;
  let payload = null;
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
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      }) + " ET";
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
    return `
      <td class="start ${past ? "past" : "upcoming"}" data-label="Start" data-game-pk="${m.gamePk || ""}">
        <span class="start-time">${time}</span>
        <span class="start-sep">|</span>
        <span class="countdown">${count}</span>
      </td>
    `;
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

  // Overall Edge → home win prob. Scale ~4 keeps strong slate edges near realistic ML bands.
  const EDGE_LOGISTIC_SCALE = 4;

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
    if (homeEdge >= awayEdge) {
      return { team: m.home, edge: homeEdge, side: "home" };
    }
    return { team: m.away, edge: awayEdge, side: "away" };
  }

  function modelCell(m) {
    const model = modelOddsFromEdge(m.overallEdge);
    const hl = model
      ? oddsHighlight(model.homeProb, model.awayProb)
      : { homeCls: "home", awayCls: "away" };
    const homePrice = model ? formatAmerican(model.home) : "—";
    const awayPrice = model ? formatAmerican(model.away) : "—";
    const value = valueVsMarket(m);
    const valueHtml =
      value && Math.abs(value.edge) >= 0.005
        ? `<div class="value-line ${value.edge > 0 ? "plus" : "minus"}" title="Model win% minus de-vigged market win% (best side)">
             Val ${value.team} ${value.edge > 0 ? "+" : ""}${(value.edge * 100).toFixed(1)}%
           </div>`
        : `<div class="value-line spacer" aria-hidden="true">&nbsp;</div>`;
    return `
      <td class="odds model-cell" data-label="Model">
        <div class="odds-stack">
          <div class="odds-line ${hl.homeCls}"><span class="abb">${m.home}</span><span class="price">${homePrice}</span></div>
          <div class="odds-line ${hl.awayCls}"><span class="abb">${m.away}</span><span class="price">${awayPrice}</span></div>
        </div>
        ${valueHtml}
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
            <div class="odds-line"><span class="abb">${m.home}</span><span class="price">—</span></div>
            <div class="odds-line"><span class="abb">${m.away}</span><span class="price">—</span></div>
          </div>
          <div class="value-line spacer" aria-hidden="true">&nbsp;</div>
        </td>
      `;
    }
    const hl = oddsHighlight(fair.homeProb, fair.awayProb);
    const title = `${o.provider || "ESPN"} raw ${o.home}/${o.away}`;
    return `
      <td class="odds market-cell" data-label="Market" title="${title}">
        <div class="odds-stack">
          <div class="odds-line ${hl.homeCls}"><span class="abb">${m.home}</span><span class="price">${fair.home}</span></div>
          <div class="odds-line ${hl.awayCls}"><span class="abb">${m.away}</span><span class="price">${fair.away}</span></div>
        </div>
        <div class="value-line spacer" aria-hidden="true">&nbsp;</div>
      </td>
    `;
  }

  function formatUsd(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    return (
      "$" +
      Math.round(Number(n)).toLocaleString("en-US", {
        maximumFractionDigits: 0,
      })
    );
  }

  function formatMult(n) {
    if (n == null || !Number.isFinite(Number(n)) || Number(n) <= 0) return "—";
    return `${Number(n).toFixed(1)}x`;
  }

  function moneyCell(m) {
    const k = m.kalshi;
    if (!k) {
      return `
        <td class="odds money-cell" data-label="Money">
          <div class="odds-stack">
            <div class="odds-line"><span class="abb">${m.home}</span><span class="price">—</span></div>
            <div class="odds-line"><span class="abb">${m.away}</span><span class="price">—</span></div>
          </div>
          <div class="value-line spacer" aria-hidden="true">&nbsp;</div>
        </td>
      `;
    }
    const homeMore = (k.homeVol || 0) > (k.awayVol || 0) + 1e-9;
    const awayMore = (k.awayVol || 0) > (k.homeVol || 0) + 1e-9;
    const homeCls = homeMore ? "home better" : awayMore ? "home worse" : "home";
    const awayCls = awayMore ? "away better" : homeMore ? "away worse" : "away";
    const highTeam = k.highSide === "home" ? m.home : m.away;
    const tone = k.tone || "muted";
    const title = `Kalshi ${k.eventTicker || ""} · total ${formatUsd(k.totalVol)}`;
    return `
      <td class="odds money-cell" data-label="Money" title="${title}">
        <div class="odds-stack money-stack">
          <div class="odds-line ${homeCls}"><span class="abb">${m.home}</span><span class="price">${formatUsd(k.homeVol)}</span></div>
          <div class="odds-line ${awayCls}"><span class="abb">${m.away}</span><span class="price">${formatUsd(k.awayVol)}</span></div>
        </div>
        <div class="value-line money-mult money-${tone}">${formatMult(k.highMult)} ${highTeam}</div>
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
        ${metricCell(a.teamWAR, h.teamWAR, m.diffTeamWAR, m.away, m.home, 2, "Team WAR")}
        ${metricCell(a.xFIP, h.xFIP, m.diffXFIP, m.away, m.home, 2, "xFIP")}
        ${metricCell(a.xwOBA, h.xwOBA, m.diffXwOBA, m.away, m.home, 3, "xwOBA")}
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
    let tone = "muted";
    if (favoriteSide === "away" && awayM != null && homeM != null && awayM < homeM) tone = "green";
    else if (favoriteSide === "home" && homeM != null && awayM != null && homeM < awayM) tone = "green";
    else if (maxMult >= 5) tone = "red";
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
    rows = (win.matchups || []).map((m) => {
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
      moneyLiveStatus === "live" && moneyLiveAt
        ? ` · Money live ${formatUpdated(moneyLiveAt)}`
        : "";
    meta.textContent = `Slate: ${payload.date || "—"} (ET) · ${win.label || id} stats${range} · ${n} game${n === 1 ? "" : "s"} · Updated ${formatUpdated(payload.updatedAt)}${moneyBit}`;
    render();
  }

  windowBtns.forEach((btn) => {
    btn.addEventListener("click", () => applyWindow(btn.dataset.window));
  });

  fetch(`data/latest.json?t=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(async (data) => {
      payload = data;
      if (!data.windows?.l7 && activeWindow === "l7") activeWindow = "season";
      refreshEl.textContent = formatNextRefresh(data.updatedAt);
      applyWindow(activeWindow, { persist: false });
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(refreshCountdowns, 1000);
      await refreshMoneyLive();
    })
    .catch((err) => {
      meta.textContent = `Failed to load data: ${err.message}`;
      refreshEl.textContent = "";
      empty.hidden = false;
      empty.textContent =
        "Could not load data/latest.json. Run scripts/fetch_matchups.py or wait for the GitHub Action.";
    });
})();
