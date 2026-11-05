import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

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

const SIGNED_MESSAGE = [
  "example.com wants you to sign in with your Ethereum account:",
  "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
  "",
  "Open the house-chip book for this address.",
  "",
  "URI: https://example.com/",
  "Version: 1",
  "Chain ID: 11155111",
  "Nonce: 32891756",
  "Issued At: 2021-09-30T16:25:24Z",
  "Expiration Time: 2021-09-30T20:25:24Z",
].join("\n");
const SIGNED_SIGNATURE = "0x56d5ccf4bcd8882bc3e7d7ebf66fb5438cde8dc07b0ea385012e5944b306bd0005d39bacda9528d6f594b0aee8b004093d8bc948fc15211b65a4b79160f04ab61b";
const HELLO_SIGNATURE = "0xa5d58782075bdf09490159d634d1aae66a8f6777c7247d2f233e9511cfd7c64c34f288cdbcea5370e4863fdbe9f4d86654c2ba1d86589e9ebb64494c649008591b";
const SIGNED_ADDRESS = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";
const SESSION_NOW = Date.parse("2021-09-30T18:00:00Z");

function loadRecover() {
  const code = fs.readFileSync(new URL("../recover.js", import.meta.url), "utf8");
  const sandbox = { TextEncoder, Uint8Array, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: "recover.js" });
  return sandbox.SqueekRecover;
}

test("the other live reads have their own URLs and cannot settle a slip", () => {
  assert.equal(rules.SETTLEMENTS_URL, "https://api.squeekchain.com/v1/settlements?range=24h");
  assert.equal(rules.STATS_URL, "https://api.squeekchain.com/v1/measurement/stats?range=7d");
  assert.equal(rules.SEPOLIA_CHAIN_ID, 11155111);
  assert.equal(rules.readingFromPayload(settlementFixture(), "t", null).ok, false);
  assert.equal(rules.readingFromPayload(statsFixture(), "t", null).ok, false);
  assert.equal(rules.parseSettlements({ measurement: { coreStatus: "ACTIVE" } }).ok, false);
  assert.equal(rules.parseStats({ measurement: { coreStatus: "ACTIVE" }, range: "7d", rounds: {}, lifetime: {} }).error, "not stats");
  const before = rules.priceCall(3, 9, 1);
  rules.parseSettlements({ status: "unavailable", reason: "indexer_unavailable", coreStatus: "RUNNING" });
  const after = rules.priceCall(3, 9, 1);
  assert.deepEqual(after, before);
});

test("settlement and stats copies keep chain facts and drop a bad row", () => {
  const settlements = rules.parseSettlements(settlementFixture());
  assert.equal(settlements.ok, true);
  assert.equal(settlements.chainId, "11155111");
  assert.equal(settlements.settlementCount, "141");
  assert.equal(settlements.recent.length, 2);
  assert.equal(settlements.recent[0].height, "2366");
  assert.equal(settlements.recent[0].throughRound, "346");
  assert.equal(settlements.recent[0].prevRound, "345");
  assert.equal(settlements.coreStatus, undefined);
  assert.equal(rules.explorerTx(settlements.recent[0].tx), "https://sepolia.etherscan.io/tx/" + settlements.recent[0].tx);
  assert.equal(rules.parseSettlements({ status: "unavailable", reason: "indexer_unavailable" }).error, "indexer_unavailable");

  const stats = rules.parseStats(statsFixture());
  assert.equal(stats.ok, true);
  assert.equal(stats.roundSeconds, 600);
  assert.equal(stats.activeRateBps, 1618);
  assert.equal(stats.peakRpmMilli, "111256");
  assert.equal(rules.formatBps(stats.activeRateBps), "16.18%");
  assert.equal(stats.coreStatus, undefined);
});

test("an account copy must name the signed address", () => {
  const address = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
  assert.equal(
    rules.accountUrl(address),
    "https://api.squeekchain.com/v1/accounts/0x2c7536e3605d9c16a7a3d7b1898e529396a65c23?limit=1"
  );
  assert.equal(rules.accountUrl("0x1234"), null);
  const parsed = rules.parseAccount({
    status: "available",
    account: SIGNED_ADDRESS,
    rewards: { claimableBaseUnits: "1500000000000000000" },
    tokenCounts: { wallet: "2", staking: "1" },
    power: { nftPower: "40", sqkPower: "0" },
    economy: { coreBlockHeight: "2366" },
  }, address);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.walletSqueeks, "2");
  assert.equal(rules.formatBaseUnits(parsed.claimable), "1.5");
  assert.equal(rules.formatBaseUnits("0"), "0");
  assert.equal(rules.parseAccount({ status: "unavailable", reason: "indexer_unavailable" }, address).error, "indexer_unavailable");
  assert.equal(rules.parseAccount({ status: "available", account: "0x" + "ab".repeat(20) }, address).error, "account");
});

