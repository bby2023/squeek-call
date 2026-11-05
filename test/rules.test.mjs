import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const rules = require("../rules.js");

const NOW = 1_700_000_000_000;

function book(over) {
  return { ...rules.freshState(), ...over };
}

test("status URL is the bare public endpoint", () => {
  assert.equal(rules.STATUS_URL, "https://api.squeekchain.com/v1/status");
  assert.equal(rules.STATUS_URL.includes("?"), false);
});

test("ACTIVE and RUNNING map to the running call, IDLE stays idle, faults do not", () => {
  assert.equal(rules.classifyCore("ACTIVE"), "RUNNING");
  assert.equal(rules.classifyCore(" running "), "RUNNING");
  assert.equal(rules.classifyCore("IDLE"), "IDLE");
  assert.equal(rules.classifyCore("COUNTER_FAULT"), null);
  assert.equal(rules.classifyCore(""), null);
  assert.equal(rules.classifyCore(null), null);
  assert.equal(rules.classifyCore("SPINNING"), null);
});

test("thin tape is a flat 1.5× and a full idle tape prices the dog at 4×", () => {
  const thin = rules.priceCall(1, 1, 0);
  assert.equal(thin.thin, true);
  assert.equal(thin.running.priceTenths, 15);
  assert.equal(thin.idle.paysTenths, 15);

  const chalk = rules.priceCall(0, 12, 0);
  assert.equal(chalk.thin, false);
  assert.equal(chalk.idleCount, 12);
  assert.equal(chalk.runCount, 0);
  assert.equal(chalk.idle.priceTenths, 11);
  assert.equal(chalk.idle.paysTenths, 11);
  assert.equal(chalk.running.priceTenths, 40);
  assert.equal(chalk.running.paysTenths, 40);

  const mixed = rules.priceCall(3, 9, 0);
  assert.equal(mixed.running.priceTenths, 33);
  assert.equal(mixed.idle.priceTenths, 18);
});

test("streak multiplies the tape price and the pay caps at 6×", () => {
  const hot = rules.priceCall(0, 12, 4);
  assert.equal(hot.factorTenths, 25);
  assert.equal(hot.running.paysTenths, 60);
  assert.equal(hot.idle.paysTenths, 28);
  assert.equal(rules.formatRate(11), "1.1×");
  assert.equal(rules.formatRate(40), "4×");
  assert.equal(rules.callReturn(50, 11), 55);
  assert.equal(rules.callReturn(200, 60), 1200);
});

test("tape dedupes by reading key and keeps the last 12", () => {
  let tape = [];
  for (let i = 0; i < 14; i += 1) {
    tape = rules.pushTape(tape, { key: "k" + i, running: i % 2 === 0 });
  }
  tape = rules.pushTape(tape, { key: "k13", running: false });
  assert.equal(tape.length, 12);
  assert.equal(tape[0].key, "k2");
  assert.equal(tape[tape.length - 1].key, "k13");
  assert.equal(rules.pushTape([{ key: "a", running: true }], { key: "a", running: false }).length, 1);
  assert.equal(rules.pushTape([], { running: true }).length, 0);
});

test("stake choices never exceed the bank or the 200 cap", () => {
  assert.deepEqual(rules.stakeChoices(1000), [20, 50, 100, 200]);
  assert.deepEqual(rules.stakeChoices(80), [20, 50, 80]);
  assert.deepEqual(rules.stakeChoices(15), [15]);
  assert.deepEqual(rules.stakeChoices(0), []);
  assert.equal(rules.resolveStake(80, 100), 80);
  assert.equal(rules.resolveStake(1000, 50), 50);
  assert.equal(rules.resolveStake(15, 200), 15);
});

test("lock escrows the stake for 12 seconds and refuses a second slip", () => {
  const locked = rules.lockCall(book(), {
    choice: "IDLE",
    now: NOW,
    priceTenths: 11,
    paysTenths: 11,
    factorTenths: 10,
    tapeRun: 0,
    tapeIdle: 12,
    thin: false,
  });
  assert.equal(locked.ok, true);
  assert.equal(locked.stake, 50);
  assert.equal(locked.state.bank, 950);
  assert.equal(locked.state.open.deadline - locked.state.open.lockedAt, 12000);
  assert.equal(locked.state.open.choice, "IDLE");
  assert.equal(locked.state.nextSlip, 2);
  const again = rules.lockCall(locked.state, { choice: "RUNNING", now: NOW, paysTenths: 40 });
  assert.equal(again.ok, false);
});

test("a short bank locks what is actually there", () => {
  const locked = rules.lockCall(book({ bank: 30, stake: 100 }), {
    choice: "RUNNING",
    now: NOW,
    paysTenths: 40,
    priceTenths: 40,
    factorTenths: 10,
    tapeRun: 0,
    tapeIdle: 12,
  });
  assert.equal(locked.stake, 30);
  assert.equal(locked.state.bank, 0);
  assert.equal(locked.state.stake, 100);
});

