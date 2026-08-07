(() => {
  const tbody = document.querySelector("#matchups tbody");
  const meta = document.querySelector("#meta");
  const refreshEl = document.querySelector("#refresh");
  const empty = document.querySelector("#empty");
  const headers = [...document.querySelectorAll("#matchups thead th")];

  let rows = [];
  let sortKey = "overallAbs";
  let sortDir = "desc";

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

  function compare(a, b) {
    if (sortKey === "matchup") {
      const as = `${a.away} @ ${a.home}`;
      const bs = `${b.away} @ ${b.home}`;
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
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

  function metricCell(awayVal, homeVal, homeDiff, away, home, digits) {
    const edge = edgeFor(homeDiff, away, home, digits);
    return `
      <td class="metric">
        <div class="stack">
          <div class="stat-line"><span class="abb">${away}</span><span class="val">${fmt(awayVal, digits)}</span></div>
          <div class="stat-line"><span class="abb">${home}</span><span class="val">${fmt(homeVal, digits)}</span></div>
          <div class="edge ${edge.cls}">${edge.text}</div>
        </div>
      </td>
    `;
  }

  function overallCell(m) {
    const edge = edgeFor(m.overallEdge, m.away, m.home, 2);
    return `
      <td class="metric overall-cell">
        <div class="stack">
          <div class="edge overall ${edge.cls}">${edge.text}</div>
          <div class="favored-note">Favors <strong>${m.favored || "—"}</strong></div>
        </div>
      </td>
    `;
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
      tr.innerHTML = `
        <td class="matchup">
          <span class="away">${m.away}</span>
          <span class="at">@</span>
          <span class="home">${m.home}</span>
        </td>
        ${metricCell(a.teamWAR, h.teamWAR, m.diffTeamWAR, m.away, m.home, 2)}
        ${metricCell(a.xFIP, h.xFIP, m.diffXFIP, m.away, m.home, 2)}
        ${metricCell(a.xwOBA, h.xwOBA, m.diffXwOBA, m.away, m.home, 3)}
        ${overallCell(m)}
      `;
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    updateHeaderState();
  }

  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = th.dataset.type === "number" ? "desc" : "asc";
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

  fetch(`data/latest.json?t=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => {
      rows = (data.matchups || []).map((m) => ({
        ...m,
        overallAbs: Math.abs(Number(m.overallEdge) || 0),
      }));
      const n = rows.length;
      meta.textContent = `Slate: ${data.date || "—"} (ET) · ${n} game${n === 1 ? "" : "s"} · Updated ${formatUpdated(data.updatedAt)}`;
      refreshEl.textContent = formatNextRefresh(data.updatedAt);
      render();
    })
    .catch((err) => {
      meta.textContent = `Failed to load data: ${err.message}`;
      refreshEl.textContent = "";
      empty.hidden = false;
      empty.textContent =
        "Could not load data/latest.json. Run scripts/fetch_matchups.py or wait for the GitHub Action.";
    });
})();
