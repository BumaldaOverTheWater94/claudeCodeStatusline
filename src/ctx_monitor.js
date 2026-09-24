#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { CACHE_DIR, getPricing, modelKey } = require("./bedrock_pricing");

// --- input ---
const input = readJSON(0); // stdin
const sessionId = `\x1b[90m${String(input.session_id ?? "")}\x1b[0m`;
const transcript = input.transcript_path;
const model = input.model || {};
const effortLevel = input.effort?.level ?? process.env.CLAUDE_CODE_EFFORT_LEVEL;
const effort = effortLevel ? ` \x1b[93m[effort: ${effortLevel}]\x1b[0m` : "";
const name = `\x1b[95m${String(model.display_name ?? "")}\x1b[0m${effort}`.trim();
const CONTEXT_WINDOW = Number(input.context_window?.context_window_size ?? 0) || 200_000;
// Token usage from the last API call (null until the first response)
const usage = input.context_window?.current_usage ?? null;
// Bedrock price tier: geo-prefixed ids ("us.", "eu.", ...) use regional pricing;
// "global." ids (and anything else) use global cross-region pricing.
const modelId = String(model.id || process.env.ANTHROPIC_MODEL || "");
const PRICE_TIER = /^(us|us-gov|eu|apac|au|jp|ca)\./.test(modelId) ? "standard" : "global";

// --- helpers ---
function readJSON(fd) {
  try {
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch {
    return {};
  }
}
function color(p) {
  if (p >= 90) return "\x1b[31m"; // red
  if (p >= 70) return "\x1b[33m"; // yellow
  return "\x1b[32m"; // green
}
const comma = (n) =>
  new Intl.NumberFormat("en-US").format(
    Math.max(0, Math.floor(Number(n) || 0))
  );

function usedTotal(u) {
  return (
    (u?.input_tokens ?? 0) +
    (u?.output_tokens ?? 0) +
    (u?.cache_read_input_tokens ?? 0) +
    (u?.cache_creation_input_tokens ?? 0)
  );
}

function getTokenBreakdown(u) {
  const promptTokens = u?.input_tokens ?? 0;
  const cacheReadTokens = u?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = u?.cache_creation_input_tokens ?? 0;
  const outputTokens = u?.output_tokens ?? 0;

  const inputTokens = promptTokens + cacheReadTokens + cacheWriteTokens;

  return { promptTokens, cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens };
}

// Transcript files for the session: the main conversation plus each subagent's,
// which live in <session>/subagents/agent-*.jsonl next to the main transcript.
function sessionTranscripts() {
  if (!transcript) return [];
  const subDir = path.join(transcript.replace(/\.jsonl$/, ""), "subagents");
  let subs = [];
  try {
    subs = fs
      .readdirSync(subDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(subDir, f));
  } catch {
    // no subagents spawned yet
  }
  return [transcript, ...subs];
}

const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
];
const COUNT_KEYS = [
  "tool_calls",
  "tool_responses",
  "reasoning_tokens",
  "reasoning_estimated", // responses whose reasoning had to be estimated
  "tool_call_chars",
  "tool_response_chars",
];
const TOTAL_KEYS = [...USAGE_KEYS, ...COUNT_KEYS];
const emptyTotals = () => Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));

// Per-model token counts for pricing, split the way Bedrock bills them.
const PRICE_KEYS = ["input", "output", "cache_read", "cache_write_5m", "cache_write_1h"];
const emptyPriced = () => Object.fromEntries(PRICE_KEYS.map((k) => [k, 0]));

// Per-session state so each refresh only parses bytes appended since the last
// one. Shape: { version, files: { [path]: { offset, seen: [ids], open, totals,
// byModel: { [modelKey]: priced counts } } } }
// Bump STATE_VERSION when the totals shape changes so old state is rebuilt.
const STATE_VERSION = 8;
const STATE_DIR = path.join(CACHE_DIR, "state");
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function stateFile() {
  const key = String(input.session_id || path.basename(transcript || "", ".jsonl"));
  return path.join(STATE_DIR, `${key.replace(/[^\w.-]/g, "_")}.json`);
}

function loadState() {
  const s = readJSON(stateFile());
  return s?.version === STATE_VERSION && typeof s.files === "object"
    ? s
    : { version: STATE_VERSION, files: {} };
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = stateFile();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file); // atomic, so concurrent refreshes never see a partial file
  } catch {
    // state is only a cache; totals are recomputed from scratch if it's missing
  }
}

// Drop state for sessions that haven't refreshed in a week.
function pruneState() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      if (now - fs.statSync(p).mtimeMs > STATE_MAX_AGE_MS) fs.unlinkSync(p);
    }
  } catch {
    // nothing to prune
  }
}

// Read the complete lines appended to `file` since `offset`. A trailing partial
// line (still being written) is left for the next refresh.
function readNewLines(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { lines: [], offset: size < offset ? -1 : offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(0x0a) + 1; // '\n'; UTF-8 safe to split on
    return { lines: buf.subarray(0, end).toString("utf8").split(/\r?\n/), offset: offset + end };
  } catch {
    return { lines: [], offset };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const countBlocks = (content, type) =>
  Array.isArray(content) ? content.filter((b) => b?.type === type).length : 0;

// Characters in the tool calls of a content array (name + JSON input).
function toolUseChars(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b?.type === "tool_use") n += String(b.name ?? "").length + JSON.stringify(b.input ?? {}).length;
  }
  return n;
}

