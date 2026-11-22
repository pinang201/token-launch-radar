# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/pinang201/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/pinang201/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Launch Radar** — a token launch radar built from one sealed DefiLlama snapshot (758 protocols, fetched 2026-11-14). It sets the 416 protocols whose token already trades apart, and ranks the 198 that record no token yet by an **implied launch value**: what a token would be worth if the protocol launched at the pricing its trading peers actually get.

The model (version `peer-multiple-2`, in `lib/model.ts`) prices every row with the same arithmetic and never looks a protocol up by name:

```
implied value = TVL × peer multiple × growth factor × maturity factor
```

- **Peer multiple** — the market-cap / TVL multiple of already-trading protocols, taken as the median per category and per main chain, each weighted by its peer count and shrunk toward the market-wide median (0.17×) when a group is thin. Peer multiples are clipped to [0.01×, 10×] first, so one mispriced micro-cap cannot set a category's price.
- **Growth factor** — from the protocol's 7-day TVL change, clamped to [−60%, +120%] so one wild week cannot dominate.
- **Maturity factor** — from how long the protocol has run with no token, rising from 0.82× for a new protocol to 1.10× at five years.

The board covers all 40 protocols on the house watchlist and 158 more below its $50M floor. Wrapped, staked and bridged products of tokens that already trade, versioned deployments and exchange venues are excluded by stated category and name rules — the same rules that define the watchlist. Every row carries a six-step farm plan assembled from the protocol's own record (category, main chain, TVL, age), with concrete costs and times.

The dashboard in `dashboard/` is a static page with no network calls: a sortable, filterable board (search, category, chain, watchlist-only), a detail view per protocol showing the full model breakdown and farm plan, and the trading set shown apart as the peer evidence. `screenshots/` holds the board, a detail view and a filtered view.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

The grader mounts the sealed snapshot at `/input/snapshot.json`, which is the default input; `--input` accepts the snapshot file or its directory. The program writes `out/board.json`, `out/data.js`, `out/dashboard/`, `out/screenshots/` and `out/dossier.json`, and runs deterministically: two runs on the same snapshot write the same bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=cgkpfmz6&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
