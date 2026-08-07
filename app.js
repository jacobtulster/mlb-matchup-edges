(() => {
  const tbody = document.querySelector("#matchups tbody");
  const meta = document.querySelector("#meta");
  const empty = document.querySelector("#empty");
  const headers = [...document.querySelectorAll("#matchups thead th")];

  let rows = [];
  let sortKey = "overallEdge";
  let sortDir = "desc";

  function fmtSigned(n, digits) {
    if (n == null || Number.isNaN(n)) return "—";
    const fixed = Number(n).toFixed(digits);
    return n > 0 ? `+${fixed}` : fixed;
  }

  function signedClass(n) {
    if (n == null || Number.isNaN(n) || n === 0) return "";
    return n > 0 ? "pos" : "neg";
  }

  function compare(a, b) {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (sortKey === "matchup") {
      const as = `${a.away} @ ${a.home}`;
      const bs = `${b.away} @ ${b.home}`;
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    }
    const an = Number(av);
    const bn = Number(bv);
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
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="matchup"><span class="away">${m.away}</span> @ <span class="home">${m.home}</span></td>
        <td class="num ${signedClass(m.diffTeamWAR)}">${fmtSigned(m.diffTeamWAR, 2)}</td>
        <td class="num ${signedClass(m.diffXFIP)}">${fmtSigned(m.diffXFIP, 2)}</td>
        <td class="num ${signedClass(m.diffXwOBA)}">${fmtSigned(m.diffXwOBA, 3)}</td>
        <td class="num overall ${signedClass(m.overallEdge)}">${fmtSigned(m.overallEdge, 2)}</td>
        <td class="favored">${m.favored || "—"}</td>
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
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " ET";
    } catch {
      return iso;
    }
  }

  fetch(`data/latest.json?t=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => {
      rows = data.matchups || [];
      const n = rows.length;
      meta.textContent = `Slate: ${data.date || "—"} (ET) · Updated ${formatUpdated(data.updatedAt)} · ${n} game${n === 1 ? "" : "s"}`;
      render();
    })
    .catch((err) => {
      meta.textContent = `Failed to load data: ${err.message}`;
      empty.hidden = false;
      empty.textContent = "Could not load data/latest.json. Run scripts/fetch_matchups.py or wait for the GitHub Action.";
    });
})();
