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

  function isGamePast(m, now = Date.now()) {
    const state = m.abstractGameState || "";
    if (state === "Live" || state === "Final") return true;
    const detailed = (m.status || "").toLowerCase();
    if (detailed.includes("final") || detailed.includes("completed") || detailed.includes("in progress")) {
      return true;
    }
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
      const now = Date.now();
      const aPast = isGamePast(a, now);
      const bPast = isGamePast(b, now);
      if (aPast !== bPast) return aPast ? 1 : -1; // upcoming first, past at bottom
      const at = gameStartMs(a);
      const bt = gameStartMs(b);
      if (at == null && bt == null) return 0;
      if (at == null) return 1;
      if (bt == null) return -1;
      // asc = closest tip first among upcoming; among past, earlier start first
      return sortDir === "asc" ? at - bt : bt - at;
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

  function overallCell(m) {
    const edge = edgeFor(m.overallEdge, m.away, m.home, 2);
    const cls = betterClasses(m.overallEdge);
    return `
      <td class="metric overall-cell" data-label="Overall Edge">
        <div class="stack">
          <div class="edge overall ${edge.cls} ${cls.home === "better" ? "fav-home" : cls.away === "better" ? "fav-away" : ""}">${edge.text}</div>
          <div class="favored-note">Favors <strong class="${edge.team ? "better-team" : ""}">${m.favored || "—"}</strong></div>
        </div>
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
        </td>
        ${startCellHtml(m)}
        ${metricCell(a.teamWAR, h.teamWAR, m.diffTeamWAR, m.away, m.home, 2, "Team WAR")}
        ${metricCell(a.xFIP, h.xFIP, m.diffXFIP, m.away, m.home, 2, "xFIP")}
        ${metricCell(a.xwOBA, h.xwOBA, m.diffXwOBA, m.away, m.home, 3, "xwOBA")}
        ${overallCell(m)}
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
    rows = (win.matchups || []).map((m) => ({
      ...m,
      overallAbs: Math.abs(Number(m.overallEdge) || 0),
    }));
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
