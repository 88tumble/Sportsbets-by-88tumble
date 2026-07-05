/**
 * Line Scanner — trigger-only analyst consensus + edge alerts
 *
 * Flow:
 *   1. Pull today's analyst picks (NBA + World Cup) via Anthropic API + web search
 *   2. Load config + analyst records, compute effective weights
 *   3. Fetch live odds (The Odds API for NBA, OddsPapi for World Cup)
 *   4. Evaluate triggers: consensus / weighted dissent / market edge
 *   5. POST Discord embed ONLY when a trigger fires. Silent otherwise.
 *
 * Env vars (set as GitHub Actions secrets):
 *   ANTHROPIC_API_KEY   — required
 *   DISCORD_WEBHOOK_URL — required
 *   ODDS_API_KEY        — required for NBA edge checks (the-odds-api.com)
 *   ODDSPAPI_KEY        — optional, for World Cup odds (oddspapi.io)
 */

const fs = require("fs");
const path = require("path");

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const RECORDS_PATH = path.join(__dirname, "records.json");
const RECORDS = JSON.parse(fs.readFileSync(RECORDS_PATH, "utf8"));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDSPAPI_KEY = process.env.ODDSPAPI_KEY;

// ---------------------------------------------------------------------------
// 1. Analyst pick pull — one targeted API call PER GAME for max extraction
// ---------------------------------------------------------------------------

/** Build today's game list from the odds feeds (fixtures double as the slate). */
function buildSlate(nbaOdds, wcOdds) {
  const now = Date.now();
  const windowMs = 36 * 60 * 60 * 1000; // games starting within the next 36h
  const slate = [];

  for (const g of nbaOdds || []) {
    const t = Date.parse(g.commence_time);
    if (t > now - 2 * 3600e3 && t < now + windowMs) {
      slate.push({ sport: "nba", game: `${g.away_team} vs ${g.home_team}` });
    }
  }
  for (const g of wcOdds || []) {
    const t = Date.parse(g.commence_time);
    if (t > now - 2 * 3600e3 && t < now + windowMs) {
      slate.push({ sport: "worldcup", game: `${g.away_team} vs ${g.home_team}` });
    }
  }
  return slate.slice(0, CONFIG.anthropic.maxGamesPerRun || 12);
}

async function pullPicksForGame(entry) {
  const today = new Date().toISOString().slice(0, 10);
  const sources = CONFIG.analystSources.join(", ");
  const sportLabel = entry.sport === "nba" ? "NBA game" : "FIFA World Cup 2026 match";

  const prompt = `Search the web for published expert betting picks for the ${sportLabel}: ${entry.game} (played on or around ${today}).

Search multiple times with different queries to find as many picks as possible. Check these sources: ${sources}.

Extract EVERY pick you find, including:
- Named analyst picks (use "Analyst Name (Outlet)")
- Unbylined staff/site picks (use just the outlet name, e.g. "Covers staff")
- Only include picks whose actual side is stated in free text. If an article teases a pick behind a paywall without revealing the side, skip it.

For each pick:
- analyst: name and outlet, or outlet name if unbylined
- sport: "${entry.sport}"
- game: "${entry.game}"
- market: "spread" | "moneyline" | "total" | "prop"
- pick: the exact side/number, e.g. "Over 2.5", "Brazil -1.5", "Norway ML"
- lineAtPick: the line/odds quoted, if stated (string, else null)
- record: the analyst's documented record if stated (string, else null)

Respond with ONLY a raw JSON array. No markdown fences, no preamble. If no picks found, respond [].`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CONFIG.anthropic.model,
      max_tokens: CONFIG.anthropic.maxTokens,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: CONFIG.anthropic.searchesPerGame || 8 }],
    }),
  });

  if (!res.ok) {
    console.error(`Anthropic API error ${res.status} on ${entry.game}: ${await res.text()}`);
    return [];
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return extractJsonArray(text);
}

async function pullAnalystPicks(slate) {
  const all = [];
  for (const entry of slate) {
    console.log(`Pulling picks: ${entry.game} (${entry.sport})…`);
    const picks = await pullPicksForGame(entry).catch((e) => (console.error(e.message), []));
    console.log(`  → ${picks.length} picks`);
    all.push(...picks);
  }
  return dedupePicks(all);
}

