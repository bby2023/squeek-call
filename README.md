# Squeek Call

A twelve-second house-chip book on the live wheel. Call **RUNNING** or **IDLE**. The stake sits in escrow for 12 seconds. One fresh status read settles the slip.

The chain's rounds are 600 seconds and show up on the settlements copy. This book does not wait for them. House chips stay in this browser. A wallet can sign the desk in; the signature names whose stack is open. Unofficial. Not affiliated with Squeekchain.
[@bangbangying](https://x.com/bangbangying) · `0x09d56b200b8B4f9d1CE9fa6D9dEF43f3D730B010`

```
squeekchain-project: 54197c12-6e05-49d4-aa33-dbb24a0ffe9f
```

## Play

1. Open the page over HTTP or HTTPS (a local file URL often blocks the feed, and a wallet needs a host to sign). The wheel fills in once `GET https://api.squeekchain.com/v1/status` answers. No query string — the endpoint rejects one.
2. Pick a stake (20, 50, 100, 200, or whatever is left under that). Press **RUNNING** or **IDLE**, or `R` / `I`.
3. The chip leaves the stack. The clock runs 12 seconds of wall time. Reloading keeps the slip and settles it when you come back.
4. At zero the page fetches status again. `measurement.coreStatus` decides it:
   - `ACTIVE` or `RUNNING` counts as **RUNNING**
   - `IDLE` counts as **IDLE**
   - `COUNTER_FAULT`, a missing measurement, or a failed fetch **returns the stake** and leaves the streak alone
5. A hit pays the rate that was printed on the button. A miss takes the chip and resets the streak. **Bank streak** (`B`) keeps the chips and puts the multiplier back to ×1.
6. An empty stack can open a new book of 1,000 chips. The slips stay.

The spinner follows `rpmMilli` from a poll about every 2 seconds. That poll does not settle anything. The last 12 distinct readings (same `observedAt` is one reading) set the price: a side pays **1.1× plus 2.9× the other side's share**. Under four readings both sides pay **1.5×**. Streak multiplies the price by ×1, ×1.3, ×1.6, ×2, then ×2.5, capped at **6×**. Returned chips are `round(stake × rate)`. The locked rate, the tape counts, `coreStatus`, the poll's `coreStatus` at lock, anchor height, and rpm are on the slip.

Anchor height is `builder.anchor.blockHeight`, the settled frontier. Projected blocks are not shown.

## What the desk reads

| Read | When | What it does |
|---|---|---|
| `GET https://api.squeekchain.com/v1/status` | about every 2s | spins the wheel and fills the tape |
| `GET https://api.squeekchain.com/v1/status` | once, at the end of the 12s | **settles the slip** |
| `GET https://api.squeekchain.com/v1/settlements?range=24h` | on load, then every 60s | clerk's copy of recent SqueekCore batches |
| `GET https://api.squeekchain.com/v1/measurement/stats?range=7d` | on load, then every 3 minutes | seven-day active-round rate, coverage, peak rpm, and `roundSeconds` |
| `GET https://api.squeekchain.com/v1/accounts/{address}?limit=1` | after sign-in, then every 60s | that address's Squeeks, claimable SQK, and power at the safe block |

Only the fresh status at the clock chooses the side. A failed status returns the stake. Settlements, stats, and the account can be quoted on the slip as context. They do not change the price or the result. `window.roundSeconds` on the stats copy is the chain's round (600 on the public feed). The book's clock is `12000` ms.

## Sign the desk

**Sign the desk** asks for an Ethereum account, switches the wallet to Sepolia (chain id `11155111`, `0xaa36a7`), and requests `personal_sign` on an [EIP-4361](https://eips.ethereum.org/EIPS/eip-4361) message. The message names this host, the address, chain 11155111, a nonce, a 12-hour expiry, and the status and account URLs.

`recover.js` recovers the signer in the browser (EIP-191) and checks it against the address in the message. The check uses a vendored bundle of `@noble/curves` 1.9.1 and `@noble/hashes` 1.8.0. No key is in the repo. There is no Squeek Call contract and no transaction.

The guest stack stays in `localStorage` under `squeek-call-v2`. A signed stack is `squeek-call-v3:` plus the lowercase address, with its own 1,000 chips. Leaving the signed book returns to the guest stack. The session record is `squeek-call-session` (the message and the signature). On load the page checks the signature again, the host, the chain id, and the expiry. An expired session drops back to the guest book after the open slip settles.

An older `squeek-call-v1` score book is copied into the guest book as slips without stakes. Clearing site data clears the books.

## Run locally

```sh
python3 -m http.server 8765
# http://127.0.0.1:8765/
```

Static files. No build, no packages. The house rules can be checked with `node --test test/rules.test.mjs`.

GitHub Pages serves this directory as-is. `CNAME` is `squeekcall.xyz`.

## Files

- `index.html` — the table, plus the `squeekchain-project` meta placeholder
- `app.js` — clock, poll, slips, the book, the wallet sign-in, the clerk's copies
- `rules.js` — prices, escrow, settle, SIWE checks, the copy parsers
- `recover.js` — local EIP-191 recovery and EIP-55 checksum
- `style.css`
- `favicon.svg`
- `test/rules.test.mjs`
- `LICENSE` — MIT

## Attribution

After a direct website submit, put the project UUID in both the meta tag in `index.html` and the `squeekchain-project:` line above. Then the DNS TXT record, then verify.

## License

MIT