test("each address has its own book key and the guest book stays on v2", () => {
  assert.equal(rules.bookStorageKey(null), "squeek-call-v2");
  assert.equal(rules.bookStorageKey(""), "squeek-call-v2");
  assert.equal(rules.bookStorageKey(SIGNED_ADDRESS), "squeek-call-v3:" + SIGNED_ADDRESS);
  assert.equal(rules.bookStorageKey("0x2C7536E3605D9C16a7a3D7b1898e529396a65c23"), "squeek-call-v3:" + SIGNED_ADDRESS);
  assert.equal(rules.bookStorageKey("nope"), null);
  assert.notEqual(rules.bookStorageKey(null), rules.bookStorageKey(SIGNED_ADDRESS));
});

test("a SIWE message round-trips and a real signature recovers the signer", () => {
  const recover = loadRecover();
  assert.equal(recover.recoverAddress("hello", HELLO_SIGNATURE), SIGNED_ADDRESS);
  assert.equal(recover.checksumAddress(SIGNED_ADDRESS), "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23");
  assert.equal(recover.checksumAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");

  const message = rules.buildSiwe({
    domain: "localhost:8765",
    address: recover.checksumAddress(SIGNED_ADDRESS),
    uri: "http://localhost:8765/",
    nonce: "abcdEFG12",
    issuedAt: "2026-11-05T00:00:00.000Z",
    expirationTime: "2026-11-05T12:00:00.000Z",
  });
  assert.match(message, /Twelve-second calls settle on measurement\.coreStatus/);
  assert.match(message, /https:\/\/api\.squeekchain\.com\/v1\/status/);
  assert.match(message, /Chain ID: 11155111/);
  const parsed = rules.parseSiwe(message);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.domain, "localhost:8765");
  assert.equal(parsed.resources[1], "https://api.squeekchain.com/v1/accounts/" + SIGNED_ADDRESS);
  assert.equal(rules.buildSiwe({ domain: "", address: SIGNED_ADDRESS, uri: "http://x", nonce: "abcdEFG12", issuedAt: "t", expirationTime: "t" }), null);

  const expect = { domain: "example.com", uri: "https://example.com/" };
  const session = rules.acceptSession(
    { message: SIGNED_MESSAGE, signature: SIGNED_SIGNATURE },
    SESSION_NOW,
    expect,
    recover.recoverAddress
  );
  assert.equal(session.ok, true);
  assert.equal(session.address, SIGNED_ADDRESS);
  assert.equal(session.chainId, 11155111);
  assert.equal(session.nonce, "32891756");

  let recoverCalled = false;
  const expired = rules.acceptSession(
    { message: SIGNED_MESSAGE, signature: SIGNED_SIGNATURE },
    Date.parse("2026-11-05T00:00:00Z"),
    expect,
    () => {
      recoverCalled = true;
      return SIGNED_ADDRESS;
    }
  );
  assert.equal(expired.error, "expired");
  assert.equal(recoverCalled, false);

  const tampered = rules.acceptSession(
    { message: SIGNED_MESSAGE.replace("house-chip", "house-chipX"), signature: SIGNED_SIGNATURE },
    SESSION_NOW,
    expect,
    recover.recoverAddress
  );
  assert.equal(tampered.ok, false);
  assert.equal(tampered.error, "signer");

  const otherHost = rules.acceptSession(
    { message: SIGNED_MESSAGE, signature: SIGNED_SIGNATURE },
    SESSION_NOW,
    { domain: "squeekcall.xyz", uri: "https://example.com/" },
    recover.recoverAddress
  );
  assert.equal(otherHost.error, "domain");
  assert.equal(rules.acceptSession(
    { message: SIGNED_MESSAGE, signature: "0x11" },
    SESSION_NOW,
    expect,
    recover.recoverAddress
  ).error, "bad signature");

  const mainnet = rules.buildSiwe({
    domain: "example.com",
    address: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
    uri: "https://example.com/",
    nonce: "32891756",
    issuedAt: "2021-09-30T16:25:24Z",
    expirationTime: "2021-09-30T20:25:24Z",
    chainId: 1,
  });
  assert.equal(rules.acceptSession({ message: mainnet, signature: "0x" + "ab".repeat(65) }, SESSION_NOW, expect, recover.recoverAddress).error, "chain");
});