// Characters in the tool results of a content array. A result's content is
// either a string or a list of blocks; only text is counted (images are skipped).
function toolResultChars(content) {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b?.type !== "tool_result") continue;
    const c = b.content;
    if (typeof c === "string") n += c.length;
    else if (Array.isArray(c)) {
      for (const x of c) if (x?.type === "text") n += String(x.text ?? "").length;
    }
  }
  return n;
}

// Characters of visible output in a content array: text blocks plus tool calls.
// Thinking is hidden, so it isn't counted here.
function visibleChars(content) {
  if (!Array.isArray(content)) return 0;
  let n = toolUseChars(content);
  for (const b of content) {
    if (b?.type === "text") n += String(b.text ?? "").length;
  }
  return n;
}

// All token estimates use a rough ~4 characters per token.
const CHARS_PER_TOKEN = 4;
const charsToTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);

// Output and reasoning for one finished response. Main-conversation output is
// the recorded output_tokens; reasoning is the recorded
// output_tokens_details.thinking_tokens, or, if a response lacks that field,
// estimated as output minus the visible output. Interrupted responses (never
// given a stop_reason) only record a placeholder usage, so there's nothing to
// estimate and their reasoning is 0.
// Subagent transcripts record a placeholder output_tokens (the count from the
// start of the stream, usually 1-20), so their output is floored at the visible
// estimate, and their reasoning is unknowable and counted as 0.
function responseOutput(r, isSubagent) {
  if (!r) return { output: 0, reasoning: 0, estimated: false };
  const visible = charsToTokens(r.chars);
  if (isSubagent) return { output: Math.max(r.out, visible), reasoning: 0, estimated: false };
  if (typeof r.thinking === "number") return { output: r.out, reasoning: r.thinking, estimated: false };
  if (!r.stopped) return { output: r.out, reasoning: 0, estimated: false };
  return { output: r.out, reasoning: Math.max(0, r.out - visible), estimated: true };
}

