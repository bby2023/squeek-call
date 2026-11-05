/* House rules for Squeek Call.
   Chips, prices, and slips. A slip settles from one GET of STATUS_URL,
   then measurement.coreStatus. Settlements, stats, and account reads
   are copies for the desk. They never choose the side or the price.
   A Sign-In with Ethereum session names whose browser book is open.
   The signature is checked locally. Chips stay in localStorage. */
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
  const WALLET_PREFIX = "squeek-call-v3:";
  const SESSION_KEY = "squeek-call-session";
  const SETTLEMENTS_URL = "https://api.squeekchain.com/v1/settlements?range=24h";
  const STATS_URL = "https://api.squeekchain.com/v1/measurement/stats?range=7d";
  const API_ORIGIN = "https://api.squeekchain.com";
  const SEPOLIA_CHAIN_ID = 11155111;
  const SESSION_MS = 12 * 60 * 60 * 1000;
  const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
  const SKEW_MS = 5 * 60 * 1000;
  const SIWE_STATEMENT = "Open the house-chip book for this address. Twelve-second calls settle on measurement.coreStatus. This signature does not send a transaction or move SQK.";

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
        signer: normalizeAddress(open.signer),
        sessionNonce: validNonce(open.sessionNonce),
        pollCore: shortText(open.pollCore, 40),
        pollObservedAt: shortText(open.pollObservedAt, 80),
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
    if (details.signer != null && details.signer !== "" && !normalizeAddress(details.signer)) {
      return { ok: false, error: "signer" };
    }
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
      signer: normalizeAddress(details.signer),
      sessionNonce: validNonce(details.sessionNonce),
      pollCore: shortText(details.pollCore, 40),
      pollObservedAt: shortText(details.pollObservedAt, 80),
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

  function applyReading(state, reading, now, context) {
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
      signer: open.signer || null,
      sessionNonce: open.sessionNonce || null,
      pollCore: open.pollCore || null,
      pollObservedAt: open.pollObservedAt || null,
      context: readContext(context),
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

  function shortText(value, max) {
    if (value == null || value === "") return null;
    return String(value).slice(0, max);
  }

  function validNonce(value) {
    const nonce = String(value || "");
    return /^[A-Za-z0-9]{8,32}$/.test(nonce) ? nonce : null;
  }

  function normalizeAddress(value) {
    const raw = String(value || "").trim();
    return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
  }

  function shortAddress(address) {
    const raw = String(address || "").trim();
    if (!normalizeAddress(raw)) return "";
    return raw.slice(0, 6) + "…" + raw.slice(-4);
  }

  function shortTx(tx) {
    const raw = String(tx || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return "";
    return raw.slice(0, 6) + "…" + raw.slice(-4);
  }

  function bookStorageKey(address) {
    if (address == null || address === "") return STORAGE_KEY;
    const normalized = normalizeAddress(address);
    return normalized ? WALLET_PREFIX + normalized : null;
  }

  function accountUrl(address) {
    const normalized = normalizeAddress(address);
    if (!normalized) return null;
    return API_ORIGIN + "/v1/accounts/" + normalized + "?limit=1";
  }

  function explorerTx(tx) {
    const raw = String(tx || "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
    return "https://sepolia.etherscan.io/tx/" + raw;
  }

  function readingKey(reading) {
    if (!reading || !reading.ok) return null;
    const stamp = reading.observedAt || reading.generatedAt;
    return stamp ? String(stamp) : null;
  }

  function formatBaseUnits(raw, decimals) {
    const places = decimals == null ? 18 : decimals;
    const text = String(raw == null ? "" : raw).trim();
    if (!/^\d+$/.test(text) || !Number.isInteger(places) || places < 0 || places > 36) return null;
    const padded = text.padStart(places + 1, "0");
    const whole = padded.slice(0, padded.length - places).replace(/^0+(?=\d)/, "");
    const frac = padded.slice(padded.length - places).replace(/0+$/, "").slice(0, 4);
    return frac ? whole + "." + frac : whole;
  }

  function formatBps(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return (n / 100).toFixed(2) + "%";
  }

  function defaultResources(address) {
    const normalized = normalizeAddress(address);
    return [
      STATUS_URL,
      normalized ? API_ORIGIN + "/v1/accounts/" + normalized : API_ORIGIN + "/v1/accounts/",
    ];
  }

  function buildSiwe(fields) {
    const src = fields || {};
    const domain = String(src.domain || "");
    const address = String(src.address || "");
    const uri = String(src.uri || "");
    const nonce = String(src.nonce || "");
    const issuedAt = String(src.issuedAt || "");
    const expirationTime = String(src.expirationTime || "");
    const statement = src.statement != null ? String(src.statement) : SIWE_STATEMENT;
    const chainId = src.chainId != null ? String(src.chainId) : String(SEPOLIA_CHAIN_ID);
    const resources = Array.isArray(src.resources) ? src.resources.map(String) : defaultResources(address);
    if (!domain || /\s/.test(domain)) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    if (!uri || /\s/.test(uri)) return null;
    if (!validNonce(nonce)) return null;
    if (!issuedAt || !expirationTime || /\s/.test(issuedAt) || /\s/.test(expirationTime)) return null;
    if (!statement || /[\r\n]/.test(statement)) return null;
    if (!/^\d+$/.test(chainId)) return null;
    if (!resources.length || resources.some((item) => !item || /\s/.test(item))) return null;
    const lines = [
      domain + " wants you to sign in with your Ethereum account:",
      address,
      "",
      statement,
      "",
      "URI: " + uri,
      "Version: 1",
      "Chain ID: " + chainId,
      "Nonce: " + nonce,
      "Issued At: " + issuedAt,
      "Expiration Time: " + expirationTime,
      "Resources:",
    ];
    resources.forEach((item) => lines.push("- " + item));
    return lines.join("\n");
  }

  function parseSiwe(message) {
    const lines = String(message || "").replace(/\r\n/g, "\n").split("\n");
    if (lines.length < 10) return { ok: false, error: "short message" };
    const head = lines[0].match(/^(\S+) wants you to sign in with your Ethereum account:$/);
    if (!head) return { ok: false, error: "preamble" };
    const domain = head[1];
    const address = lines[1];
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) return { ok: false, error: "address" };
    if (lines[2] !== "" || lines[4] !== "") return { ok: false, error: "gap" };
    const statement = lines[3];
    if (!statement) return { ok: false, error: "statement" };
    let index = 5;
    function take(label) {
      const prefix = label + ": ";
      if (!lines[index] || lines[index].indexOf(prefix) !== 0) return null;
      const value = lines[index].slice(prefix.length);
      index += 1;
      return value;
    }
    const uri = take("URI");
    const version = take("Version");
    const chainId = take("Chain ID");
    const nonce = take("Nonce");
    const issuedAt = take("Issued At");
    if (!uri || version == null || chainId == null || !nonce || !issuedAt) return { ok: false, error: "fields" };
    let expirationTime = null;
    let notBefore = null;
    if (lines[index] && lines[index].indexOf("Expiration Time: ") === 0) expirationTime = take("Expiration Time");
    if (lines[index] && lines[index].indexOf("Not Before: ") === 0) notBefore = take("Not Before");
    if (lines[index] && lines[index].indexOf("Request ID: ") === 0) take("Request ID");
    const resources = [];
    if (lines[index] === "Resources:") {
      index += 1;
      while (index < lines.length) {
        if (lines[index].indexOf("- ") !== 0) return { ok: false, error: "resource" };
        const resource = lines[index].slice(2);
        if (!resource || /\s/.test(resource)) return { ok: false, error: "resource" };
        resources.push(resource);
        index += 1;
      }
    }
    if (index !== lines.length) return { ok: false, error: "trailing" };
    return {
      ok: true,
      domain,
      address,
      statement,
      uri,
      version,
      chainId,
      nonce,
      issuedAt,
      expirationTime,
      notBefore,
      resources,
    };
  }

  function parseTime(value) {
    if (!value) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }

  function inspectSession(record, now, expect) {
    if (!record || typeof record.message !== "string" || typeof record.signature !== "string") {
      return { ok: false, error: "missing" };
    }
    const parsed = parseSiwe(record.message);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (parsed.version !== "1") return { ok: false, error: "version" };
    if (parsed.chainId !== String(SEPOLIA_CHAIN_ID)) return { ok: false, error: "chain" };
    if (!validNonce(parsed.nonce)) return { ok: false, error: "nonce" };
    const wanted = expect || {};
    if (wanted.domain && parsed.domain !== wanted.domain) return { ok: false, error: "domain" };
    let uriHost = "";
    try {
      uriHost = new URL(parsed.uri).host;
    } catch (err) {
      return { ok: false, error: "uri" };
    }
    if (uriHost !== parsed.domain) return { ok: false, error: "uri" };
    if (wanted.uri && parsed.uri !== wanted.uri) return { ok: false, error: "uri" };
    const issued = parseTime(parsed.issuedAt);
    const expiration = parseTime(parsed.expirationTime);
    const clockNow = Number(now);
    if (issued == null || expiration == null || !Number.isFinite(clockNow)) return { ok: false, error: "time" };
    if (expiration <= issued || expiration - issued > SESSION_MAX_MS) return { ok: false, error: "time" };
    if (clockNow > expiration) return { ok: false, error: "expired" };
    if (issued > clockNow + SKEW_MS) return { ok: false, error: "time" };
    if (parsed.notBefore) {
      const notBefore = parseTime(parsed.notBefore);
      if (notBefore == null) return { ok: false, error: "time" };
      if (clockNow + SKEW_MS < notBefore) return { ok: false, error: "early" };
    }
    return { ok: true, parsed };
  }

  function acceptSession(record, now, expect, recover) {
    const inspected = inspectSession(record, now, expect);
    if (!inspected.ok) return inspected;
    if (typeof recover !== "function") return { ok: false, error: "no verifier" };
    let recovered = "";
    try {
      recovered = recover(record.message, record.signature);
    } catch (err) {
      return { ok: false, error: "bad signature" };
    }
    const got = normalizeAddress(recovered);
    const want = normalizeAddress(inspected.parsed.address);
    if (!got || got !== want) return { ok: false, error: "signer" };
    return {
      ok: true,
      address: got,
      checksum: inspected.parsed.address,
      domain: inspected.parsed.domain,
      uri: inspected.parsed.uri,
      nonce: inspected.parsed.nonce,
      issuedAt: inspected.parsed.issuedAt,
      expirationTime: inspected.parsed.expirationTime,
      chainId: SEPOLIA_CHAIN_ID,
      statement: inspected.parsed.statement,
      message: record.message,
      signature: record.signature,
    };
  }

  function txHash(value) {
    const raw = String(value || "");
    return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : null;
  }

  function parseSettlementRow(row) {
    if (!row || typeof row !== "object") return null;
    const tx = txHash(row.transactionHash);
    if (!tx) return null;
    return {
      tx,
      height: row.blockHeight != null ? String(row.blockHeight) : null,
      throughRound: row.settledThroughRound != null ? String(row.settledThroughRound) : null,
      prevRound: row.previousSettledThroughRound != null ? String(row.previousSettledThroughRound) : null,
      workAdded: row.workAdded != null ? String(row.workAdded) : null,
      at: row.blockTimestamp ? String(row.blockTimestamp) : null,
      confirmation: row.confirmationStatus ? String(row.confirmationStatus) : null,
    };
  }

  function parseSettlements(payload) {
    const body = payload && typeof payload === "object" ? payload : null;
    if (!body) return { ok: false, error: "no body" };
    if (body.measurement && body.measurement.coreStatus) return { ok: false, error: "not settlements" };
    if (body.status && body.status !== "available") {
      return { ok: false, error: body.reason ? String(body.reason) : String(body.status) };
    }
    if (!body.summary || !Array.isArray(body.recentSettlements)) return { ok: false, error: "no settlements" };
    const recent = [];
    body.recentSettlements.forEach((row) => {
      if (recent.length >= 3) return;
      const parsed = parseSettlementRow(row);
      if (parsed) recent.push(parsed);
    });
    return {
      ok: true,
      range: body.range ? String(body.range) : null,
      generatedAt: body.generatedAt ? String(body.generatedAt) : null,
      chainId: body.chain && body.chain.chainId != null ? String(body.chain.chainId) : null,
      settlementCount: body.summary.settlementCount != null ? String(body.summary.settlementCount) : null,
      recent,
    };
  }

  function parseStats(payload) {
    const body = payload && typeof payload === "object" ? payload : null;
    if (!body) return { ok: false, error: "no body" };
    if (body.measurement && body.measurement.coreStatus) return { ok: false, error: "not stats" };
    if (body.range !== "7d" && body.range !== "30d") return { ok: false, error: "range" };
    if (!body.rounds || !body.lifetime) return { ok: false, error: "no stats" };
    const peak = body.records && body.records.peakObservedRpmMilli;
    const coverage = body.activity && body.activity.coverage;
    return {
      ok: true,
      range: body.range,
      generatedAt: body.generatedAt ? String(body.generatedAt) : null,
      roundSeconds: body.window && Number.isFinite(Number(body.window.roundSeconds)) ? Number(body.window.roundSeconds) : null,
      activeDays: body.lifetime.activeDayCount != null ? String(body.lifetime.activeDayCount) : null,
      settlementCount: body.lifetime.settlementCount != null ? String(body.lifetime.settlementCount) : null,
      coverageBps: coverage && coverage.coverageBps != null ? coverage.coverageBps : null,
      activeRateBps: body.rounds.activeRateBps != null ? body.rounds.activeRateBps : null,
      observedRounds: body.rounds.observedCount != null ? body.rounds.observedCount : null,
      activeRounds: body.rounds.activeCount != null ? body.rounds.activeCount : null,
      peakRpmMilli: peak && peak.value != null ? String(peak.value) : null,
      peakRpmAt: peak && peak.occurredAt ? String(peak.occurredAt) : null,
    };
  }

  function parseAccount(payload, address) {
    const body = payload && typeof payload === "object" ? payload : null;
    if (!body) return { ok: false, error: "no body" };
    if (body.status === "unavailable") return { ok: false, error: body.reason ? String(body.reason) : "unavailable" };
    if (body.status !== "available") return { ok: false, error: "status" };
    const got = normalizeAddress(body.account);
    const want = normalizeAddress(address);
    if (!got || (want && got !== want)) return { ok: false, error: "account" };
    const counts = body.tokenCounts || {};
    const rewards = body.rewards || {};
    const power = body.power || {};
    return {
      ok: true,
      account: got,
      claimable: rewards.claimableBaseUnits != null ? String(rewards.claimableBaseUnits) : null,
      walletSqueeks: counts.wallet != null ? String(counts.wallet) : null,
      stakingSqueeks: counts.staking != null ? String(counts.staking) : null,
      nftPower: power.nftPower != null ? String(power.nftPower) : null,
      sqkPower: power.sqkPower != null ? String(power.sqkPower) : null,
      coreHeight: body.economy && body.economy.coreBlockHeight != null ? String(body.economy.coreBlockHeight) : null,
    };
  }

  function contextStamp(settlements, stats) {
    const stamp = { settlement: null, measure: null };
    if (settlements && settlements.ok) {
      const row = settlements.recent && settlements.recent[0];
      stamp.settlement = {
        range: settlements.range || null,
        settlementCount: settlements.settlementCount != null ? String(settlements.settlementCount) : null,
        height: row && row.height ? row.height : null,
        throughRound: row && row.throughRound ? row.throughRound : null,
        tx: row && row.tx ? row.tx : null,
        at: row && row.at ? row.at : null,
        generatedAt: settlements.generatedAt || null,
      };
    }
    if (stats && stats.ok) {
      stamp.measure = {
        range: stats.range || null,
        activeRateBps: Number.isFinite(Number(stats.activeRateBps)) ? Number(stats.activeRateBps) : null,
        peakRpmMilli: stats.peakRpmMilli != null ? String(stats.peakRpmMilli) : null,
        roundSeconds: Number.isFinite(Number(stats.roundSeconds)) ? Number(stats.roundSeconds) : null,
        generatedAt: stats.generatedAt || null,
      };
    }
    return stamp.settlement || stamp.measure ? stamp : null;
  }

  function readContext(raw) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw.settlement && typeof raw.settlement === "object" ? raw.settlement : null;
    const measureSrc = raw.measure && typeof raw.measure === "object" ? raw.measure : null;
    const settlement = source ? {
      range: source.range ? String(source.range) : null,
      settlementCount: source.settlementCount != null ? String(source.settlementCount) : null,
      height: source.height != null ? String(source.height) : null,
      throughRound: source.throughRound != null ? String(source.throughRound) : null,
      tx: txHash(source.tx),
      at: source.at ? String(source.at) : null,
      generatedAt: source.generatedAt ? String(source.generatedAt) : null,
    } : null;
    const measure = measureSrc ? {
      range: measureSrc.range ? String(measureSrc.range) : null,
      activeRateBps: Number.isFinite(Number(measureSrc.activeRateBps)) ? Number(measureSrc.activeRateBps) : null,
      peakRpmMilli: measureSrc.peakRpmMilli != null ? String(measureSrc.peakRpmMilli) : null,
      roundSeconds: Number.isFinite(Number(measureSrc.roundSeconds)) ? Number(measureSrc.roundSeconds) : null,
      generatedAt: measureSrc.generatedAt ? String(measureSrc.generatedAt) : null,
    } : null;
    return settlement || measure ? { settlement, measure } : null;
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
    SESSION_KEY,
    SETTLEMENTS_URL,
    STATS_URL,
    SEPOLIA_CHAIN_ID,
    SESSION_MS,
    SIWE_STATEMENT,
    freshState,
    formatRate,
    formatChips,
    formatBaseUnits,
    formatBps,
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
    readingKey,
    applyReading,
    bankStreak,
    openBook,
    normalizeAddress,
    shortAddress,
    shortTx,
    bookStorageKey,
    accountUrl,
    explorerTx,
    buildSiwe,
    parseSiwe,
    acceptSession,
    parseSettlements,
    parseStats,
    parseAccount,
    contextStamp,
  };
});