test("hits pay the locked rate, misses wipe the streak, bad reads return the stake", () => {
  const locked = rules.lockCall(book({ streak: 2, stake: 20 }), {
    choice: "RUNNING",
    now: NOW,
    priceTenths: 40,
    paysTenths: 40,
    factorTenths: 16,
    tapeRun: 0,
    tapeIdle: 12,
  });
  const state = { ...locked.state, open: { ...locked.state.open, phase: "settling" } };
  const hit = rules.applyReading(state, reading({ coreStatus: "ACTIVE", rpmMilli: 18000, height: "366" }), NOW + 12000);
  assert.equal(hit.applied, true);
  assert.equal(hit.slip.outcome, "hit");
  assert.equal(hit.slip.side, "RUNNING");
  assert.equal(hit.slip.returned, rules.callReturn(20, 40));
  assert.equal(hit.state.bank, 1000 - 20 + 80);
  assert.equal(hit.state.streak, 3);
  assert.equal(hit.state.bestStreak, 3);
  assert.equal(hit.slip.coreStatus, "ACTIVE");
  assert.equal(hit.slip.height, "366");
  assert.equal(hit.slip.rpmMilli, 18000);

  const miss = rules.applyReading(state, reading({ coreStatus: "IDLE" }), NOW + 12000);
  assert.equal(miss.slip.outcome, "miss");
  assert.equal(miss.state.bank, 980);
  assert.equal(miss.state.streak, 0);

  const fault = rules.applyReading(state, reading({ coreStatus: "COUNTER_FAULT" }), NOW + 12000);
  assert.equal(fault.slip.outcome, "push");
  assert.equal(fault.state.bank, 1000);
  assert.equal(fault.state.streak, 2);
  assert.match(fault.slip.reason, /COUNTER_FAULT/);

  const down = rules.applyReading(state, { ok: false, error: "timed out", fetchedAt: "t" }, NOW + 12000);
  assert.equal(down.slip.outcome, "push");
  assert.equal(down.state.bank, 1000);
  assert.equal(down.state.streak, 2);

  const empty = rules.applyReading(state, rules.readingFromPayload({ measurement: null }, "t", null), NOW + 12000);
  assert.equal(empty.slip.outcome, "push");
  assert.equal(empty.slip.reason, "no measurement");
});

test("apply will not settle early and will not pay a slip twice", () => {
  const locked = rules.lockCall(book(), {
    choice: "IDLE",
    now: NOW,
    paysTenths: 15,
    priceTenths: 15,
    factorTenths: 10,
  });
  const early = rules.applyReading(locked.state, reading({ coreStatus: "IDLE" }), NOW + 1000);
  assert.equal(early.applied, false);
  assert.equal(early.state.bank, 950);
  const state = { ...locked.state, open: { ...locked.state.open, phase: "settling", claimAt: NOW + 12000 } };
  const once = rules.applyReading(state, reading({ coreStatus: "IDLE" }), NOW + 12000);
  const twice = rules.applyReading(once.state, reading({ coreStatus: "IDLE" }), NOW + 13000);
  assert.equal(twice.applied, false);
  assert.equal(twice.state.bank, once.state.bank);
  assert.equal(twice.state.slips.length, 1);
});

test("claim waits out the clock, then one tab fetches", () => {
  const locked = rules.lockCall(book(), { choice: "IDLE", now: NOW, paysTenths: 11, priceTenths: 11, factorTenths: 10 });
  assert.equal(rules.claimSettle(locked.state, NOW + 1000).action, "wait");
  const due = rules.claimSettle(locked.state, NOW + 12000);
  assert.equal(due.action, "fetch");
  assert.equal(due.state.open.phase, "settling");
  assert.equal(rules.claimSettle(due.state, NOW + 13000).action, "wait");
  assert.equal(rules.claimSettle(due.state, NOW + 13000, { force: true }).action, "fetch");
});

test("banking the streak keeps the chips and a busted book can be reopened", () => {
  const hot = book({ streak: 3, bank: 400 });
  assert.equal(rules.bankStreak(hot).state.streak, 0);
  assert.equal(rules.bankStreak(hot).state.bank, 400);
  const locked = rules.lockCall(hot, { choice: "IDLE", now: NOW, paysTenths: 11, priceTenths: 11, factorTenths: 10 });
  assert.equal(rules.bankStreak(locked.state).ok, false);
  assert.equal(rules.openBook(hot).ok, false);
  const busted = book({ bank: 0, streak: 2, books: 1, slips: [{ n: 1 }] });
  const reopened = rules.openBook(busted);
  assert.equal(reopened.state.bank, 1000);
  assert.equal(reopened.state.books, 2);
  assert.equal(reopened.state.streak, 0);
  assert.equal(reopened.state.slips.length, 1);
});

test("legacy score book becomes slips without becoming chips", () => {
  const imported = rules.importV1({
    score: 9,
    streak: 2,
    best: 4,
    history: [{ choice: "RUNNING", actual: "IDLE", win: false, rpm: "1.20", height: 10, at: NOW }],
  });
  assert.equal(imported.bank, 1000);
  assert.equal(imported.streak, 2);
  assert.equal(imported.bestStreak, 4);
  assert.equal(imported.slips[0].legacy, true);
  assert.equal(imported.slips[0].outcome, "miss");
  assert.equal(imported.slips[0].stake, null);
  assert.equal(imported.nextSlip, 2);
});

test("corrupt storage does not invent a playable open slip", () => {
  const fixed = rules.normalize({ bank: 400, open: { choice: "NOPE", stake: 50 }, stake: 9999 }, NOW);
  assert.equal(fixed.open, null);
  assert.equal(fixed.bank, 450);
  assert.equal(fixed.stake, 200);
  assert.equal(rules.normalize(null, NOW).bank, 1000);
});

function reading(over) {
  return rules.readingFromPayload(
    {
      installationId: "sepolia-core",
      generatedAt: "2026-11-05T10:44:07.770Z",
      measurement: {
        coreStatus: over.coreStatus,
        rpmMilli: over.rpmMilli ?? 0,
        speedMmPerSecond: 0,
        freshness: "online",
        provenance: "hardware",
        observedAt: "2026-11-05T10:44:02.631Z",
        receivedAt: "2026-11-05T10:44:02.754Z",
      },
      builder: { anchor: { blockHeight: over.height || "366", settledThroughRound: "232" } },
    },
    "2026-11-05T10:44:19.000Z",
    null
  );
}