// Sum usage across every API response in the session, including subagents.
// A single response is split into several transcript entries (one per content
// block) that share message.id and carry the same usage, so count each id once.
// Tool calls (assistant tool_use blocks) and tool responses (user tool_result
// blocks) are counted per block, since each entry holds distinct blocks.
// Output and reasoning need a response's visible output from all of its entries,
// so the latest response stays "open" (it may still be streaming) until a new one
// starts; its output and reasoning are only added to the stored totals then.
function sessionTotals() {
  const state = loadState();
  const totals = { ...emptyTotals(), byModel: {} };

  for (const file of sessionTranscripts()) {
    const isSubagent = file !== transcript;
    const fresh = () => ({ offset: 0, seen: [], open: null, totals: emptyTotals(), byModel: {} });
    let f = state.files[file] ?? fresh();
    let { lines, offset } = readNewLines(file, f.offset);
    if (offset === -1) {
      // file shrank (rewritten), so start it over
      f = fresh();
      ({ lines, offset } = readNewLines(file, 0));
    }
    const seen = new Set(f.seen);
    let open = f.open;

    for (const line of lines) {
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const m = j.message;
      if (m?.role === "user") {
        f.totals.tool_responses += countBlocks(m.content, "tool_result");
        f.totals.tool_response_chars += toolResultChars(m.content);
        continue;
      }
      if (m?.role !== "assistant") continue;
      f.totals.tool_calls += countBlocks(m.content, "tool_use");
      f.totals.tool_call_chars += toolUseChars(m.content);
      if (!m.usage || String(m.model ?? "").includes("synthetic")) continue;
      const id = m.id ?? j.requestId ?? j.uuid;
      if (open?.id === id) {
        open.chars += visibleChars(m.content);
        if (m.stop_reason) open.stopped = true;
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      for (const k of USAGE_KEYS) if (k !== "output_tokens") f.totals[k] += m.usage[k] ?? 0;
      const done = responseOutput(open, isSubagent);
      f.totals.output_tokens += done.output;
      f.totals.reasoning_tokens += done.reasoning;
      f.totals.reasoning_estimated += done.estimated ? 1 : 0;
      if (open) addPriced(f.byModel, open.model, { output: done.output });

      // Cache writes are billed by TTL; the split is in usage.cache_creation.
      const u = m.usage;
      const cacheWrite = u.cache_creation_input_tokens ?? 0;
      const cacheWrite1h = Math.min(cacheWrite, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
      const key = modelKey(m.model) ?? String(m.model ?? "unknown");
      addPriced(f.byModel, key, {
        input: u.input_tokens ?? 0,
        cache_read: u.cache_read_input_tokens ?? 0,
        cache_write_5m: cacheWrite - cacheWrite1h,
        cache_write_1h: cacheWrite1h,
      });
      open = {
        id,
        model: key,
        out: u.output_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? null,
        stopped: Boolean(m.stop_reason),
        chars: visibleChars(m.content),
      };
    }

    state.files[file] = { offset, seen: [...seen], open, totals: f.totals, byModel: f.byModel };
    for (const k of TOTAL_KEYS) totals[k] += f.totals[k];
    for (const [key, counts] of Object.entries(f.byModel)) addPriced(totals.byModel, key, counts);
    const pending = responseOutput(open, isSubagent);
    totals.output_tokens += pending.output;
    totals.reasoning_tokens += pending.reasoning;
    totals.reasoning_estimated += pending.estimated ? 1 : 0;
    if (open) addPriced(totals.byModel, open.model, { output: pending.output });
  }

  saveState(state);
  pruneState();
  return totals;
}

function addPriced(byModel, key, counts) {
  byModel[key] ??= emptyPriced();
  for (const k of PRICE_KEYS) byModel[key][k] += counts[k] ?? 0;
}

// Estimated USD cost of the per-model token counts at on-demand Bedrock prices.
// Returns null until prices are cached; `unpriced` lists models with no price.
function estimateCost(byModel) {
  const pricing = getPricing();
  if (!pricing) return null;
  let usd = 0;
  const unpriced = [];
  for (const [key, counts] of Object.entries(byModel)) {
    if (PRICE_KEYS.every((k) => counts[k] === 0)) continue;
    // Models without global pricing fall back to standard. Older models don't
    // list every rate (e.g. no 1h cache writes), so only the rates for token
    // types actually used are required.
    const tiers = pricing.models?.[key];
    const rates = tiers?.[PRICE_TIER] ?? tiers?.standard;
    if (!rates || PRICE_KEYS.some((k) => counts[k] > 0 && typeof rates[k] !== "number")) {
      unpriced.push(key);
      continue;
    }
    for (const k of PRICE_KEYS) if (counts[k] > 0) usd += (counts[k] * rates[k]) / 1_000_000;
  }
  return { usd, unpriced };
}

// --- compute/print ---
if (usedTotal(usage) === 0) {
  console.log(
    `${name} | \x1b[36mcontext window usage starts after your first question.\x1b[0m\nsession: ${sessionId}`
  );
  process.exit(0);
}

const used = usedTotal(usage);
const pct = CONTEXT_WINDOW > 0 ? Math.round((used * 1000) / CONTEXT_WINDOW) / 10 : 0;
const totals = sessionTotals();
const { promptTokens, cacheReadTokens, cacheWriteTokens, inputTokens, outputTokens } = getTokenBreakdown(totals);

const usagePercentLabel = `${color(pct)}context used ${pct.toFixed(1)}%\x1b[0m`;
const usageCountLabel = `\x1b[33m(${comma(used)}/${comma(CONTEXT_WINDOW)})\x1b[0m`;

// Build running cost display (session totals, on-demand Bedrock prices)
const cost = estimateCost(totals.byModel);
let costLabel = `\x1b[38;5;48mcost (estimate):\x1b[0m`;
if (!cost) costLabel += "loading prices…";
else {
  costLabel += `$${cost.usd.toFixed(2)}`;
  if (cost.unpriced.length) costLabel += ` \x1b[90m(excludes ${cost.unpriced.join(", ")})\x1b[0m`;
}

// Build detailed token breakdown display (session totals)
let detailedBreakdown = `\x1b[94mprompt:\x1b[0m${comma(promptTokens)}`;
if (cacheReadTokens > 0) {
  detailedBreakdown += ` \x1b[96mcache-read:\x1b[0m${comma(cacheReadTokens)}`;
}
if (cacheWriteTokens > 0) {
  detailedBreakdown += ` \x1b[35mcache-write:\x1b[0m${comma(cacheWriteTokens)}`;
}
const reasoningLabel = totals.reasoning_estimated > 0 ? "reasoning (estimate)" : "reasoning";
detailedBreakdown += ` \x1b[91m${reasoningLabel}:\x1b[0m${comma(totals.reasoning_tokens)}`;
detailedBreakdown += ` \x1b[32mcompletion:\x1b[0m${comma(outputTokens)}`;

// Build summary breakdown display
const summaryBreakdown = `\x1b[36minput:\x1b[0m${comma(inputTokens)} \x1b[93moutput:\x1b[0m${comma(outputTokens)}`;

// Build tool activity display (session totals)
let toolBreakdown = `\x1b[38;5;208mnum-tool-calls:\x1b[0m${comma(totals.tool_calls)} \x1b[97mnum-tool-responses:\x1b[0m${comma(totals.tool_responses)}`;
toolBreakdown += ` | \x1b[38;5;213mtool-call-tokens (estimate):\x1b[0m${comma(charsToTokens(totals.tool_call_chars))}`;
toolBreakdown += ` \x1b[38;5;180mtool-response-tokens (estimate):\x1b[0m${comma(charsToTokens(totals.tool_response_chars))}`;

console.log(
  `${name} | ${usagePercentLabel} - ${usageCountLabel} | ${costLabel}\n${detailedBreakdown} | ${summaryBreakdown}\n${toolBreakdown}\nsession: ${sessionId}`
);
