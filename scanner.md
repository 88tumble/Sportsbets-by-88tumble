# Line Scanner — Trigger-Only Analyst Consensus Alerts

Pulls published expert picks (NBA + FIFA World Cup 2026) twice daily, weights them by analyst track record, checks the live market for edges, and posts to Discord **only when a trigger fires**. No servers, no desktop — runs entirely on GitHub Actions free tier.

## What's in this repo

| File | Purpose |
|---|---|
| `scanner.js` | The whole pipeline: analyst pull → weighting → triggers → Discord |
| `config.json` | Analyst tiers, trigger thresholds, sport settings — edit this, not the code |
| `records.json` | Persistent analyst hit-rate tracking; auto-committed after each run |
| `.github/workflows/scan.yml` | Schedule (10am + 4pm ET) and secrets wiring |

## Triggers (alerts fire on any of these)

1. **CONSENSUS** — 3+ analysts on the same side, OR combined weighted score ≥ 5.0
2. **DISSENT** — an analyst with effective weight ≥ 3.0 alone against a 2+ analyst consensus
3. **EDGE** — a consensus NBA pick whose number beats the best live book line by ≥ 1.5 pts (spreads) or ≥ 2.0 pts (totals)

All thresholds live in `config.json` → `triggers`.

## Weighting

- Tier 1 = 3.0, Tier 2 = 2.0, Tier 3 (unproven) = 1.0
- Once an analyst has 10+ graded picks, weight becomes **earned**: `tierWeight × (0.5 + hitRate)`. A tier-1 analyst hitting 60% carries 3.3; one hitting 40% drops to 2.7.
- New analysts are auto-registered at tier 3 as they appear.

## Setup — step by step

### 1. Create the repo
- github.com → New repository → name it (e.g. `line-scanner`) → **Private** → Create.
- Upload these four files keeping the folder structure (`scan.yml` must be at `.github/workflows/scan.yml`). On mobile/web: "Add file → Create new file" and type the path including folders.

### 2. Add secrets
Repo → Settings → Secrets and variables → Actions → New repository secret:
- `ANTHROPIC_API_KEY` — from console.anthropic.com (the only paid piece, ~$0.02–0.05/scan)
- `DISCORD_WEBHOOK_URL` — Discord channel → Edit → Integrations → Webhooks → New → Copy URL
- `ODDS_API_KEY` — free key from the-odds-api.com (NBA edge checks)
- `ODDSPAPI_KEY` — optional, from oddspapi.io (World Cup odds)

### 3. Test manually
Repo → Actions tab → "Line Scanner" → **Run workflow**. Watch the log:
- "Found N picks" confirms the analyst pull works
- "No triggers fired. Staying silent." is a *successful* quiet run
- A Discord post means a trigger fired

### 4. Let the schedule run
Cron fires at 10am and 4pm ET automatically. Adjust times in `scan.yml` (note: cron is UTC; shift by 1hr when EDT ends in November).

### 5. Grade picks weekly (keeps weights honest)
Open `records.json` → `pendingPicks` — each pick has `"result": null`. Set results to `"win"`, `"loss"`, or `"push"`, then move the tallies into the analyst's `wins`/`losses`/`pushes` and bump `picksGraded`. (This is the manual step for now; a grading script that auto-checks final scores is a natural v2.)

## Tuning tips

- Too noisy → raise `consensusMinAnalysts` to 4 or `consensusMinWeightedScore` to 6.5
- Too quiet → drop weighted score to 4.0, or enable the daily digest (`discord.sendDailyDigest`)
- World Cup ends July 19 — after that, set `sports.worldcup.enabled` to `false` to save a fetch

## Costs

GitHub Actions: free (uses ~5 of 2,000 free minutes/month). The Odds API + OddsPapi + Discord: free tiers. Anthropic API: roughly **$1.50–3/month** at 2 runs/day.

## What this deliberately does NOT do

Place bets. Automated wagering violates sportsbook terms of service and risks account bans and frozen funds. The final tap is yours.
