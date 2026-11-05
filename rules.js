/* House rules for Squeek Call.
   Chips, prices, and slips. The live page is only a referee:
   one GET of STATUS_URL, then measurement.coreStatus. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SqueekCallRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STATUS_URL = "https://api.squeekchain.com/v1/status";
  const ROUND_MS = 12000;
  const START_BANK = 1000;
  const STAKES = [20, 50, 100, 200];
  const MAX_PRESET = 200;
  const STREAK_FACTORS = [10, 13, 16, 20, 25];
  const THIN_PRICE = 15;
  const MIN_TAPE = 4;
  const TAPE_MAX = 12;
  const PRICE_BASE = 11;
  const PRICE_SPAN = 29;
  const PAY_CAP = 60;
  const SLIP_CAP = 50;
  const STORAGE_KEY = "squeek-call-v2";
  const LEGACY_KEY = "squeek-call-v1";

  function clampInt(n, min, max, fallback) {
    const x = Math.round(Number(n));
    if (!Number.isFinite(x)) return fallback;
    return Math.min(max, Math.max(min, x));
  }

  function freshState() {
    return {
      v: 2,
      bank: START_BANK,
      streak: 0,
      bestBank: START_BANK,
      bestStreak: 0,
      books: 1,
      nextSlip: 1,
      stake: 50,
      muted: false,
      slips: [],
      open: null,
    };
  }

  function formatRate(tenths) {
    const t = clampInt(tenths, 0, 99, 0);
    const whole = Math.floor(t / 10);
    const frac = t % 10;
    return frac === 0 ? whole + "×" : whole + "." + frac + "×";
  }

  function formatChips(n) {
    const x = Math.round(Number(n) || 0);
    return x.toLocaleString("en-US");
  }

  function callReturn(stake, paysTenths) {
    const s = clampInt(stake, 0, 1000000, 0);
    const p = clampInt(paysTenths, 0, PAY_CAP, 0);
    return Math.round((s * p) / 10);
  }

  function classifyCore(raw) {
    const s = String(raw ?? "").trim().toUpperCase();
    if (s === "ACTIVE" || s === "RUNNING") return "RUNNING";
    if (s === "IDLE") return "IDLE";
    return null;
  }

  function factorFor(streak) {
    const i = clampInt(streak, 0, STREAK_FACTORS.length - 1, 0);
    return STREAK_FACTORS[Math.min(i, STREAK_FACTORS.length - 1)];
  }

  function tapePrice(count, n) {
    if (n < MIN_TAPE) return THIN_PRICE;
    const shareThou = Math.round((count * 1000) / n);
    return PRICE_BASE + Math.round(((1000 - shareThou) * PRICE_SPAN) / 1000);
  }

  function priceCall(run, idle, streak) {
    const r = clampInt(run, 0, 99, 0);
    const i = clampInt(idle, 0, 99, 0);
    const n = r + i;
    const factorTenths = factorFor(streak);
    const thin = n < MIN_TAPE;
    function side(count) {
      const priceTenths = tapePrice(count, n);
      const paysTenths = Math.min(PAY_CAP, Math.round((priceTenths * factorTenths) / 10));
      return { priceTenths, paysTenths };
    }
    return {
      thin,
      runCount: r,
      idleCount: i,
      n,
      factorTenths,
      running: side(r),
      idle: side(i),
    };
  }

  function pushTape(tape, entry) {
    const src = Array.isArray(tape) ? tape : [];
    if (!entry || typeof entry.running !== "boolean" || !entry.key) return src.slice();
    if (src.some((row) => row && row.key === entry.key)) return src.slice();
    const next = src.concat([{ key: String(entry.key), running: entry.running }]);
    return next.slice(-TAPE_MAX);
  }

  function stakeChoices(bank) {
    const b = clampInt(bank, 0, 1000000, 0);
    if (b <= 0) return [];
    const presets = STAKES.filter((s) => s <= b);
    if (!presets.includes(b) && (presets.length === 0 || b <= MAX_PRESET)) presets.push(b);
    return presets;
  }

  function resolveStake(bank, selected) {
    const choices = stakeChoices(bank);
    if (choices.length === 0) return 0;
    const want = clampInt(selected, 0, 1000000, choices[0]);
    if (choices.includes(want)) return want;
    const under = choices.filter((c) => c <= want);
    return under.length ? under[under.length - 1] : choices[0];
  }

  function copySlip(open, now) {
    const choice = open && (open.choice === "RUNNING" || open.choice === "IDLE") ? open.choice : null;
    const stake = clampInt(open && open.stake, 1, 100000, 0);
    if (!choice || !stake) {
      return { open: null, refund: clampInt(open && open.stake, 0, MAX_PRESET, 0) };
    }
    return {
      refund: 0,
      open: {
        n: clampInt(open.n, 1, 1000000000, 1),
        choice,
        stake,
        priceTenths: clampInt(open.priceTenths, 1, PAY_CAP, THIN_PRICE),
        factorTenths: clampInt(open.factorTenths, 1, 60, 10),
        paysTenths: clampInt(open.paysTenths, 1, PAY_CAP, THIN_PRICE),
        tapeRun: clampInt(open.tapeRun, 0, 99, 0),
        tapeIdle: clampInt(open.tapeIdle, 0, 99, 0),
        thin: Boolean(open.thin),
        lockedAt: Number.isFinite(Number(open.lockedAt)) ? Number(open.lockedAt) : now,
        deadline: Number.isFinite(Number(open.deadline)) ? Number(open.deadline) : now,
        phase: open.phase === "settling" ? "settling" : "open",
        claimAt: Number.isFinite(Number(open.claimAt)) ? Number(open.claimAt) : 0,
      },
    };
  }

  function normalize(raw, now) {
    const base = freshState();
    const t = Number.isFinite(now) ? now : Date.now();
    if (!raw || typeof raw !== "object") return base;
    const bank0 = clampInt(raw.bank, 0, 10000000, START_BANK);
    const copied = copySlip(raw.open, t);
    const slips = Array.isArray(raw.slips) ? raw.slips.filter((s) => s && typeof s === "object").slice(0, SLIP_CAP) : [];
    return {
      v: 2,
      bank: bank0 + copied.refund,
      streak: clampInt(raw.streak, 0, 99, 0),
      bestBank: Math.max(bank0 + copied.refund, clampInt(raw.bestBank, 0, 10000000, START_BANK)),
      bestStreak: clampInt(raw.bestStreak, 0, 99, 0),
      books: clampInt(raw.books, 1, 9999, 1),
      nextSlip: clampInt(raw.nextSlip, 1, 1000000000, 1),
      stake: clampInt(raw.stake, 1, MAX_PRESET, 50),
      muted: Boolean(raw.muted),
      slips,
      open: copied.open,
    };
  }

  function importV1(raw) {
    const state = freshState();
    const hist = raw && Array.isArray(raw.history) ? raw.history : [];
    const slips = [];
    hist.forEach((row) => {
      if (!row || (row.choice !== "RUNNING" && row.choice !== "IDLE")) return;
      slips.push({
        n: slips.length + 1,
        legacy: true,
        choice: row.choice,
        outcome: row.win ? "hit" : "miss",
        side: row.actual === "RUNNING" || row.actual === "IDLE" ? row.actual : null,
        coreStatus: typeof row.actual === "string" ? row.actual : null,
        rpmLabel: typeof row.rpm === "string" ? row.rpm : null,
        height: row.height != null ? String(row.height) : null,
        fetchedAt: Number.isFinite(row.at) ? new Date(row.at).toISOString() : null,
        returned: 0,
        stake: null,
      });
    });
    state.slips = slips.slice(0, SLIP_CAP);
    state.nextSlip = state.slips.reduce((m, s) => Math.max(m, s.n || 0), 0) + 1;
    if (raw && Number.isFinite(Number(raw.best))) state.bestStreak = clampInt(raw.best, 0, 99, 0);
    if (raw && Number.isFinite(Number(raw.streak))) state.streak = clampInt(raw.streak, 0, 99, 0);
    state.bestBank = START_BANK;
    return state;
  }

  function lockCall(state, details) {
    if (!state || state.open) return { ok: false, error: "slip-open" };
    const choice = details && details.choice;
    if (choice !== "RUNNING" && choice !== "IDLE") return { ok: false, error: "side" };
    const stake = resolveStake(state.bank, state.stake);
    if (stake <= 0) return { ok: false, error: "bust" };
    const now = Number(details.now);
    if (!Number.isFinite(now)) return { ok: false, error: "clock" };
    const paysTenths = clampInt(details.paysTenths, 1, PAY_CAP, THIN_PRICE);
    const open = {
      n: state.nextSlip,
      choice,
      stake,
      priceTenths: clampInt(details.priceTenths, 1, PAY_CAP, paysTenths),
      factorTenths: clampInt(details.factorTenths, 1, 60, 10),
      paysTenths,
      tapeRun: clampInt(details.tapeRun, 0, 99, 0),
      tapeIdle: clampInt(details.tapeIdle, 0, 99, 0),
      thin: Boolean(details.thin),
      lockedAt: now,
      deadline: now + ROUND_MS,
      phase: "open",
      claimAt: 0,
    };
    return {
      ok: true,
      stake,
      state: {
        ...state,
        bank: state.bank - stake,
        nextSlip: state.nextSlip + 1,
        open,
      },
    };
  }

  function claimSettle(state, now, opts) {
    if (!state || !state.open) return { state, action: "none" };
    const force = Boolean(opts && opts.force);
    const open = state.open;
    const due = now >= open.deadline || open.phase === "settling";
    if (!due) return { state, action: "wait" };
    if (open.phase === "settling" && !force && now - open.claimAt < 15000) {
      return { state, action: "wait" };
    }
    return {
      action: "fetch",
      state: {
        ...state,
        open: { ...open, phase: "settling", claimAt: now },
      },
    };
  }

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function readingFromPayload(payload, fetchedAt, error) {
    if (error) {
      return { ok: false, error: String(error), fetchedAt: fetchedAt || null };
    }
    const measurement = payload && payload.measurement;
    if (!measurement || typeof measurement !== "object") {
      return {
        ok: false,
        error: "no measurement",
        fetchedAt: fetchedAt || null,
        generatedAt: payload && payload.generatedAt ? String(payload.generatedAt) : null,
      };
    }
    const anchor = payload.builder && payload.builder.anchor;
    return {
      ok: true,
      error: null,
      coreStatus: measurement.coreStatus == null ? null : String(measurement.coreStatus),
      rpmMilli: numberOrNull(measurement.rpmMilli),
      speedMmPerSecond: numberOrNull(measurement.speedMmPerSecond),
      freshness: measurement.freshness == null ? null : String(measurement.freshness),
      provenance: measurement.provenance == null ? null : String(measurement.provenance),
      observedAt: measurement.observedAt ? String(measurement.observedAt) : null,
      receivedAt: measurement.receivedAt ? String(measurement.receivedAt) : null,
      generatedAt: payload.generatedAt ? String(payload.generatedAt) : null,
      height: anchor && anchor.blockHeight != null ? String(anchor.blockHeight) : null,
      settledThroughRound:
        anchor && anchor.settledThroughRound != null ? String(anchor.settledThroughRound) : null,
      installationId: payload.installationId ? String(payload.installationId) : null,
      fetchedAt: fetchedAt || null,
    };
  }

  function applyReading(state, reading, now) {
    if (!state || !state.open) return { state, slip: null, applied: false };
    const open = state.open;
    if (state.slips.some((s) => s && s.n === open.n && !s.legacy)) {
      return { state: { ...state, open: null }, slip: null, applied: false };
    }
    if (open.phase !== "settling" && now + 50 < open.deadline) {
      return { state, slip: null, applied: false };
    }
    let outcome = "push";
    let side = null;
    let reason = null;
    if (!reading || !reading.ok) {
      reason = (reading && reading.error) || "no answer";
    } else {
      side = classifyCore(reading.coreStatus);
      if (!side) {
        reason = reading.coreStatus ? "coreStatus " + reading.coreStatus : "no coreStatus";
      } else if (side === open.choice) {
        outcome = "hit";
      } else {
        outcome = "miss";
      }
    }
    let bank = state.bank;
    let streak = state.streak;
    let returned = 0;
    if (outcome === "hit") {
      returned = callReturn(open.stake, open.paysTenths);
      bank += returned;
      streak += 1;
    } else if (outcome === "push") {
      returned = open.stake;
      bank += open.stake;
    } else {
      streak = 0;
    }
    const src = reading && reading.ok ? reading : reading || {};
    const slip = {
      n: open.n,
      choice: open.choice,
      stake: open.stake,
      paysTenths: open.paysTenths,
      priceTenths: open.priceTenths,
      factorTenths: open.factorTenths,
      tapeRun: open.tapeRun,
      tapeIdle: open.tapeIdle,
      thin: open.thin,
      outcome,
      returned,
      reason,
      side,
      coreStatus: src.coreStatus || null,
      rpmMilli: src.rpmMilli != null ? src.rpmMilli : null,
      speedMmPerSecond: src.speedMmPerSecond != null ? src.speedMmPerSecond : null,
      freshness: src.freshness || null,
      provenance: src.provenance || null,
      observedAt: src.observedAt || null,
      receivedAt: src.receivedAt || null,
      generatedAt: src.generatedAt || null,
      height: src.height || null,
      settledThroughRound: src.settledThroughRound || null,
      installationId: src.installationId || null,
      fetchedAt: src.fetchedAt || null,
      lockedAt: open.lockedAt,
    };
    return {
      applied: true,
      slip,
      state: {
        ...state,
        bank,
        streak,
        bestBank: Math.max(state.bestBank, bank),
        bestStreak: Math.max(state.bestStreak, streak),
        open: null,
        slips: [slip, ...state.slips].slice(0, SLIP_CAP),
      },
    };
  }

  function bankStreak(state) {
    if (!state || state.open) return { ok: false, error: "slip-open" };
    if (!state.streak) return { ok: false, error: "no-streak" };
    return { ok: true, state: { ...state, streak: 0 } };
  }

  function openBook(state) {
    if (!state || state.open) return { ok: false, error: "slip-open" };
    if (state.bank > 0) return { ok: false, error: "has-chips" };
    const bank = START_BANK;
    return {
      ok: true,
      state: {
        ...state,
        bank,
        books: state.books + 1,
        streak: 0,
        bestBank: Math.max(state.bestBank, bank),
      },
    };
  }

  return {
    STATUS_URL,
    ROUND_MS,
    START_BANK,
    STAKES,
    STREAK_FACTORS,
    THIN_PRICE,
    MIN_TAPE,
    TAPE_MAX,
    PAY_CAP,
    SLIP_CAP,
    STORAGE_KEY,
    LEGACY_KEY,
    freshState,
    formatRate,
    formatChips,
    callReturn,
    classifyCore,
    priceCall,
    pushTape,
    stakeChoices,
    resolveStake,
    normalize,
    importV1,
    lockCall,
    claimSettle,
    readingFromPayload,
    applyReading,
    bankStreak,
    openBook,
  };
});
