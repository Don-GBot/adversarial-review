#!/usr/bin/env node
/**
 * Crossfire autonomous loop — headless audit → fix → re-audit.
 *
 * No agent in the chair. crossfire.js runs the cross-model audit; a dedicated
 * FIXER model call (separate role) returns SEARCH/REPLACE edit blocks that this
 * script applies, syntax-checks, and re-audits. No hard round cap — the loop
 * STOPS and escalates to Telegram on stall (no progress / repeat finding /
 * unappliable or syntax-breaking fix).
 *
 * Usage:
 *   node scripts/crossfire-loop.js --spec <path> --files a.js,b.js [--workspace dir] [--chat <id>] [--no-escalate]
 *
 * Telegram escalation is optional: set CROSSFIRE_TG_SCRIPT to a sender script
 * and pass --chat (or CROSSFIRE_CHAT). Without it, the loop is console-only.
 *
 * Exit codes: 0 converged (PASS), 3 stalled+escalated, 1 fatal error.
 *
 * Designed to run detached under ops-guard:
 *   node scripts/ops-guard.js --label crossfire-loop --detach -- \
 *     node scripts/crossfire-loop.js --spec tasks/x.md --files a.js,b.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

// ROOT = repo under audit (cwd, or CROSSFIRE_ROOT). Run artifacts land in its
// data/ dir, not the skill dir. Sibling scripts resolved via __dirname below.
const ROOT = process.env.CROSSFIRE_ROOT ? path.resolve(process.env.CROSSFIRE_ROOT) : process.cwd();
const CROSSFIRE_JS = path.join(__dirname, "crossfire.js");
// Optional Telegram escalation. Standalone the skill has no messenger, so this
// stays console-only unless the host points CROSSFIRE_TG_SCRIPT at a sender
// (clawd sets it to scripts/tg-send.js). Keeps the skill publishable + portable.
const TG_SCRIPT = process.env.CROSSFIRE_TG_SCRIPT || "";
const GATEWAY_PORT = parseInt(process.env.CROSSFIRE_PORT || "18789", 10);
const GATEWAY_TOKEN = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".openclaw", "openclaw.json"), "utf8"));
    return cfg.gateway?.auth?.token || "";
  } catch { return ""; }
})();

// Alternating fixers: round 1 = Codex, round 2 = Opus, round 3 = Codex, ...
// Why alternate (not just variety): a single fixer that fails to satisfy the
// auditor tends to retry the SAME approach -> fix-thrash/stall. Swapping models
// attacks a stuck finding from a different angle, a built-in stall-breaker.
// Each fixer call is a stateless gateway request — it sees ONLY the findings +
// current source, never the auditors' context, so fixers stay uncluttered.
const DEFAULT_FIXER_MODELS = ["openclaw/market", "openclaw"]; // Codex first, then Opus
const FIXER_MODELS = (process.env.CROSSFIRE_FIXER_MODELS
  ? process.env.CROSSFIRE_FIXER_MODELS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_FIXER_MODELS);
const FIXER_LABEL = { "openclaw/market": "Codex", "openclaw": "Opus" };
function fixerForRound(round, models = FIXER_MODELS) { return models[(round - 1) % models.length]; }
function fixerLabel(m) { return FIXER_LABEL[m] || m; }

function hasNonSourceBlockingReason(reasons) {
  return /verdict footer missing\/non-final|auditor errored|requested file\(s\) unaudited|requested file\(s\) failed resolution/i.test(reasons || "");
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseFilesArg(raw, workspace) {
  const value = String(raw || "");
  if (value.includes(",") && fs.existsSync(path.resolve(workspace, value))) {
    throw new Error(`--files value is ambiguous because it is also a real comma-containing path: ${value}`);
  }
  return value.split(",").filter(Boolean);
}

function parseArgs(argv) {
  const o = { spec: null, files: [], workspace: ROOT, chat: process.env.CROSSFIRE_CHAT || "", escalate: true, fixerModels: FIXER_MODELS.length ? FIXER_MODELS : DEFAULT_FIXER_MODELS };
  let filesArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") o.spec = argv[++i];
    else if (a === "--files") filesArg = argv[++i] || "";
    else if (a === "--workspace") o.workspace = path.resolve(ROOT, argv[++i]);
    else if (a === "--chat") o.chat = argv[++i];
    else if (a === "--no-escalate") o.escalate = false;
    else if (a === "--fixer-model") {
      const m = argv[++i];
      if (m && m.trim()) o.fixerModels = [m.trim()];
    }
  }
  if (filesArg !== null) o.files = parseFilesArg(filesArg, o.workspace);
  return o;
}

function log(msg) { console.log(`[crossfire-loop] ${msg}`); }

function realpathContained(target, workspace) {
  const workspaceReal = fs.realpathSync(workspace);
  const targetReal = fs.realpathSync(target);
  return {
    workspaceReal,
    targetReal,
    contained: targetReal === workspaceReal || targetReal.startsWith(workspaceReal + path.sep),
  };
}

// Escalation/progress sink. Always logs to console. If the host provided a
// messenger via CROSSFIRE_TG_SCRIPT, also send there; otherwise console-only so
// the skill runs standalone without any clawd dependency.
function tg(chat, text) {
  console.log(`[crossfire-loop:notify] ${text.replace(/\n/g, " | ")}`);
  if (!chat || !TG_SCRIPT) return;
  try {
    const r = spawnSync(process.execPath, [TG_SCRIPT, chat, "--stdin"],
      { input: text, encoding: "utf8" });
    if (r.status !== 0) console.error(`[crossfire-loop] tg send failed: ${r.stderr || r.stdout}`);
  } catch (e) { console.error(`[crossfire-loop] tg threw: ${e.message}`); }
}

// ---------------------------------------------------------------------------
// Gateway call (fixer) — single attempt
// ---------------------------------------------------------------------------
function callModelOnce(model, system, user) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages: [
      { role: "system", content: system }, { role: "user", content: user },
    ], max_tokens: 16384 });
    const req = http.request({
      hostname: "127.0.0.1", port: GATEWAY_PORT, path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}) },
      timeout: 300000,
    }, (res) => {
      let data = ""; res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          const err = new Error(`Gateway ${res.statusCode}: ${data.slice(0, 300)}`);
          // 5xx and 429 are transient (retryable); 4xx (except 429) are not.
          err.retryable = res.statusCode >= 500 || res.statusCode === 429;
          return reject(err);
        }
        try {
          const j = JSON.parse(data);
          const content = j.choices?.[0]?.message?.content;
          if (!content || content.length < 10) return reject(new Error("Empty fixer response"));
          resolve(content);
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on("error", (e) => {
      // Transient network faults: broken pipe, reset, refused, DNS, hang-up.
      const transient = ["EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"];
      e.retryable = transient.includes(e.code) || /socket hang up/i.test(e.message || "");
      reject(e);
    });
    req.on("timeout", () => {
      req.destroy();
      const e = new Error("Fixer timeout (300s)");
      e.retryable = true;
      reject(e);
    });
    req.on("error", () => {}); // guard against post-destroy 'error' re-throw
    req.write(body); req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retrying wrapper: transient failures (EPIPE/ECONNRESET/timeout/5xx/429) get
// exponential backoff; genuine errors (parse, empty, 4xx) fail fast. This is
// what stops a single broken pipe from killing a multi-round autonomous run.
async function callModel(model, system, user, { retries = 4, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await callModelOnce(model, system, user);
    } catch (e) {
      lastErr = e;
      if (!e.retryable || attempt === retries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt); // 2s, 4s, 8s, 16s
      console.error(`[crossfire-loop] gateway call ${model} failed (${e.code || e.message}) — retry ${attempt + 1}/${retries} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Crossfire run -> verdict
// ---------------------------------------------------------------------------
function runCrossfire(opts, outPath) {
  const args = [CROSSFIRE_JS, "--files", opts.files.join(","), "--output", outPath];
  if (opts.spec) args.push("--spec", opts.spec);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  // 32MB buffer so a large audit report can't ENOBUFS into a null-status "block"
  // with empty findings (which would feed the fixer garbage). Surface r.error.
  const r = spawnSync("node", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  // crossfire exit: 0 pass, 2 block, 1 error
  const report = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
  return { status: r.status, error: r.error, stdout: r.stdout || "", stderr: r.stderr || "", report };
}

// Pull the blocking-reasons line + counts from crossfire stdout for stall tracking.
function summarizeVerdict(stdout) {
  const blockCount = (s, re) => { const m = s.match(re); return m ? parseInt(m[1], 10) : 0; };
  const p2c = blockCount(stdout, /(\d+)\s+CRITICAL/);
  const p2h = blockCount(stdout, /CRITICAL,\s*(\d+)\s+HIGH/);
  const p1f = blockCount(stdout, /Phase 1:\s*(\d+)\s+FAIL/);
  const reasons = (stdout.match(/Blocking reasons:\s*(.+)/) || [, ""])[1].trim();
  return { p1f, p2c, p2h, total: p1f + p2c + p2h, reasons };
}

// ---------------------------------------------------------------------------
// Fixer
// ---------------------------------------------------------------------------
const FIXER_SYSTEM = `You are a precise code-fixing agent. You receive an audit report listing blocking issues (Phase 1 spec FAILs, Phase 2 CRITICAL/HIGH bugs) and the current source files with line numbers.

Apply the MINIMAL changes that resolve every blocking issue. Do not refactor unrelated code. Do not add features.

Output ONLY edit blocks in this exact format, one per change:

<<<<<<< FILE: relative/path.js
=======SEARCH
<exact existing lines to find, copied verbatim WITHOUT line-number prefixes>
=======REPLACE
<replacement lines>
>>>>>>> END

Rules:
- SEARCH text must match the current file byte-for-byte (excluding the "NNNN | " line-number prefix shown to you). Include enough surrounding context to be unique.
- Keep each edit small and targeted.
- If a fix needs a new function, place its edit block at a sensible existing anchor.
- Emit nothing outside edit blocks — no prose, no explanations, no markdown fences.`;

// Parse edit blocks. Returns [{file, search, replace}].
function parseEditBlocks(text) {
  const blocks = [];
  const re = /<<<<<<< FILE:\s*(.+?)\n=======SEARCH\n([\s\S]*?)\n=======REPLACE\n([\s\S]*?)\n>>>>>>> END/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ file: m[1].trim(), search: m[2], replace: m[3] });
  }
  return blocks;
}

// Apply blocks atomically: validate all match first, then write. Returns
// { ok, applied, failed:[{file,reason}], changedFiles:Set }.
// allowReal: optional Set of audited realpaths. When provided, the fixer may
// ONLY edit those files — never the spec, manifest, audit reports, or other
// unaudited files (prevents the fixer from weakening the oracle to fake a pass).
function applyEditBlocks(blocks, workspace, allowReal) {
  const planned = []; // {abs, before, after}
  const failed = [];
  const cache = new Map(); // abs -> current content (chained edits)

  for (const b of blocks) {
    const abs = path.resolve(workspace, b.file);
    if (!fs.existsSync(abs)) { failed.push({ file: b.file, reason: "file not found" }); continue; }
    let checked;
    try {
      checked = realpathContained(abs, workspace);
    } catch (e) {
      failed.push({ file: b.file, reason: `realpath failed: ${e.message}` }); continue;
    }
    if (!checked.contained) {
      failed.push({ file: b.file, reason: "outside workspace" }); continue;
    }
    const realAbs = checked.targetReal;
    if (allowReal && !allowReal.has(realAbs)) {
      failed.push({ file: b.file, reason: "not in audited file set (fixer may only edit audited sources)" }); continue;
    }
    if (!cache.has(realAbs)) {
      cache.set(realAbs, fs.readFileSync(realAbs, "utf8"));
    }
    const cur = cache.get(realAbs);
    const idx = cur.indexOf(b.search);
    if (idx === -1) { failed.push({ file: b.file, reason: "SEARCH text not found" }); continue; }
    if (cur.indexOf(b.search, idx + 1) !== -1) { failed.push({ file: b.file, reason: "SEARCH text not unique" }); continue; }
    cache.set(realAbs, cur.slice(0, idx) + b.replace + cur.slice(idx + b.search.length));
  }

  if (failed.length) return { ok: false, applied: 0, failed, changedFiles: new Set() };

  // Backup, write, syntax-check; revert all on any failure.
  const backups = new Map();
  const changedFiles = new Set();
  for (const [abs, content] of cache) {
    backups.set(abs, fs.readFileSync(abs, "utf8"));
    fs.writeFileSync(abs, content);
    changedFiles.add(abs);
  }
  // Syntax-check JS files.
  for (const abs of changedFiles) {
    if (abs.endsWith(".js")) {
      const r = spawnSync("node", ["-c", abs], { encoding: "utf8" });
      if (r.status !== 0) {
        for (const [a, c] of backups) fs.writeFileSync(a, c); // revert ALL
        return { ok: false, applied: 0, failed: [{ file: path.relative(workspace, abs), reason: `syntax error after edit: ${(r.stderr || "").split("\n")[0]}` }], changedFiles: new Set() };
      }
    }
  }
  return { ok: true, applied: cache.size, failed: [], changedFiles };
}

// Build line-numbered source bundle for the fixer.
function bundleSource(files, workspace) {
  return files.map((rel) => {
    const abs = path.resolve(workspace, rel);
    if (!fs.existsSync(abs)) throw new Error(`file not found: ${rel}`);
    const checked = realpathContained(abs, workspace);
    if (!checked.contained) throw new Error(`file resolves outside workspace: ${rel}`);
    const content = fs.readFileSync(checked.targetReal, "utf8");
    const numbered = content.split("\n").map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
    return `### ${rel}\n\`\`\`\n${numbered}\n\`\`\``;
  }).join("\n\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.files.length) { console.error("--files required"); process.exit(1); }

  // Reject a --workspace outside ROOT: the loop must never audit/edit a tree
  // outside the repo while writing run artifacts under it. Mirrors the gate
  // wrapper's workspace containment guard.
  try {
    const wsCheck = realpathContained(opts.workspace, ROOT);
    if (!wsCheck.contained) {
      console.error(`[crossfire-loop] --workspace (${wsCheck.targetReal}) is outside ROOT (${wsCheck.workspaceReal}) — refusing.`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[crossfire-loop] --workspace realpath check failed: ${e.message} — refusing.`);
    process.exit(1);
  }

  // Allowlist of audited files (realpaths). The fixer may edit ONLY these —
  // never the spec, manifest, or audit reports. Closes the "fixer weakens the
  // oracle to fake a pass" hole.
  const auditedReal = new Set();
  for (const rel of opts.files) {
    const abs = path.resolve(opts.workspace, rel);
    try {
      const c = realpathContained(abs, opts.workspace);
      if (c.contained) auditedReal.add(c.targetReal);
    } catch { /* missing files surface later in bundleSource */ }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(ROOT, "data", "crossfire-loop", stamp);
  fs.mkdirSync(runDir, { recursive: true });
  log(`Run dir: ${runDir}`);
  tg(opts.chat, `🔁 Crossfire loop started\nFiles: ${opts.files.join(", ")}\nSpec: ${opts.spec || "none"}\nFixers alternate: ${opts.fixerModels.map(fixerLabel).join(" → ")}\nNo hard cap; will escalate on stall.`);

  let round = 0;
  let prevTotal = Infinity;
  let prevReasons = "";
  let noProgressStreak = 0;
  let bestTotal = Infinity;
  let roundsSinceBest = 0;

  while (true) {
    round++;
    const reportPath = path.join(runDir, `round-${round}-audit.md`);
    log(`Round ${round}: auditing...`);
    const cf = runCrossfire(opts, reportPath);

    // Spawn-level failure (ENOBUFS, could-not-launch) or any status outside the
    // known 0/1/2 set => infrastructure failure, NOT a clean/block verdict.
    // Fail closed so we never feed the fixer empty/truncated findings.
    if (cf.error || (cf.status !== 0 && cf.status !== 1 && cf.status !== 2)) {
      const detail = cf.error ? `${cf.error.code || ""} ${cf.error.message}` : `unexpected exit status ${cf.status}`;
      const msg = `❌ Crossfire loop: auditor spawn failed round ${round} (${detail}). Stopping.`;
      log(msg); tg(opts.chat, msg); process.exit(1);
    }

    if (cf.status === 1) {
      const msg = `❌ Crossfire loop: auditor tooling errored round ${round}. Stopping.\n${cf.stderr.slice(0, 400)}`;
      log(msg); tg(opts.chat, msg); process.exit(1);
    }

    const v = summarizeVerdict(cf.stdout);
    log(`Round ${round} verdict: ${cf.status === 0 ? "PASS" : "BLOCK"} | P1 FAIL=${v.p1f} P2 CRIT=${v.p2c} HIGH=${v.p2h}`);

    if (cf.status === 0) {
      const msg = `✅ Crossfire loop CONVERGED after ${round} round(s).\nFiles: ${opts.files.join(", ")}\nReport: ${reportPath}`;
      log(msg); tg(opts.chat, msg); process.exit(0);
    }

    // --- Stall detection (before attempting another fix) ---
    if (hasNonSourceBlockingReason(v.reasons) || v.total === 0) {
      const msg = `🚧 Crossfire loop STALLED (non-source/tooling block) at round ${round}.\nRemaining: P1 FAIL=${v.p1f} P2 CRIT=${v.p2c} HIGH=${v.p2h}\nReasons: ${v.reasons}\nReport: ${reportPath}\n\nNeeds a human call.`;
      log(msg); if (opts.escalate) tg(opts.chat, msg); process.exit(3);
    }
    if (v.total < bestTotal) { bestTotal = v.total; roundsSinceBest = 0; } else { roundsSinceBest++; }
    if (v.total >= prevTotal) noProgressStreak++; else noProgressStreak = 0;
    const repeatFinding = round > 1 && v.reasons === prevReasons && v.reasons !== "";

    if (noProgressStreak >= 2 || repeatFinding || roundsSinceBest >= 4) {
      const why = repeatFinding ? "identical blocking reasons two rounds running" : (roundsSinceBest >= 4 ? "no net reduction in blocking count for 4 rounds" : `no reduction in blocking count for ${noProgressStreak} rounds`);
      const msg = `🚧 Crossfire loop STALLED (${why}) at round ${round}.\nRemaining: P1 FAIL=${v.p1f} P2 CRIT=${v.p2c} HIGH=${v.p2h}\nReasons: ${v.reasons}\nReport: ${reportPath}\n\nNeeds a human call.`;
      log(msg); if (opts.escalate) tg(opts.chat, msg); process.exit(3);
    }
    prevTotal = v.total; prevReasons = v.reasons;

    // --- Fixer (alternating model per round) ---
    const fixerModel = fixerForRound(round, opts.fixerModels);
    const fixerName = fixerLabel(fixerModel);
    log(`Round ${round}: requesting fixes from ${fixerName} (${fixerModel})...`);
    const findings = extractFindings(cf.report);
    const fixerPrompt = `## Audit findings (resolve all blocking issues)\n${findings}\n\n## Current source files\n${bundleSource(opts.files, opts.workspace)}`;
    let fixerOut;
    try {
      fixerOut = await callModel(fixerModel, FIXER_SYSTEM, fixerPrompt);
    } catch (e) {
      const msg = `❌ Crossfire loop: fixer call failed round ${round}: ${e.message}. Stopping.`;
      log(msg); tg(opts.chat, msg); process.exit(1);
    }
    fs.writeFileSync(path.join(runDir, `round-${round}-fix.txt`), fixerOut);

    const blocks = parseEditBlocks(fixerOut);
    if (!blocks.length) {
      const msg = `🚧 Crossfire loop STALLED: fixer returned no usable edit blocks at round ${round}.\nReport: ${reportPath}`;
      log(msg); if (opts.escalate) tg(opts.chat, msg); process.exit(3);
    }

    const res = applyEditBlocks(blocks, opts.workspace, auditedReal);
    if (!res.ok) {
      const detail = res.failed.map((f) => `${f.file}: ${f.reason}`).join("; ");
      const msg = `🚧 Crossfire loop STALLED: could not apply fixes at round ${round} (${detail}).\nReport: ${reportPath}`;
      log(msg); if (opts.escalate) tg(opts.chat, msg); process.exit(3);
    }
    log(`Round ${round}: ${fixerName} applied ${res.applied} file edit(s): ${[...res.changedFiles].map((f) => path.relative(opts.workspace, f)).join(", ")}`);
    tg(opts.chat, `🔧 Round ${round}: ${fixerName} fixed ${res.applied} file(s), re-auditing. (was P1=${v.p1f} CRIT=${v.p2c} HIGH=${v.p2h})`);
  }
}

// Extract just the Phase 1/2 finding bodies from the report (keeps prompt lean).
function extractFindings(report) {
  const i = report.indexOf("## Phase 1");
  return i === -1 ? report : report.slice(i);
}

main().catch((e) => { console.error(`[crossfire-loop] fatal: ${e.message}`); process.exit(1); });
