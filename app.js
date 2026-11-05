/* Squeek Call — the table. Settlement is always a fresh GET of rules.STATUS_URL. */
(() => {
  const R = window.SqueekCallRules;
  if (!R) return;

  const els = {
    bank: document.getElementById("bank"),
    stack: document.querySelector(".stack"),
    streak: document.getElementById("streak"),
    ladder: document.getElementById("ladder"),
    best: document.getElementById("best"),
    btnBank: document.getElementById("btnBank"),
    btnMute: document.getElementById("btnMute"),
    clerk: document.getElementById("clerk"),
    btnRun: document.getElementById("btnRun"),
    btnIdle: document.getElementById("btnIdle"),
    rateRun: document.getElementById("rateRun"),
    rateIdle: document.getElementById("rateIdle"),
    payRun: document.getElementById("payRun"),
    payIdle: document.getElementById("payIdle"),
    wheel: document.getElementById("wheel"),
    hubKicker: document.getElementById("hubKicker"),
    hubWord: document.getElementById("hubWord"),
    under: document.getElementById("under"),
    slip: document.getElementById("slip"),
    ticks: document.getElementById("ticks"),
    tapeLine: document.getElementById("tapeLine"),
    feedNote: document.getElementById("feedNote"),
    chips: document.getElementById("chips"),
    stakeNote: document.getElementById("stakeNote"),
    btnReopen: document.getElementById("btnReopen"),
    bookMeta: document.getElementById("bookMeta"),
    log: document.getElementById("log"),
  };
  Object.entries(els).forEach(([key, node]) => {
    if (!node) throw new Error("Squeek Call is missing " + key);
  });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cells = [];
  for (let i = 0; i < R.TAPE_MAX; i += 1) {
    const cell = document.createElement("i");
    cell.className = "tick";
    cell.dataset.on = "empty";
    els.ticks.appendChild(cell);
    cells.push(cell);
  }

  let persist = true;
  let book = R.freshState();
  let tape = [];
  let live = null;
  let seenFeed = false;
  let feedError = "";
  let hold = "";
  let shown = { running: null, idle: null };
  let chipKey = "";
  let slipKey = "";
  let bookKey = "";
  let locking = false;
  let flight = null;
  let flash = null;
  let shownBank = null;
  let angle = 18;
  let lastTick = 0;
  let lastSecond = null;
  let audioCtx = null;

  function bootStore() {
    try {
      const raw = localStorage.getItem(R.STORAGE_KEY);
      if (raw) return R.normalize(JSON.parse(raw), Date.now());
      const legacy = localStorage.getItem(R.LEGACY_KEY);
      if (legacy) return R.importV1(JSON.parse(legacy));
      return R.freshState();
    } catch (err) {
      persist = false;
      return R.freshState();
    }
  }

  function writeBook(state) {
    book = state;
    if (!persist) return;
    try {
      localStorage.setItem(R.STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      persist = false;
    }
  }

  function readBook() {
    if (!persist) return book;
    try {
      const raw = localStorage.getItem(R.STORAGE_KEY);
      if (!raw) return book;
      return R.normalize(JSON.parse(raw), Date.now());
    } catch (err) {
      return book;
    }
  }

  function withBook(mutator) {
    const exec = () => {
      const cur = readBook();
      const result = mutator(cur) || {};
      if (result.state) writeBook(result.state);
      else book = cur;
      return result;
    };
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request("squeek-call-book", exec);
    }
    return Promise.resolve(exec());
  }

  function countsOf(rows) {
    const run = rows.filter((row) => row.running).length;
    return { run, idle: rows.length - run };
  }

  function quote() {
    const c = countsOf(tape);
    return R.priceCall(c.run, c.idle, book.streak);
  }

  function canCall() {
    return seenFeed && !book.open && book.bank > 0 && !locking && !flight;
  }

  function rpmText(milli) {
    if (milli == null || !Number.isFinite(Number(milli))) return "— rpm";
    return (Number(milli) / 1000).toFixed(2) + " rpm";
  }

  function clock(value) {
    if (value == null || value === "") return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function iso(value) {
    if (value == null || value === "") return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toISOString();
  }

  function slipNo(n) {
    const s = String(n);
    return s.length >= 3 ? s : s.padStart(3, "0");
  }

  function clerk(text) {
    if (els.clerk.textContent !== text) els.clerk.textContent = text;
  }

  function readyLine() {
    if (!seenFeed) {
      return feedError
        ? "Can't read the wheel (" + feedError + "). Still trying."
        : "Waiting on the wheel.";
    }
    if (book.bank <= 0) return "The stack is empty. Open a new book for another 1,000.";
    const q = quote();
    const raw = (live && live.coreStatus) || "—";
    const stale = live && live.freshness && live.freshness !== "online" ? ", reading is " + live.freshness : "";
    if (q.thin) {
      return "Feed says " + raw + stale + ". Both sides " + R.formatRate(q.running.paysTenths) + " until four readings are in.";
    }
    return "Feed says " + raw + stale + ". RUNNING " + R.formatRate(q.running.paysTenths) + " · IDLE " + R.formatRate(q.idle.paysTenths) + ".";
  }

  function openLine(open) {
    const back = R.callReturn(open.stake, open.paysTenths);
    const base =
      "Slip " + slipNo(open.n) + " · " + open.choice + " · " +
      R.formatChips(open.stake) + " in · hit returns " + R.formatChips(back) + ".";
    if (open.phase === "settling" || Date.now() >= open.deadline) return "Time. " + base;
    return base;
  }

  function resultLine(slip) {
    if (slip.legacy) return "Old slip brought over. Call when you want.";
    if (slip.outcome === "hit") {
      return "Hit. coreStatus " + (slip.coreStatus || slip.side || "—") + ". " +
        R.formatChips(slip.stake) + " came back " + R.formatChips(slip.returned) +
        ". Streak " + book.streak + ".";
    }
    if (slip.outcome === "miss") {
      return "Miss. coreStatus " + (slip.coreStatus || "—") + ". " +
        R.formatChips(slip.stake) + " is gone. Streak reset.";
    }
    return "Returned. " + (slip.reason || "No side on the feed.") + ". " +
      R.formatChips(slip.returned) + " is back. Streak stays " + book.streak + ".";
  }

  function syncClerk() {
    if (book.open) clerk(openLine(book.open));
    else if (hold) clerk(hold);
    else clerk(readyLine());
  }

  function liveCaption() {
    if (!live) return feedError ? "no feed" : "waiting on the wheel";
    const bits = [];
    if (live.freshness && live.freshness !== "online") bits.push(String(live.freshness));
    if (live.provenance && live.provenance !== "hardware") bits.push(String(live.provenance));
    bits.push("feed " + (live.coreStatus || "no status"));
    bits.push(rpmText(live.rpmMilli));
    return bits.join(" · ");
  }

  function paintHub(now) {
    let kicker = "Wheel";
    let word = "…";
    let kind = "wait";
    let clockMode = false;
    if (book.open) {
      const left = book.open.deadline - now;
      if (left > 0 && book.open.phase !== "settling") {
        const sec = Math.ceil(left / 1000);
        kicker = "Settles in";
        word = String(sec);
        kind = "clock";
        clockMode = true;
        if (lastSecond != null && sec < lastSecond && sec <= 3 && sec > 0) softTick();
        lastSecond = sec;
      } else {
        kicker = "Settling";
        word = "…";
        kind = "clock";
        clockMode = true;
      }
    } else if (flash && now < flash.until) {
      kicker = flash.kicker;
      word = flash.word;
      kind = flash.kind;
    } else if (live) {
      const side = R.classifyCore(live.coreStatus);
      if (side) {
        word = side;
        kind = side === "RUNNING" ? "run" : "idle";
      } else {
        word = "Fault";
        kind = "fault";
      }
    }
    if (els.hubKicker.textContent !== kicker) els.hubKicker.textContent = kicker;
    if (els.hubWord.textContent !== word) els.hubWord.textContent = word;
    els.hubWord.classList.toggle("clock", clockMode);
    if (els.hubWord.dataset.kind !== kind) els.hubWord.dataset.kind = kind;
    const sub = book.open && (book.open.phase === "settling" || book.open.deadline <= now)
      ? "one fresh status"
      : liveCaption();
    if (els.under.textContent !== sub) els.under.textContent = sub;
    const title = clockMode && word !== "…" ? "(" + word + ") Squeek Call" : "Squeek Call";
    if (document.title !== title) document.title = title;
  }

  function paintRail() {
    els.bank.textContent = R.formatChips(book.bank);
    els.streak.textContent = String(book.streak);
    if (shownBank != null && book.bank !== shownBank) {
      els.stack.classList.remove("up", "down");
      els.stack.classList.add(book.bank > shownBank ? "up" : "down");
      window.setTimeout(() => els.stack.classList.remove("up", "down"), 700);
    }
    shownBank = book.bank;
    if (book.bestBank > R.START_BANK) {
      els.best.hidden = false;
      els.best.textContent = "best " + R.formatChips(book.bestBank);
    } else {
      els.best.hidden = true;
    }
    const step = Math.min(book.streak, R.STREAK_FACTORS.length - 1);
    const frag = document.createDocumentFragment();
    R.STREAK_FACTORS.forEach((tenths, i) => {
      const span = document.createElement("span");
      span.textContent = R.formatRate(tenths);
      if (i === step) span.className = "on";
      frag.appendChild(span);
    });
    els.ladder.replaceChildren(frag);
    els.ladder.setAttribute("aria-label", "Streak multiplier, now " + R.formatRate(R.STREAK_FACTORS[step]));
    els.btnBank.disabled = Boolean(book.open) || book.streak <= 0;
    els.btnMute.textContent = book.muted ? "Sound off" : "Sound on";
    els.btnMute.setAttribute("aria-pressed", book.muted ? "false" : "true");
  }

  function paintPrices() {
    const open = Boolean(book.open);
    const bust = book.bank <= 0;
    els.btnRun.disabled = !canCall();
    els.btnIdle.disabled = !canCall();
    if (open || bust || !seenFeed) {
      const label = open ? "slip in" : bust ? "busted" : "waiting";
      els.rateRun.textContent = "—";
      els.rateIdle.textContent = "—";
      els.payRun.textContent = label;
      els.payIdle.textContent = label;
      shown = { running: null, idle: null };
      return;
    }
    const q = quote();
    const stake = R.resolveStake(book.bank, book.stake);
    els.rateRun.textContent = R.formatRate(q.running.paysTenths);
    els.rateIdle.textContent = R.formatRate(q.idle.paysTenths);
    els.payRun.textContent = R.formatChips(stake) + " → " + R.formatChips(R.callReturn(stake, q.running.paysTenths));
    els.payIdle.textContent = R.formatChips(stake) + " → " + R.formatChips(R.callReturn(stake, q.idle.paysTenths));
    shown = { running: q.running.paysTenths, idle: q.idle.paysTenths };
  }

  function paintTape() {
    const start = R.TAPE_MAX - tape.length;
    for (let i = 0; i < R.TAPE_MAX; i += 1) {
      const sample = i >= start ? tape[i - start] : null;
      cells[i].dataset.on = sample ? (sample.running ? "run" : "idle") : "empty";
    }
    const c = countsOf(tape);
    let line = "Tape is empty.";
    let label = "No readings yet";
    if (tape.length && tape.length < R.MIN_TAPE) {
      line = tape.length + " of 4 readings before the tape sets a price.";
      label = line;
    } else if (tape.length) {
      line = c.idle + " idle · " + c.run + " running · these set the price.";
      label = line;
    }
    els.tapeLine.textContent = line;
    els.ticks.setAttribute("aria-label", label);
    if (feedError) {
      els.feedNote.hidden = false;
      els.feedNote.textContent = seenFeed
        ? "Last poll missed: " + feedError + ". A slip still settles on its own fetch."
        : "No feed yet: " + feedError;
    } else {
      els.feedNote.hidden = true;
      els.feedNote.textContent = "";
    }
  }

  function paintChips() {
    const choices = R.stakeChoices(book.bank);
    const key = choices.join(",");
    const stake = R.resolveStake(book.bank, book.stake);
    if (key !== chipKey) {
      chipKey = key;
      els.chips.replaceChildren();
      choices.forEach((n) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chip";
        button.dataset.stake = String(n);
        button.textContent = R.formatChips(n);
        button.setAttribute("aria-pressed", n === stake ? "true" : "false");
        button.addEventListener("click", () => selectStake(n));
        els.chips.appendChild(button);
      });
    } else {
      els.chips.querySelectorAll(".chip").forEach((button) => {
        button.setAttribute("aria-pressed", Number(button.dataset.stake) === stake ? "true" : "false");
      });
    }
    els.stakeNote.textContent = stake ? R.formatChips(stake) + " in" : "";
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function paintSlip() {
    const open = book.open;
    const last = book.slips[0];
    const key = open
      ? "open:" + open.n + ":" + open.phase
      : last
        ? "last:" + last.n + ":" + last.outcome
        : "blank";
    if (key === slipKey) return;
    slipKey = key;
    els.slip.replaceChildren();
    if (open) els.slip.appendChild(renderOpen(open));
    else if (last) els.slip.appendChild(renderResult(last, Boolean(flash)));
    else els.slip.appendChild(renderIntro());
  }

  function renderIntro() {
    const card = el("div", "slip");
    card.append(
      el("p", "slip-kicker", "Open book"),
      el("h2", "slip-title", "Twelve seconds"),
      el("p", null, "Call RUNNING or IDLE. That chip leaves the stack until the clock finishes."),
      el("p", null, "A hit pays the rate on the button. A miss takes the chip. If the feed has no side, the chip comes back."),
      el("p", "slip-foot", "Settles on measurement.coreStatus from one fresh status read.")
    );
    return card;
  }

  function renderOpen(open) {
    const card = el("div", "slip live");
    const back = R.callReturn(open.stake, open.paysTenths);
    const due = clock(open.deadline);
    card.append(
      el("p", "slip-kicker", "Slip " + slipNo(open.n) + " · in escrow"),
      el("h2", "slip-title", open.choice),
      el("p", null, R.formatChips(open.stake) + " chips · hit returns " + R.formatChips(back) + " · " + R.formatRate(open.paysTenths)),
      el("p", null, "Tape was " + open.tapeIdle + " idle, " + open.tapeRun + " running" + (open.thin ? " · flat open" : "") + ". Locked until " + due + "."),
      el("p", "slip-foot", "The spinner is the poll. The slip settles on a new fetch.")
    );
    return card;
  }

  function renderResult(slip, fresh) {
    const kind = slip.outcome === "hit" ? "hit" : slip.outcome === "miss" ? "miss" : "push";
    const card = el("div", "slip " + kind + (fresh ? " fresh" : ""));
    const stamp = slip.legacy
      ? "Old"
      : kind === "hit"
        ? "Hit"
        : kind === "miss"
          ? "Miss"
          : "Returned";
    card.append(el("p", "stamp", stamp));
    card.append(el("p", "slip-kicker", (slip.legacy ? "Old book · " : "Last slip · ") + slipNo(slip.n)));
    if (slip.legacy) {
      card.append(el("p", null, "Called " + slip.choice + ". The old score book didn't keep a stake or the raw payload."));
    } else if (kind === "hit") {
      card.append(el("p", null, "coreStatus " + (slip.coreStatus || "—") + " · counted " + (slip.side || "—") + ". " + R.formatChips(slip.stake) + " came back " + R.formatChips(slip.returned) + "."));
    } else if (kind === "miss") {
      card.append(el("p", null, "Called " + slip.choice + ". coreStatus " + (slip.coreStatus || "—") + " · counted " + (slip.side || "—") + ". " + R.formatChips(slip.stake) + " is gone."));
    } else {
      card.append(el("p", null, (slip.reason || "No side.") + " " + R.formatChips(slip.returned) + " is back on the stack."));
    }
    card.append(el("p", "slip-foot", evidenceMeta(slip)));
    return card;
  }

  function evidenceMeta(slip) {
    if (slip.legacy) {
      return ["old score book", slip.side ? "side " + slip.side : "", slip.height ? "height " + slip.height : "", slip.rpmLabel ? slip.rpmLabel + " rpm" : "", clock(slip.fetchedAt)].filter(Boolean).join(" · ");
    }
    return [
      "coreStatus " + (slip.coreStatus || "—"),
      slip.height ? "height " + slip.height : "",
      slip.rpmMilli != null ? rpmText(slip.rpmMilli) : "",
      slip.freshness || "",
      clock(slip.fetchedAt),
    ].filter(Boolean).join(" · ");
  }

  function paintBook() {
    const key = book.books + ":" + book.slips.map((s) => s.n + ":" + s.outcome).join("|") + ":" + (persist ? "1" : "0");
    if (key === bookKey) return;
    bookKey = key;
    els.bookMeta.textContent = bookMetaText();
    els.log.replaceChildren();
    if (!book.slips.length) {
      els.log.appendChild(el("p", "empty", "No slips yet. A call takes twelve seconds."));
      return;
    }
    book.slips.forEach((slip) => els.log.appendChild(renderEntry(slip)));
  }

  function bookMetaText() {
    if (!persist) return "This browser isn't keeping the book. Chips last until you close the tab.";
    if (!book.slips.length) return "Book " + book.books + ". Chips stay in this browser until you clear site data.";
    let hit = 0;
    let miss = 0;
    let back = 0;
    book.slips.forEach((s) => {
      if (s.outcome === "hit") hit += 1;
      else if (s.outcome === "miss") miss += 1;
      else back += 1;
    });
    const bits = [
      "Book " + book.books,
      book.slips.length + (book.slips.length === 1 ? " slip" : " slips"),
      hit + (hit === 1 ? " hit" : " hits"),
      miss + (miss === 1 ? " miss" : " misses"),
    ];
    if (back) bits.push(back + " returned");
    return bits.join(" · ");
  }

  function renderEntry(slip) {
    const kind = slip.outcome === "hit" ? "hit" : slip.outcome === "miss" ? "miss" : "push";
    const item = el("article", "entry " + kind);
    const row = el("div", "row1");
    const word = slip.legacy ? "Old" : kind === "hit" ? "Hit" : kind === "miss" ? "Miss" : "Returned";
    row.append(el("span", "n", slipNo(slip.n)), el("span", "out", word), el("span", "what", "called " + slip.choice));
    const moved = el("span", "moved");
    if (slip.stake == null) moved.textContent = "old book";
    else if (kind === "hit") moved.textContent = R.formatChips(slip.stake) + " → " + R.formatChips(slip.returned);
    else if (kind === "miss") moved.textContent = R.formatChips(slip.stake) + " gone";
    else moved.textContent = R.formatChips(slip.returned) + " back";
    row.appendChild(moved);
    const meta = el("div", "row2", evidenceMeta(slip));
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Full slip";
    details.appendChild(summary);
    details.appendChild(evidenceList(slip));
    item.append(row, meta, details);
    return item;
  }

  function evidenceList(slip) {
    const dl = el("dl", "evidence");
    const pairs = slip.legacy
      ? [
          ["Called", slip.choice],
          ["Recorded side", slip.side],
          ["RPM label", slip.rpmLabel],
          ["Height", slip.height],
          ["When", iso(slip.fetchedAt)],
          ["Note", "Brought over from the old score book. No stake and no raw payload."],
        ]
      : [
          ["Called", slip.choice],
          ["Stake", slip.stake != null ? R.formatChips(slip.stake) : ""],
          ["Rate", R.formatRate(slip.priceTenths) + " tape × " + R.formatRate(slip.factorTenths) + " streak = " + R.formatRate(slip.paysTenths)],
          ["Returned", slip.returned != null ? R.formatChips(slip.returned) : ""],
          ["coreStatus", slip.coreStatus],
          ["Counted as", slip.side],
          ["Reason", slip.reason],
          ["Freshness", slip.freshness],
          ["Provenance", slip.provenance],
          ["rpmMilli", slip.rpmMilli != null ? String(slip.rpmMilli) : ""],
          ["Speed", slip.speedMmPerSecond != null ? slip.speedMmPerSecond + " mm/s" : ""],
          ["Observed", slip.observedAt],
          ["Received", slip.receivedAt],
          ["Generated", slip.generatedAt],
          ["Anchor height", slip.height],
          ["Settled through round", slip.settledThroughRound],
          ["Installation", slip.installationId],
          ["Tape", (slip.thin ? "flat open · " : "") + (slip.tapeIdle || 0) + " idle · " + (slip.tapeRun || 0) + " running"],
          ["Locked", iso(slip.lockedAt)],
          ["Fetched", slip.fetchedAt],
        ];
    pairs.forEach(([term, value]) => {
      if (value == null || value === "") return;
      dl.append(el("dt", null, term), el("dd", null, String(value)));
    });
    return dl;
  }

  function paint() {
    document.body.dataset.mode = book.open ? "live" : book.bank <= 0 ? "bust" : "ready";
    els.btnReopen.hidden = !(book.bank <= 0 && !book.open);
    paintRail();
    paintPrices();
    paintTape();
    paintChips();
    paintSlip();
    paintBook();
    syncClerk();
    paintHub(Date.now());
  }

  function ensureAudio() {
    try {
      if (book.muted) return null;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    } catch (err) {
      return null;
    }
  }

  function tone(freq, when, dur, type, peak) {
    if (!audioCtx || book.muted) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, when);
    gain.gain.setValueAtTime(peak, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  function softTick() {
    if (!ensureAudio()) return;
    tone(660, audioCtx.currentTime, 0.05, "sine", 0.03);
  }

  function maybeWheelTick(prev, next, rpm) {
    if (!book.open || !audioCtx || book.muted) return;
    if (rpm < 0.4 || rpm > 100) return;
    if (next < prev) tone(720, audioCtx.currentTime, 0.02, "sine", 0.015);
  }

  function resultSound(outcome) {
    if (!audioCtx || book.muted) return;
    const t = audioCtx.currentTime;
    if (outcome === "hit") {
      tone(523, t, 0.12, "sine", 0.05);
      tone(784, t + 0.09, 0.18, "sine", 0.045);
    } else if (outcome === "miss") {
      tone(98, t, 0.24, "triangle", 0.05);
    } else {
      tone(392, t, 0.12, "sine", 0.03);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawWheel(now) {
    const canvas = els.wheel;
    const css = canvas.clientWidth || 320;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.max(1, Math.floor(css * dpr));
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(px / css, 0, 0, px / css, 0, 0);
    if (!lastTick) lastTick = now;
    const dt = Math.min(0.05, (now - lastTick) / 1000);
    lastTick = now;
    const rpmMilli = live && Number.isFinite(Number(live.rpmMilli)) ? Number(live.rpmMilli) : 0;
    const rpm = rpmMilli / 1000;
    if (!reduceMotion.matches && rpm > 0) {
      const prev = angle;
      const step = Math.min(40, rpm * 6 * dt);
      angle = (angle + step) % 360;
      maybeWheelTick(prev, angle, rpm);
    }
    ctx.clearRect(0, 0, css, css);
    const cx = css / 2;
    const cy = css / 2;
    roundRect(ctx, css * 0.03, css * 0.03, css * 0.94, css * 0.94, css * 0.08);
    ctx.fillStyle = "#241910";
    ctx.fill();
    [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]].forEach(([x, y]) => {
      ctx.beginPath();
      ctx.arc(css * x, css * y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#8d7353";
      ctx.fill();
    });

    ctx.beginPath();
    ctx.arc(cx, cy, css * 0.4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(243, 230, 200, .16)";
    ctx.lineWidth = Math.max(6, css * 0.02);
    ctx.stroke();
    if (book.open) {
      const left = Math.max(0, book.open.deadline - Date.now());
      const frac = book.open.phase === "settling" ? 0 : left / R.ROUND_MS;
      ctx.beginPath();
      ctx.arc(cx, cy, css * 0.4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
      ctx.strokeStyle = "#ffd7a8";
      ctx.lineCap = "round";
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.beginPath();
    ctx.arc(0, 0, css * 0.32, 0, Math.PI * 2);
    ctx.strokeStyle = "#e6d3b0";
    ctx.lineWidth = Math.max(6, css * 0.02);
    ctx.stroke();
    ctx.lineWidth = Math.max(3, css * 0.012);
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * css * 0.16, Math.sin(a) * css * 0.16);
      ctx.lineTo(Math.cos(a) * css * 0.3, Math.sin(a) * css * 0.3);
      ctx.strokeStyle = i % 2 ? "#c9844a" : "#f0e2c8";
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, -css * 0.32, css * 0.026, 0, Math.PI * 2);
    ctx.fillStyle = "#ffb020";
    ctx.fill();
    ctx.restore();

    roundRect(ctx, cx - css * 0.24, cy - css * 0.13, css * 0.48, css * 0.26, 12);
    ctx.fillStyle = "#14100c";
    ctx.fill();

    ctx.fillStyle = "#ff4d3a";
    ctx.fillRect(cx - css * 0.012, cy - css * 0.4 - css * 0.04, css * 0.024, css * 0.045);

    const side = live ? R.classifyCore(live.coreStatus) : null;
    ctx.beginPath();
    ctx.arc(cx + css * 0.32, cy + css * 0.32, Math.max(5, css * 0.018), 0, Math.PI * 2);
    ctx.fillStyle = !live ? "#3a3228" : side === "RUNNING" ? "#dff75a" : side === "IDLE" ? "#ff8a3d" : "#ff4d3a";
    ctx.fill();
  }

  function frame(now) {
    drawWheel(now);
    paintHub(Date.now());
    if (flash && Date.now() > flash.until) {
      flash = null;
      document.body.removeAttribute("data-flash");
      paintHub(Date.now());
    }
    requestAnimationFrame(frame);
  }

  async function fetchReading() {
    const fetchedAt = new Date().toISOString();
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(R.STATUS_URL, { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) return R.readingFromPayload(null, fetchedAt, "HTTP " + res.status);
      return R.readingFromPayload(await res.json(), fetchedAt, null);
    } catch (err) {
      const msg = err && err.name === "AbortError" ? "timed out" : (err && err.message) || "failed";
      return R.readingFromPayload(null, fetchedAt, msg);
    } finally {
      window.clearTimeout(timer);
    }
  }

  function ingest(reading) {
    if (!reading || !reading.ok) return;
    seenFeed = true;
    const prevAt = live ? Date.parse(live.observedAt || live.generatedAt || live.fetchedAt || "") : NaN;
    const nextAt = Date.parse(reading.observedAt || reading.generatedAt || reading.fetchedAt || "");
    if (live && Number.isFinite(prevAt) && Number.isFinite(nextAt) && nextAt < prevAt) return;
    live = reading;
    const side = R.classifyCore(reading.coreStatus);
    if (!side) return;
    const stamp = reading.observedAt || reading.generatedAt || reading.fetchedAt || "poll";
    const bucket = Math.floor(Date.now() / 2000);
    tape = R.pushTape(tape, { key: stamp + "@" + bucket, running: side === "RUNNING" });
  }

  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const reading = await fetchReading();
      if (reading.ok) {
        feedError = "";
        ingest(reading);
      } else {
        feedError = reading.error || "failed";
      }
      if (!book.open) paint();
      else {
        paintTape();
        paintHub(Date.now());
      }
    } finally {
      polling = false;
    }
  }

  function onResult(slip) {
    const kind = slip.outcome === "hit" ? "hit" : slip.outcome === "miss" ? "miss" : "push";
    const net = slip.outcome === "hit" ? slip.returned - slip.stake : slip.stake;
    flash = {
      kind,
      until: Date.now() + 1700,
      kicker: kind === "hit" ? "Hit" : kind === "miss" ? "Miss" : "Returned",
      word: kind === "push" ? "Back" : (kind === "hit" ? "+" : "−") + R.formatChips(net),
    };
    document.body.dataset.flash = kind;
    hold = resultLine(slip);
    resultSound(slip.outcome);
    slipKey = "";
  }

  async function runSettle(opts) {
    let claimedN = 0;
    const claim = await withBook((cur) => {
      const out = R.claimSettle(cur, Date.now(), opts);
      if (out.action !== "fetch") return { action: out.action };
      claimedN = out.state.open.n;
      return { state: out.state, action: "fetch" };
    });
    if (!claim || claim.action !== "fetch") return;
    paint();
    const reading = await fetchReading();
    const applied = await withBook((cur) => {
      if (!cur.open || cur.open.n !== claimedN) return {};
      const out = R.applyReading(cur, reading, Date.now());
      if (!out.applied) return { state: out.state };
      return { state: out.state, slip: out.slip };
    });
    ingest(reading);
    if (applied && applied.slip) onResult(applied.slip);
    paint();
  }

  function doSettle(opts) {
    if (flight) return flight;
    if (!book.open) return Promise.resolve();
    flight = runSettle(opts).finally(() => {
      flight = null;
    });
    return flight;
  }

function call(choice) {
  if (!canCall()) return;
  const c = countsOf(tape);
  const q = R.priceCall(c.run, c.idle, book.streak);
  const side = choice === "RUNNING" ? q.running : q.idle;
  const shownPays = choice === "RUNNING" ? shown.running : shown.idle;
  const stakeAtClick = R.resolveStake(book.bank, book.stake);
  const streakAtClick = book.streak;
  if (shownPays == null || shownPays !== side.paysTenths) {
    paintPrices();
    hold = "";
    clerk("Price moved. Same call locks this one.");
    return;
  }
  ensureAudio();
  if (audioCtx) tone(440, audioCtx.currentTime, 0.04, "sine", 0.03);
  locking = true;
  paintPrices();
  withBook((cur) => {
    if (cur.open || cur.streak !== streakAtClick || R.resolveStake(cur.bank, cur.stake) !== stakeAtClick) {
      return {};
    }
    const out = R.lockCall(cur, {
      choice,
      now: Date.now(),
      priceTenths: side.priceTenths,
      paysTenths: side.paysTenths,
      factorTenths: q.factorTenths,
      tapeRun: q.runCount,
      tapeIdle: q.idleCount,
      thin: q.thin,
    });
    return out.ok ? { state: out.state } : {};
  }).then((result) => {
      locking = false;
      if (!result || !result.state) {
        hold = "That call didn't lock. Check the rate and hit it again.";
        paint();
        return;
      }
      hold = "";
      lastSecond = null;
      slipKey = "";
      paint();
    }).catch(() => {
      locking = false;
      paint();
    });
  }

  function selectStake(n) {
    withBook((cur) => ({ state: { ...cur, stake: n } })).then(() => paint());
  }

  function doBank() {
    if (book.open || book.streak <= 0) return;
    withBook((cur) => {
      const out = R.bankStreak(cur);
      return out.ok ? { state: out.state } : {};
    }).then((result) => {
      if (!result || !result.state) return;
      hold = "Streak banked. Chips stay. Next slip uses a flat multiplier.";
      paint();
    });
  }

  function doReopen() {
    withBook((cur) => {
      const out = R.openBook(cur);
      return out.ok ? { state: out.state } : {};
    }).then((result) => {
      if (!result || !result.state) return;
      hold = "New book. 1,000 chips. The old slips are still in the book.";
      paint();
    });
  }

  function toggleMute() {
    ensureAudio();
    withBook((cur) => ({ state: { ...cur, muted: !cur.muted } })).then(() => paint());
  }

  els.btnRun.addEventListener("click", () => call("RUNNING"));
  els.btnIdle.addEventListener("click", () => call("IDLE"));
  els.btnBank.addEventListener("click", doBank);
  els.btnMute.addEventListener("click", toggleMute);
  els.btnReopen.addEventListener("click", doReopen);

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const key = e.key.toLowerCase();
    if (key === "r") {
      e.preventDefault();
      call("RUNNING");
    } else if (key === "i") {
      e.preventDefault();
      call("IDLE");
    } else if (key === "b") {
      e.preventDefault();
      doBank();
    } else if (key >= "1" && key <= "4") {
      const pick = R.stakeChoices(book.bank)[Number(key) - 1];
      if (pick) selectStake(pick);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    poll();
    if (book.open && (Date.now() >= book.open.deadline || book.open.phase === "settling")) {
      doSettle({ force: true });
    }
  });

  writeBook(bootStore());
  paint();
  if (book.open && (Date.now() >= book.open.deadline || book.open.phase === "settling")) {
    doSettle({ force: true });
  }
  poll();
  window.setInterval(poll, 2000);
  window.setInterval(() => {
    if (book.open && Date.now() >= book.open.deadline) doSettle({ force: false });
  }, 200);
  requestAnimationFrame(frame);
})();
