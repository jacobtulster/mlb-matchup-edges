(() => {
  const tbody = document.querySelector("#matchups tbody");
  const meta = document.querySelector("#meta");
  const refreshEl = document.querySelector("#refresh");
  const empty = document.querySelector("#empty");
  const headers = [...document.querySelectorAll("#matchups thead th")];
  const sortKeyEl = document.querySelector("#sort-key");
  const sortDirBtn = document.querySelector("#sort-dir");

  let rows = [];
  let sortKey = "overallAbs";
  let sortDir = "desc";
  let countdownTimer = null;
  let payload = null;
  let activeWindow = localStorage.getItem("mlbEdgeWindow") || "season";
  const windowBtns = [...document.querySelectorAll(".window-btn")];

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

    if (sortKey === "valueAbs") {
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

  function syncSortControls() {
    if (sortKeyEl) sortKeyEl.value = sortKey;
    if (sortDirBtn) sortDirBtn.textContent = sortDir === "asc" ? "↑" : "↓";
  }

  function defaultDirFor(key) {
    if (key === "matchup") return "asc";
    if (key === "gameStart") return "asc";
    return "desc";
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
      sortKey = sortKeyEl.value;
      sortDir = defaultDirFor(sortKey);
      render();
    });
  }
  if (sortDirBtn) {
    sortDirBtn.addEventListener("click", () => {
      sortDir = sortDir === "asc" ? "desc" : "asc";
      render();
    });
  }

  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = defaultDirFor(key);
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
    const updatedNote = isoUpdated ? `Last data pull: ${formatUpdated(isoUpdated)}. ` : "";
    return `${updatedNote}Next scheduled refresh: ~${nextEt} ET (every 6 hours). Hard-refresh the page after that to see new numbers.`;
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
    if (!payload.windows?.[id] && id !== "season") id = "season";
    activeWindow = id;
    if (persist) localStorage.setItem("mlbEdgeWindow", id);

    windowBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.window === id);
    });

    const win = windowData(id);
    rows = (win.matchups || []).map((m) => {
      const value = valueVsMarket(m);
      return {
        ...m,
        overallAbs: Math.abs(Number(m.overallEdge) || 0),
        valueAbs: value ? Math.abs(value.edge) : Number.NaN,
      };
    });
    const n = rows.length;
    const range = win.dateRange ? ` · FG ${win.dateRange}` : "";
    meta.textContent = `Slate: ${payload.date || "—"} (ET) · ${win.label || id} stats${range} · ${n} game${n === 1 ? "" : "s"} · Updated ${formatUpdated(payload.updatedAt)}`;
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
    .then((data) => {
      payload = data;
      if (!data.windows?.l7 && activeWindow === "l7") activeWindow = "season";
      refreshEl.textContent = formatNextRefresh(data.updatedAt);
      applyWindow(activeWindow, { persist: false });
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = setInterval(refreshCountdowns, 1000);
    })
    .catch((err) => {
      meta.textContent = `Failed to load data: ${err.message}`;
      refreshEl.textContent = "";
      empty.hidden = false;
      empty.textContent =
        "Could not load data/latest.json. Run scripts/fetch_matchups.py or wait for the GitHub Action.";
    });
})();
