# Squeek Call

Call **RUNNING** or **IDLE** on the live wheel. The stake sits in escrow for 12 seconds. One fresh status read settles the slip.

House chips, stored in this browser. Unofficial. Not affiliated with Squeekchain.
[@bangbangying](https://x.com/bangbangying) · `0x09d56b200b8B4f9d1CE9fa6D9dEF43f3D730B010`

```
squeekchain-project: PENDING_UUID_AFTER_SUBMIT
```

## Play

1. Open the page over HTTP (a local file URL often blocks the feed). The wheel fills in once `GET https://api.squeekchain.com/v1/status` answers. No query string — the endpoint rejects one.
2. Pick a stake (20, 50, 100, 200, or whatever is left under that). Press **RUNNING** or **IDLE**, or `R` / `I`.
3. The chip leaves the stack. The clock runs 12 seconds of wall time. Reloading keeps the slip and settles it when you come back.
4. At zero the page fetches status again. `measurement.coreStatus` decides it:
   - `ACTIVE` or `RUNNING` counts as **RUNNING**
   - `IDLE` counts as **IDLE**
   - `COUNTER_FAULT`, a missing measurement, or a failed fetch **returns the stake** and leaves the streak alone
5. A hit pays the rate that was printed on the button. A miss takes the chip and resets the streak. **Bank streak** (`B`) keeps the chips and puts the multiplier back to ×1.
6. An empty stack can open a new book of 1,000 chips. The slips stay.

The spinner follows `rpmMilli` from a poll about every 2 seconds. That poll does not settle anything. The last 12 distinct readings (same `observedAt` is not counted twice) set the price: a side pays **1.1× plus 2.9× the other side's share**. Under four readings both sides pay **1.5×**. Streak multiplies the price by ×1, ×1.3, ×1.6, ×2, then ×2.5, capped at **6×**. Returned chips are `round(stake × rate)`. The locked rate, the tape counts, `coreStatus`, anchor height, and rpm are on the slip.

Anchor height is `builder.anchor.blockHeight`, the settled frontier. Projected blocks are not shown.

Chips are a score under `localStorage` key `squeek-call-v2`. Clearing site data clears the book. An older `squeek-call-v1` score book is copied in as slips without stakes. The page does not connect a wallet or send a transaction.

## Run locally

```sh
python3 -m http.server 8765
# http://127.0.0.1:8765/
```

Static files. No build, no packages. The house rules can be checked with `node --test test/rules.test.mjs`.

GitHub Pages serves this directory as-is. `CNAME` is `squeekcall.xyz`.

## Files

- `index.html` — the table, plus the `squeekchain-project` meta placeholder
- `app.js` — clock, poll, slips, the book
- `rules.js` — prices, escrow, settle, storage shape
- `style.css`
- `favicon.svg`
- `test/rules.test.mjs`
- `LICENSE` — MIT

## Attribution

After a direct website submit, put the project UUID in both the meta tag in `index.html` and the `squeekchain-project:` line above. Then the DNS TXT record, then verify.

## License

MIT