test("the poll reading and the chain copy do not choose the settle side", () => {
  const locked = rules.lockCall(book({ stake: 50 }), {
    choice: "RUNNING",
    now: NOW,
    priceTenths: 40,
    paysTenths: 40,
    factorTenths: 10,
    tapeRun: 0,
    tapeIdle: 12,
    signer: "0x2C7536E3605D9C16a7a3D7b1898e529396a65c23",
    sessionNonce: "32891756",
    pollCore: "IDLE",
    pollObservedAt: "2026-11-05T10:44:02.631Z",
  });
  assert.equal(locked.ok, true);
  assert.equal(locked.state.open.signer, SIGNED_ADDRESS);
  assert.equal(locked.state.open.pollCore, "IDLE");
  const kept = rules.normalize(locked.state, NOW);
  assert.equal(kept.open.signer, SIGNED_ADDRESS);
  assert.equal(kept.open.sessionNonce, "32891756");
  const state = { ...locked.state, open: { ...locked.state.open, phase: "settling" } };
  const stamp = rules.contextStamp(rules.parseSettlements(settlementFixture()), rules.parseStats(statsFixture()));
  const hostile = {
    coreStatus: "ZOOMIES",
    choice: "IDLE",
    settlement: { ...stamp.settlement, coreStatus: "ZOOMIES" },
    measure: { ...stamp.measure, coreStatus: "ZOOMIES" },
  };
  const hit = rules.applyReading(state, reading({ coreStatus: "ACTIVE", rpmMilli: 18000 }), NOW + 12000, hostile);
  assert.equal(hit.slip.outcome, "hit");
  assert.equal(hit.slip.side, "RUNNING");
  assert.equal(hit.slip.coreStatus, "ACTIVE");
  assert.equal(hit.slip.pollCore, "IDLE");
  assert.equal(hit.slip.signer, SIGNED_ADDRESS);
  assert.equal(hit.slip.context.settlement.height, "2366");
  assert.equal(hit.slip.context.measure.roundSeconds, 600);
  assert.equal(JSON.stringify(hit.slip).includes("ZOOMIES"), false);
  assert.equal(hit.state.bank, 1000 - 50 + rules.callReturn(50, 40));
  assert.equal(rules.lockCall(book(), { choice: "IDLE", now: NOW, paysTenths: 11, signer: "0xnope" }).ok, false);

  const same = reading({ coreStatus: "IDLE" });
  assert.equal(rules.readingKey(same), same.observedAt);
  assert.equal(rules.readingKey(reading({ coreStatus: "ACTIVE" })), same.observedAt);
  const tape = rules.pushTape(rules.pushTape([], { key: rules.readingKey(same), running: false }), {
    key: rules.readingKey(reading({ coreStatus: "ACTIVE" })),
    running: true,
  });
  assert.equal(tape.length, 1);
  assert.equal(tape[0].running, false);
});

function settlementFixture() {
  return {
    status: "available",
    range: "24h",
    generatedAt: "2026-10-28T23:38:34.223Z",
    chain: { chainId: "11155111" },
    summary: { settlementCount: "141" },
    recentSettlements: [
      {
        transactionHash: "0x1656b585be00b72032006a93e0ba0a1050e343f17e5f6cd5bc42e7aaf30c9b59",
        previousSettledThroughRound: "345",
        settledThroughRound: "346",
        blockHeight: "2366",
        blockTimestamp: "2026-10-28T23:30:36.000Z",
        confirmationStatus: "safe",
        coreStatus: "ACTIVE",
      },
      {
        transactionHash: "0x0808d29bb22684bc57ac254336695bfffbac9ff7a0378d91eaf843558401356b",
        previousSettledThroughRound: "344",
        settledThroughRound: "345",
        blockHeight: "2310",
        blockTimestamp: "2026-10-28T23:20:36.000Z",
      },
      { transactionHash: "not-a-tx", blockHeight: "1" },
    ],
  };
}

function statsFixture() {
  return {
    range: "7d",
    generatedAt: "2026-10-28T23:38:33.278Z",
    window: { roundSeconds: 600 },
    lifetime: { activeDayCount: 3, settlementCount: "303" },
    activity: { coverage: { coverageBps: 3708 } },
    rounds: { observedCount: 346, activeCount: 56, activeRateBps: 1618 },
    records: { peakObservedRpmMilli: { value: "111256", occurredAt: "2026-10-28T21:28:20.307Z" } },
  };
}

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
