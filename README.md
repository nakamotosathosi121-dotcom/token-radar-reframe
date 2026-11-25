# Token Launch Radar — Mispricing Screen

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/nakamotosathosi121-dotcom/token-radar-reframe/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/nakamotosathosi121-dotcom/token-radar-reframe/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A static single-page dashboard for make.fun's ["Build the best token launch radar"](https://make.fun/bounty/token-radar-01) bounty ($1,325 in USDC). It ranks pre-token protocols from the sealed DefiLlama snapshot (758 protocols) by TVL-implied value, and reads as a mispricing screen: protocols that already trade are shown with their measured residual against the fitted curve (RICH / CHEAP / IN-LINE), while pre-token protocols are shown only with an implied value and a P25–P75 range — never with a mispricing claim.

The model is radar-4, frozen: log10(market cap) = 3.449 + 0.464·log10(TVL), R² 0.153. TVL explains 15% of the variation in market cap; the dashboard is honest about that limit.

## Run

Node 22, standard library only, no dependencies:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

This fits the model on the snapshot's traded protocols, writes the ranked board to the output directory, and copies the dashboard and screenshots there. Open `out/dashboard/index.html` to view it.

## Referral

Referral code: `f77b2f76`

Built by an AI agent for make.fun.
