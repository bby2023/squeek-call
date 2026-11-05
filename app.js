/* Squeek Call — RUNNING/IDLE calls settled on live api.squeekchain.com status. */
(() => {
  const STATUS_URL = "https://api.squeekchain.com/v1/status";
  const SETTLEMENTS_URL = "https://api.squeekchain.com/v1/settlements";
  const STATS_URL = "https://api.squeekchain.com/v1/measurement/stats?range=7d";
  const ROUND_SECS = 12;
  const POLL_MS = 3000;
  const PULSE_MAX = 48;
  const STORAGE_KEY = "squeek-call-v1";

  // TODO: maybe let people pick 8s / 12s / 20s later. 12 felt right while idle tonight.
  const els = {
    coreStatus: document.getElementById("coreStatus"),
    rpm: document.getElementById("rpm"),
    work: document.getElementById("work"),
    height: document.getElementById("height"),
    distance: document.getElementById("distance"),
    fresh: document.getElementById("fresh"),
    settledRound: document.getElementById("settledRound"),
    observed: document.getElementById("observed"),
    feedError: document.getElementById("feedError"),
    score: document.getElementById("score"),
    streak: document.getElementById("streak"),
    rounds: document.getElementById("rounds"),
    accuracy: document.getElementById("accuracy"),
    best: document.getElementById("best"),
    edge: document.getElementById("edge"),
    phase: document.getElementById("phase"),
    countdown: document.getElementById("countdown"),
    result: document.getElementById("result"),
    history: document.getElementById("history"),
    histEmpty: document.getElementById("histEmpty"),
    btnRun: document.getElementById("btnRun"),
    btnIdle: document.getElementById("btnIdle"),
    btnAgain: document.getElementById("btnAgain"),
    wheel: document.getElementById("wheel"),
    wheelLabel: document.getElementById("wheelLabel"),
    pulse: document.getElementById("pulse"),
    pulseMeta: document.getElementById("pulseMeta"),
    settlements: document.getElementById("settlements"),
    setError: document.getElementById("setError"),
    lifeWork: document.getElementById("lifeWork"),
    lifeBlocks: document.getElementById("lifeBlocks"),
    lifeSets: document.getElementById("lifeSets"),
    lifeDist: document.getElementById("lifeDist"),
    lifeDays: document.getElementById("lifeDays"),
    lifeFirst: document.getElementById("lifeFirst"),
  };

  const state = {
    latest: null,
    score: 0,
    streak: 0,
    rounds: 0,
    hits: 0,
    best: 0,
    lock: false,
    timer: null,
    pulse: [],
    angle: 0,
    lastTick: performance.now(),
    history: [],
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      state.score = saved.score || 0;
      state.streak = saved.streak || 0;
      state.rounds = saved.rounds || 0;
      state.hits = saved.hits || 0;
      state.best = saved.best || 0;
      state.history = Array.isArray(saved.history) ? saved.history.slice(0, 20) : [];
    } catch (_) {
      /* corrupt localStorage — start clean */
    }
  }

  function save() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        score: state.score,
        streak: state.streak,
        rounds: state.rounds,
        hits: state.hits,
        best: state.best,
        history: state.history.slice(0, 20),
      })
    );
  }

  function classify(status) {
    const s = String(status || "").toUpperCase();
    // API usually says RUNNING / IDLE; keep a couple aliases just in case
    if (s === "RUNNING" || s === "ACTIVE" || s === "SPINNING") return "RUNNING";
    return "IDLE";
  }

  function fmtRpm(milli) {
    if (milli == null) return "—";
    return (Number(milli) / 1000).toFixed(2);
  }

  function fmtDist(mm) {
    if (mm == null) return "—";
    return (Number(mm) / 1000).toFixed(1) + " m";
  }

  function paintScore() {
    els.score.textContent = String(state.score);
    els.streak.textContent = String(state.streak);
    els.rounds.textContent = String(state.rounds);
    els.best.textContent = String(state.best);
    if (state.rounds === 0) {
      els.accuracy.textContent = "—";
      els.edge.textContent = "—";
    } else {
      const pct = (100 * state.hits) / state.rounds;
      els.accuracy.textContent = pct.toFixed(0) + "%";
      const edge = pct - 50;
      els.edge.textContent = (edge >= 0 ? "+" : "") + edge.toFixed(0) + "pp";
      els.edge.dataset.tone = edge >= 0 ? "up" : "down";
    }
  }

  function paintHistory() {
    els.history.innerHTML = "";
    state.history.forEach((row) => {
      const li = document.createElement("li");
      li.className = row.win ? "hit" : "miss";
      li.innerHTML =
        `<span class="call-tag">${row.choice}</span>` +
        `<span class="arrow">→</span>` +
        `<span class="actual">${row.actual}</span>` +
        `<span class="mark">${row.win ? "hit" : "miss"}</span>` +
        `<span class="meta">RPM ${row.rpm} · blk ${row.height}</span>`;
      els.history.appendChild(li);
    });
    els.histEmpty.hidden = state.history.length > 0;
  }

  function paintLive(data) {
    state.latest = data;
    const m = data.measurement || {};
    const b = (data.builder && data.builder.anchor) || {};
    const core = classify(m.coreStatus);
    els.coreStatus.textContent = m.coreStatus || "—";
    els.coreStatus.dataset.state = core.toLowerCase();
    els.rpm.textContent = fmtRpm(m.rpmMilli);
    els.work.textContent = m.cumulativeWorkUnits ?? "—";
    els.height.textContent = b.blockHeight ?? "—";
    els.distance.textContent = fmtDist(m.distanceMm);
    els.fresh.textContent = m.freshness || "—";
    els.settledRound.textContent = b.settledThroughRound ?? "—";
    els.observed.textContent = m.observedAt
      ? new Date(m.observedAt).toLocaleTimeString()
      : "—";
    els.wheelLabel.textContent =
      core === "RUNNING"
        ? fmtRpm(m.rpmMilli) + " RPM · running"
        : "idle";
    state.pulse.push({
      t: Date.now(),
      running: core === "RUNNING",
      rpm: Number(m.rpmMilli) || 0,
    });
    if (state.pulse.length > PULSE_MAX) state.pulse.shift();
    drawPulse();
    els.feedError.hidden = true;
  }

  async function refreshStatus() {
    try {
      const res = await fetch(STATUS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      paintLive(await res.json());
    } catch (err) {
      els.feedError.hidden = false;
      els.feedError.textContent = "Can't reach status feed: " + err.message;
    }
  }

  async function refreshSettlements() {
    try {
      const res = await fetch(SETTLEMENTS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const rows = data.recentSettlements || [];
      els.settlements.innerHTML = "";
      rows.slice(0, 8).forEach((s) => {
        const li = document.createElement("li");
        const when = s.blockTimestamp
          ? new Date(s.blockTimestamp).toLocaleString()
          : "—";
        const tx = s.transactionHash || "";
        const short = tx ? tx.slice(0, 10) + "…" + tx.slice(-4) : "—";
        const href = tx
          ? "https://eth-sepolia.blockscout.com/tx/" + tx
          : "#";
        li.innerHTML =
          `<a href="${href}" target="_blank" rel="noopener noreferrer">${short}</a>` +
          `<span>rounds ${s.previousSettledThroughRound}→${s.settledThroughRound}</span>` +
          `<span>+${s.workAdded} work · blk ${s.blockHeight}</span>` +
          `<span class="when">${when}</span>`;
        els.settlements.appendChild(li);
      });
      els.setError.hidden = true;
    } catch (err) {
      els.setError.hidden = false;
      els.setError.textContent = "Settlements unreachable: " + err.message;
    }
  }

  async function refreshStats() {
    try {
      const res = await fetch(STATS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const life = data.lifetime || {};
      els.lifeWork.textContent = life.acceptedWorkUnits ?? "—";
      els.lifeBlocks.textContent = life.settledBlockCount ?? "—";
      els.lifeSets.textContent = life.settlementCount ?? "—";
      els.lifeDist.textContent = life.observedDistanceMm
        ? (Number(life.observedDistanceMm) / 1000).toFixed(1)
        : "—";
      els.lifeDays.textContent = life.activeDayCount ?? "—";
      els.lifeFirst.textContent = life.firstObservedAt
        ? new Date(life.firstObservedAt).toLocaleDateString()
        : "—";
    } catch (_) {
      /* lifetime strip is nice-to-have */
    }
  }

  function drawPulse() {
    const canvas = els.pulse;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 680;
    const cssH = 48;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const n = state.pulse.length;
    if (n === 0) return;
    const w = cssW / PULSE_MAX;
    state.pulse.forEach((p, i) => {
      const x = cssW - (n - i) * w;
      ctx.fillStyle = p.running ? "#3dffa8" : "#2a3344";
      const h = p.running ? 10 + Math.min(28, p.rpm / 120) : 8;
      ctx.fillRect(x + 1, (cssH - h) / 2, Math.max(2, w - 2), h);
    });
    const runCount = state.pulse.filter((p) => p.running).length;
    els.pulseMeta.textContent =
      `${n} samples · ${runCount} running / ${n - runCount} idle`;
  }

  function drawWheel(now) {
    const canvas = els.wheel;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const size = 220;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rpmMilli = Number(state.latest?.measurement?.rpmMilli) || 0;
    const rpm = rpmMilli / 1000;
    const dt = (now - state.lastTick) / 1000;
    state.lastTick = now;
    // rpm → deg/sec (360° per rev)
    state.angle = (state.angle + rpm * 6 * dt) % 360;

    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    const r = 86;

    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.strokeStyle = "#243041";
    ctx.lineWidth = 10;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((state.angle * Math.PI) / 180);

    for (let i = 0; i < 8; i++) {
      ctx.rotate(Math.PI / 4);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -r);
      ctx.strokeStyle = "#3dffa8";
      ctx.globalAlpha = 0.35 + (i % 2) * 0.25;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#e8ecf2";
    ctx.lineWidth = 4;
    ctx.stroke();

    // magnet mark (matches the hardware story)
    ctx.beginPath();
    ctx.arc(0, -r, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ffb020";
    ctx.fill();

    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fillStyle = "#14181f";
    ctx.fill();
    ctx.strokeStyle = "#8b95a7";
    ctx.lineWidth = 2;
    ctx.stroke();

    // sensor tick
    ctx.fillStyle = "#ff5c7a";
    ctx.fillRect(cx - 3, cy - r - 18, 6, 10);

    requestAnimationFrame(drawWheel);
  }

  function setCallEnabled(on) {
    els.btnRun.disabled = !on;
    els.btnIdle.disabled = !on;
  }

  function startCall(choice) {
    if (state.lock || !state.latest) return;
    state.lock = true;
    setCallEnabled(false);
    els.btnAgain.hidden = true;
    els.result.textContent = "";
    els.result.className = "result";
    els.phase.textContent =
      "Called " + choice + ". Clock running — settle re-fetches /v1/status.";
    let left = ROUND_SECS;
    els.countdown.textContent = left + "s";
    clearInterval(state.timer);
    state.timer = setInterval(async () => {
      left -= 1;
      els.countdown.textContent = left + "s";
      if (left > 0) return;
      clearInterval(state.timer);
      // settlement: fresh pull, not the painted snapshot from a second ago
      await refreshStatus();
      const actual = classify(state.latest?.measurement?.coreStatus);
      const win = actual === choice;
      state.rounds += 1;
      if (win) {
        state.score += 1;
        state.hits += 1;
        state.streak += 1;
        if (state.streak > state.best) state.best = state.streak;
        els.result.textContent = "Hit — feed said " + actual + ".";
        els.result.className = "result win";
      } else {
        state.streak = 0;
        els.result.textContent =
          "Miss — feed said " + actual + " (you called " + choice + ").";
        els.result.className = "result lose";
      }
      state.history.unshift({
        choice,
        actual,
        win,
        rpm: fmtRpm(state.latest?.measurement?.rpmMilli),
        height: state.latest?.builder?.anchor?.blockHeight ?? "—",
        at: Date.now(),
      });
      if (state.history.length > 20) state.history.pop();
      paintScore();
      paintHistory();
      save();
      els.phase.textContent = "Round settled from a fresh /v1/status pull.";
      els.btnAgain.hidden = false;
      state.lock = false;
    }, 1000);
  }

  els.btnRun.addEventListener("click", () => startCall("RUNNING"));
  els.btnIdle.addEventListener("click", () => startCall("IDLE"));
  els.btnAgain.addEventListener("click", () => {
    els.btnAgain.hidden = true;
    els.countdown.textContent = "—";
    els.phase.textContent =
      "Pick RUNNING or IDLE. Clock runs 12s, then we settle on a fresh status pull.";
    els.result.textContent = "";
    setCallEnabled(true);
  });

  window.addEventListener("keydown", (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (state.lock || els.btnRun.disabled) return;
    if (e.key === "r" || e.key === "R") startCall("RUNNING");
    if (e.key === "i" || e.key === "I") startCall("IDLE");
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshStatus();
  });

  load();
  paintScore();
  paintHistory();
  refreshStatus();
  refreshSettlements();
  refreshStats();
  setInterval(refreshStatus, POLL_MS);
  setInterval(refreshSettlements, 60000);
  setInterval(refreshStats, 120000);
  requestAnimationFrame(drawWheel);
})();
