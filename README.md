# Squeek Call

Call whether Squeektoshi is **RUNNING** or **IDLE** twelve seconds from now.

The page polls the public Squeekchain status API while you wait. When the clock hits zero it fetches once more and scores you against `measurement.coreStatus`. No wallet, no backend, no one else can flip the result — the feed is what it is.

Unofficial companion. Not affiliated with Squeekchain.
[@bangbangying](https://x.com/bangbangying) · `0x09d56b200b8B4f9d1CE9fa6D9dEF43f3D730B010`

Live site goes on an own-domain host later (shared hosts like github.io / vercel.app / netlify.app get rejected on verify).

## Playing

1. Open the page. Live feed should fill in a second or two (polls about every 3s).
2. Hit **Call RUNNING** / **Call IDLE**, or press `R` / `I`.
3. 12s clock. At zero we re-fetch `GET https://api.squeekchain.com/v1/status` and map `coreStatus` → RUNNING or IDLE.
4. Hit bumps score + streak; miss resets streak. Personal bests and the call log sit in `localStorage` (clear site data = gone — fine, it's a toy).

The wheel spins from `rpmMilli`. The pulse strip is the last ~48 status samples so you can see the idle/running texture before you call. Neither one settles the round; only that final status pull does.

Also shown, same API family:
- `GET /v1/settlements` — recent Sepolia txs (links out to Blockscout)
- `GET /v1/measurement/stats?range=7d` — lifetime work / distance / settlement count

## Run locally

```sh
python3 -m http.server 8765
# then http://127.0.0.1:8765/
```

Plain HTML/CSS/JS. No build, no packages. Needs network access to `api.squeekchain.com`.

## Files

- `index.html` — shell + `squeekchain-project` meta placeholder
- `app.js` — poll, wheel, pulse, calls, settlements, stats
- `style.css`
- `favicon.svg`
- `LICENSE` — MIT

## Attribution

After Direct website submit, drop the project UUID into **both**:

1. the `<meta name="squeekchain-project" content="…">` in `index.html`
2. this line:

```
squeekchain-project: PENDING_UUID_AFTER_SUBMIT
```

Then put DNS TXT `_squeekchain.<host> = squeekchain-verify=<token>` on your own domain and hit verify.

## License

MIT
