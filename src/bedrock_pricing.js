#!/usr/bin/env node
"use strict";

// On-demand Amazon Bedrock prices for Claude models, from the public AWS Price
// List (no credentials needed). Prices are cached on disk; when the cache is
// stale, a detached copy of this script refreshes it in the background so the
// status line never waits on the network. Run directly to refresh now.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const OFFER_URL = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/${REGION}/index.json`;
// Runtime files (prices and per-session state) live in <repo>/cache, outside src.
const CACHE_DIR = path.join(__dirname, "..", "cache");
const CACHE_FILE = path.join(CACHE_DIR, "pricing.json");
const LOCK_FILE = path.join(CACHE_DIR, "pricing.lock");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000; // wait between refresh attempts (also covers failures)
// Bump CACHE_VERSION when parsing changes so old caches are refetched.
const CACHE_VERSION = 2;

// e.g. "Claude Opus 5.5 (Amazon Bedrock Edition)" -> "opus 5.5", and the 3.x
// naming "Claude 3.7 Sonnet (Amazon Bedrock Edition)" -> "sonnet 3.7". A " v2"
// suffix is dropped; v1 and v2 share prices, and only v2 lists cache prices.
const NAME_RE =
  /^Claude (?:([A-Za-z]+) (\d+(?:\.\d+)?)|(\d+(?:\.\d+)?) ([A-Za-z]+)(?: v\d+)?) \(Amazon Bedrock Edition\)$/;
// The price list names on-demand usage types in one of two formats:
//   "USE1-MP:USE1_cache_write_tokens_1h_global_standard-Units" (newer models)
//   "USE1-MP:USE1_CacheWrite1hInputTokenCount_Global-Units" (older models)
// Only plain on-demand types match; batch, provisioned, latency-optimized, etc. don't.
const USAGE_RES = [
  /^[^:]*:[A-Z0-9]+_(input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|cache_write_tokens_1h)_(global_)?standard-Units$/,
  /^[^:]*:[A-Z0-9]+_(InputTokenCount|OutputTokenCount|CacheReadInputTokenCount|CacheWriteInputTokenCount|CacheWrite1hInputTokenCount)(_Global)?-Units$/,
];
const FIELD = {
  input_tokens: "input",
  output_tokens: "output",
  cache_read_tokens: "cache_read",
  cache_write_tokens: "cache_write_5m",
  cache_write_tokens_1h: "cache_write_1h",
  InputTokenCount: "input",
  OutputTokenCount: "output",
  CacheReadInputTokenCount: "cache_read",
  CacheWriteInputTokenCount: "cache_write_5m",
  CacheWrite1hInputTokenCount: "cache_write_1h",
};

const key = (family, version) => `${family.toLowerCase()} ${version}`;

// Normalize a model id to the key used in the cache, e.g.
// "global.anthropic.claude-opus-5-5[1m]" -> "opus 5.5",
// "claude-haiku-4-5-20251001" -> "haiku 4.5",
// "anthropic.claude-3-7-sonnet-20250219-v1:0" -> "sonnet 3.7"
function modelKey(id) {
  const s = String(id ?? "");
  let m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(s);
  if (m) return key(m[1], m[3] ? `${m[2]}.${m[3]}` : m[2]);
  m = /claude-(\d+)(?:-(\d))?-([a-z]+)/i.exec(s);
  return m ? key(m[3], m[2] ? `${m[1]}.${m[2]}` : m[1]) : null;
}

// Shape: { version, fetchedAt, region, source, models: { [key]: { global|standard:
// { input, output, cache_read, cache_write_5m, cache_write_1h } } } }, in USD per
// 1M tokens. Models only list the prices they support (e.g. no 1h cache writes).
function parseOffer(offer) {
  const models = {};
  for (const [sku, p] of Object.entries(offer.products ?? {})) {
    const name = NAME_RE.exec(p.attributes?.servicename ?? "");
    const usagetype = p.attributes?.usagetype ?? "";
    const usage = USAGE_RES.map((re) => re.exec(usagetype)).find(Boolean);
    if (!name || !usage) continue;
    const k = name[1] ? key(name[1], name[2]) : key(name[4], name[3]);
    for (const term of Object.values(offer.terms?.OnDemand?.[sku] ?? {})) {
      for (const dim of Object.values(term.priceDimensions ?? {})) {
        const unit = /^1([KM]) tokens$/i.exec(dim.unit ?? "");
        const usd = Number(dim.pricePerUnit?.USD);
        if (!unit || !Number.isFinite(usd)) continue;
        const tier = usage[2] ? "global" : "standard";
        models[k] ??= {};
        models[k][tier] ??= {};
        models[k][tier][FIELD[usage[1]]] = unit[1].toUpperCase() === "K" ? usd * 1000 : usd;
      }
    }
  }
  return models;
}

async function refreshPricing() {
  const res = await fetch(OFFER_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${OFFER_URL}`);
  const models = parseOffer(await res.json());
  if (Object.keys(models).length === 0) throw new Error("no prices found in offer");
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, fetchedAt: Date.now(), region: REGION, source: OFFER_URL, models }));
  fs.renameSync(tmp, CACHE_FILE);
}

function loadPricing() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

const mtimeAge = (file) => {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
};

// Start a background refresh if the cache is missing or stale, at most once per
// RETRY_MS. Returns the current (possibly stale or null) cached pricing.
function getPricing() {
  const pricing = loadPricing();
  const stale =
    !pricing ||
    pricing.version !== CACHE_VERSION ||
    Date.now() - pricing.fetchedAt > CACHE_TTL_MS ||
    pricing.region !== REGION;
  if (stale && mtimeAge(LOCK_FILE) > RETRY_MS) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(LOCK_FILE, String(process.pid));
      spawn(process.execPath, [__filename], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // try again after RETRY_MS
    }
  }
  return pricing;
}

module.exports = { CACHE_DIR, getPricing, modelKey };

if (require.main === module) {
  refreshPricing().catch((e) => {
    console.error(`bedrock_pricing: ${e.message}`);
    process.exitCode = 1;
  });
}