/** Same analyst + game + market + normalized side = one pick. */
function dedupePicks(picks) {
  const seen = new Set();
  const out = [];
  for (const p of picks) {
    const key = [p.analyst, (p.game || "").toLowerCase(), p.market, normalizeSide(p.pick || "")].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** Strip fences, take everything between first [ and last ] — the pattern that
 *  survives Claude occasionally wrapping output despite instructions. */
function extractJsonArray(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    console.error("JSON parse failed on analyst pull:", e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2. Weighting
// ---------------------------------------------------------------------------

function effectiveWeight(analystName) {
  const rec = RECORDS.analysts[analystName];
  const tierKey = rec ? rec.tier : "tier3";
  const tierWeight = (CONFIG.analystTiers[tierKey] || CONFIG.analystTiers.tier3).weight;

  // Earned weighting: once we've graded 10+ picks, scale by hit rate.
  if (rec && rec.picksGraded >= 10) {
    const decisions = rec.wins + rec.losses;
    if (decisions > 0) {
      const hitRate = rec.wins / decisions;
      return +(tierWeight * (0.5 + hitRate)).toFixed(2);
    }
  }
  return tierWeight;
}

/** Register any analyst we haven't seen before so records.json grows over time. */
function registerNewAnalysts(picks) {
  const today = new Date().toISOString().slice(0, 10);
  for (const p of picks) {
    if (!p.analyst) continue;
    if (!RECORDS.analysts[p.analyst]) {
      RECORDS.analysts[p.analyst] = {
        tier: "tier3",
        picksTracked: 0,
        picksGraded: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        lastSeen: today,
      };
    }
    RECORDS.analysts[p.analyst].picksTracked += 1;
    RECORDS.analysts[p.analyst].lastSeen = today;
  }
}

// ---------------------------------------------------------------------------
// 3. Live odds
// ---------------------------------------------------------------------------

async function fetchNbaOdds() {
  if (!ODDS_API_KEY || !CONFIG.sports.nba.enabled) return [];
  const { sport, regions, markets } = CONFIG.sports.nba.oddsApi;
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=${regions}&markets=${markets}&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`The Odds API error ${res.status}`);
    return [];
  }
  return res.json();
}

async function fetchWorldCupOdds() {
  if (!CONFIG.sports.worldcup.enabled) return [];

  // Primary: The Odds API (same key + response shape as NBA, so edge logic just works)
  if (ODDS_API_KEY && CONFIG.sports.worldcup.oddsApi) {
    const { sport, regions, markets } = CONFIG.sports.worldcup.oddsApi;
    const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${ODDS_API_KEY}&regions=${regions}&markets=${markets}&oddsFormat=american`;
    const res = await fetch(url);
    if (res.ok) {
      const games = await res.json();
      if (Array.isArray(games) && games.length) {
        console.log(`World Cup odds via The Odds API: ${games.length} games`);
        return games;
      }
    } else {
      console.error(`The Odds API (World Cup) error ${res.status} — trying OddsPapi fallback`);
    }
  }

  // Fallback: OddsPapi. Note: key goes as a QUERY PARAMETER, not a header.
  if (!ODDSPAPI_KEY) return [];
  const { sportId, tournamentName } = CONFIG.sports.worldcup.oddsPapi;
  const res = await fetch(
    `https://api.oddspapi.io/v4/fixtures?sportId=${sportId}&apiKey=${ODDSPAPI_KEY}`
  );
  if (!res.ok) {
    console.error(`OddsPapi error ${res.status}`);
    return [];
  }
  const fixtures = await res.json();
  const list = Array.isArray(fixtures) ? fixtures : fixtures.data || [];
  return list.filter((f) =>
    (f.tournamentName || f.tournament?.name || "")
      .toLowerCase()
      .includes(tournamentName.toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// 4. Trigger evaluation
// ---------------------------------------------------------------------------

function groupPicks(picks) {
  // Key: sport | game | market | normalized pick side
  const groups = {};
  for (const p of picks) {
    if (!p.game || !p.pick) continue;
    const key = [p.sport, p.game.toLowerCase(), p.market, normalizeSide(p.pick)].join("|");
    if (!groups[key]) groups[key] = { picks: [], sport: p.sport, game: p.game, market: p.market, side: p.pick };
    groups[key].picks.push(p);
  }
  return Object.values(groups);
}

function normalizeSide(pick) {
  // "Lakers -3.5" / "Lakers -4" are the same side; "Over 2.5" / "Over 2.5 goals"
  // / "Over (2.5)" must group together too. Strip numbers, parentheticals, and
  // filler words that vary by outlet phrasing.
  return String(pick)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[-+]?\d+(\.\d+)?/g, " ")
    .replace(/\b(goals?|points?|pts|total|ml|moneyline|money line|regulation|reg|to win|to advance|advance|qualify|qualifies)\b/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evaluateTriggers(groups, allPicks) {
  const t = CONFIG.triggers;
  const alerts = [];

  for (const g of groups) {
    const weighted = g.picks.reduce((sum, p) => sum + effectiveWeight(p.analyst), 0);
    const names = g.picks.map((p) => `${p.analyst} (w${effectiveWeight(p.analyst)})`);

    // Trigger A: consensus — N+ analysts OR weighted score threshold on same side
    if (g.picks.length >= t.consensusMinAnalysts || weighted >= t.consensusMinWeightedScore) {
      alerts.push({
        type: "CONSENSUS",
        color: CONFIG.discord.colorConsensus,
        sport: g.sport,
        game: g.game,
        market: g.market,
        side: g.side,
        weightedScore: +weighted.toFixed(2),
        analysts: names,
        detail: `${g.picks.length} analysts, weighted score ${weighted.toFixed(1)}`,
      });
    }
  }

  // Trigger B: heavyweight dissent — a high-weight analyst alone against a consensus side
  const byGameMarket = {};
  for (const g of groups) {
    const gmKey = [g.sport, g.game.toLowerCase(), g.market].join("|");
    (byGameMarket[gmKey] = byGameMarket[gmKey] || []).push(g);
  }
  for (const sides of Object.values(byGameMarket)) {
    if (sides.length < 2) continue;
    const sorted = [...sides].sort((a, b) => b.picks.length - a.picks.length);
    const majority = sorted[0];
    for (const minority of sorted.slice(1)) {
      const heavy = minority.picks.find((p) => effectiveWeight(p.analyst) >= CONFIG.triggers.dissentMinWeight);
      if (heavy && majority.picks.length >= 2) {
        alerts.push({
          type: "DISSENT",
          color: CONFIG.discord.colorDissent,
          sport: minority.sport,
          game: minority.game,
          market: minority.market,
          side: minority.side,
          weightedScore: effectiveWeight(heavy.analyst),
          analysts: [heavy.analyst],
          detail: `${heavy.analyst} (weight ${effectiveWeight(heavy.analyst)}) against ${majority.picks.length}-analyst consensus on "${majority.side}"`,
        });
      }
    }
  }

  return alerts;
}

/** Trigger C: edge vs market. Compares consensus spread/total picks against
 *  the best current book number. Fires when the gap beats the threshold.
 *  Works for any sport whose odds come from The Odds API (NBA + World Cup). */
function evaluateMarketEdges(alerts, oddsBySport) {
  const t = CONFIG.triggers.edgeThresholds;
  const out = [];

  for (const alert of alerts) {
    if (alert.type !== "CONSENSUS") continue;
    const oddsList = oddsBySport[alert.sport];
    if (!oddsList || !oddsList.length) continue;
    const pickNum = extractNumber(alert.side) ?? extractNumber(alertSideRaw(alert));
    if (pickNum === null) continue;

    const game = matchGame(oddsList, alert.game);
    if (!game) continue;

    const marketKey = alert.market === "total" ? "totals" : alert.market === "spread" ? "spreads" : null;
    if (!marketKey) continue;

    const best = bestBookNumber(game, marketKey, alert.side);
    if (best === null) continue;

    const gap = Math.abs(pickNum - best.point);
    const threshold =
      alert.sport === "worldcup"
        ? t.soccerTotalGoals || 0.5
        : marketKey === "totals"
          ? t.nbaTotalPoints
          : t.nbaSpreadPoints;
    if (gap >= threshold) {
      out.push({
        ...alert,
        type: "EDGE",
        color: CONFIG.discord.colorEdge,
        detail: `Analyst number ${pickNum} vs best book ${best.point} (${best.book}) — ${gap.toFixed(1)} pt gap`,
      });
    }
  }
  return out;
}

function alertSideRaw(alert) {
  return alert.analysts.length ? alert.side : "";
}

function extractNumber(str) {
  const m = String(str || "").match(/[-+]?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function matchGame(oddsList, gameName) {
  const teams = gameName.toLowerCase().split(/\s+vs\.?\s+|\s+@\s+/);
  return oddsList.find((g) => {
    const home = (g.home_team || "").toLowerCase();
    const away = (g.away_team || "").toLowerCase();
    return teams.every((tm) => home.includes(tm.trim()) || away.includes(tm.trim()));
  });
}

function bestBookNumber(game, marketKey, side) {
  let best = null;
  const sideNorm = normalizeSide(side);
  for (const book of game.bookmakers || []) {
    const market = (book.markets || []).find((m) => m.key === marketKey);
    if (!market) continue;
    for (const outcome of market.outcomes || []) {
      const outcomeNorm = (outcome.name || "").toLowerCase();
      const isMatch =
        marketKey === "totals"
          ? sideNorm.includes(outcomeNorm) // "over" / "under"
          : sideNorm.includes(outcomeNorm) || outcomeNorm.includes(sideNorm.split(" ")[0] || "");
      if (isMatch && typeof outcome.point === "number") {
        if (!best || Math.abs(outcome.point) < Math.abs(best.point)) {
          best = { point: outcome.point, book: book.title };
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 5. Discord
// ---------------------------------------------------------------------------

async function postToDiscord(alerts) {
  if (!alerts.length) return;

  // Discord allows max 10 embeds per message
  for (let i = 0; i < alerts.length; i += 10) {
    const batch = alerts.slice(i, i + 10);
    const embeds = batch.map((a) => ({
      title: `${emoji(a.type)} ${a.type}: ${a.side}`,
      description: `**${a.game}** — ${a.sport === "nba" ? "NBA" : "World Cup"} (${a.market})`,
      color: a.color,
      fields: [
        { name: "Signal", value: a.detail, inline: false },
        { name: "Analysts", value: a.analysts.join("\n").slice(0, 1024) || "—", inline: false },
        { name: "Weighted score", value: String(a.weightedScore), inline: true },
      ],
      footer: { text: "Line Scanner • trigger-only mode" },
      timestamp: new Date().toISOString(),
    }));

    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: CONFIG.discord.botName, embeds }),
    });

    // 204 = success; 404 = webhook deleted; 401/403 = permissions
    if (res.status !== 204 && !res.ok) {
      console.error(`Discord webhook error ${res.status}: ${await res.text()}`);
    }
  }
}

function emoji(type) {
  return type === "CONSENSUS" ? "🎯" : type === "DISSENT" ? "⚡" : "📈";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  if (!ANTHROPIC_API_KEY || !DISCORD_WEBHOOK_URL) {
    console.error("Missing ANTHROPIC_API_KEY or DISCORD_WEBHOOK_URL");
    process.exit(1);
  }

  console.log("Fetching live odds (also used to build today's slate)…");
  const nbaOdds = await fetchNbaOdds().catch((e) => (console.error(e.message), []));
  const wcOdds = await fetchWorldCupOdds().catch((e) => (console.error(e.message), []));

  const slate = buildSlate(nbaOdds, wcOdds);
  console.log(`Slate: ${slate.length} game(s) in window`);
  if (!slate.length) {
    console.log("No upcoming games found — exiting silently.");
    return;
  }

  const picks = await pullAnalystPicks(slate);
  console.log(`Total unique picks across slate: ${picks.length}`);

  if (!picks.length) {
    console.log("No picks found — exiting silently (trigger-only mode).");
    return;
  }

  registerNewAnalysts(picks);

  const groups = groupPicks(picks);
  let alerts = evaluateTriggers(groups, picks);
  const edgeAlerts = evaluateMarketEdges(alerts, { nba: nbaOdds, worldcup: wcOdds });

  alerts = [...alerts, ...edgeAlerts];

  // Log picks awaiting grading so records can be updated later
  const today = new Date().toISOString().slice(0, 10);
  RECORDS.pendingPicks.push(
    ...picks.map((p) => ({ ...p, date: today, result: null }))
  );
  fs.writeFileSync(RECORDS_PATH, JSON.stringify(RECORDS, null, 2));

  if (alerts.length) {
    console.log(`${alerts.length} trigger(s) fired — posting to Discord`);
    await postToDiscord(alerts);
  } else {
    console.log("No triggers fired. Staying silent.");
  }
})();
