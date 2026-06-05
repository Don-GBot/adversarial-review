#!/usr/bin/env node
/**
 * Crossfire v2 — Two-phase post-build audit
 *
 * Phase 1 (Structural): Does the implementation match the spec?
 * Phase 2 (Behavioral): Trace data flows end-to-end, find bugs.
 *
 * Usage:
 *   node crossfire.js --spec <path> --files <path1,path2,...> [--workspace <dir>] [--output <path>]
 *   node crossfire.js --self-audit
 *
 * Calls OpenClaw gateway /v1/chat/completions endpoint.
 * Phase 1 → content agent (Opus). Phase 2 → market agent (Codex). Cross-model by design.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const GATEWAY_PORT = parseInt(process.env.CROSSFIRE_PORT || "18789", 10);
const GATEWAY_TOKEN = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(process.env.HOME, ".openclaw", "openclaw.json"), "utf8"
    ));
    const token = cfg.gateway?.auth?.token;
    if (!token) {
      console.error("⚠️  No gateway.auth.token found in openclaw.json — requests may fail");
    }
    return token || "";
  } catch (e) {
    console.error(`⚠️  Could not read openclaw.json: ${e.message}`);
    return "";
  }
})();

// Cross-model: Opus reviews structure, Codex hunts bugs
const MODEL_PHASE1 = "openclaw";          // content agent (Opus primary)
const MODEL_PHASE2 = "openclaw/market";   // market agent (Codex primary)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readFileSafe(p) {
  if (!fs.existsSync(p)) return { ok: false, error: `File not found: ${p}` };
  try {
    const content = fs.readFileSync(p, "utf8");
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: `Read error: ${e.message}` };
  }
}

function resolveFiles(patterns, workspace) {
  // Resolve the workspace through symlinks so containment is checked against the
  // real directory, not a lexical prefix a symlink could spoof.
  let base = path.resolve(workspace || process.cwd());
  try { base = fs.realpathSync(base); } catch { /* keep lexical base if missing */ }
  const files = [];
  const errors = [];
  for (const pat of patterns) {
    const abs = path.resolve(base, pat);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      // Verify file is inside workspace using the REAL path — a symlink inside
      // the workspace pointing outside it must not be audited as in-workspace.
      let real;
      try { real = fs.realpathSync(abs); } catch { real = abs; }
      if (real !== base && !real.startsWith(base + path.sep)) {
        errors.push(`SKIP: ${pat} resolves outside workspace (${real})`);
        continue;
      }
      files.push(real);
    } else {
      errors.push(`SKIP: ${pat} not found at ${abs}`);
    }
  }
  if (errors.length) {
    console.error("⚠️  File resolution issues:");
    errors.forEach(e => console.error(`   ${e}`));
  }
  // Return errors too so the gate can fail closed on any requested file that
  // could not be resolved (missing / outside-workspace / not-a-file).
  return { files: [...new Set(files)], errors };
}

function addLineNumbers(content, ext) {
  const lines = content.split("\n");
  return lines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join("\n");
}

function getLangTag(filepath) {
  const ext = path.extname(filepath).slice(1);
  const map = { js: "javascript", ts: "typescript", py: "python", md: "markdown", json: "json", yaml: "yaml", yml: "yaml", sh: "bash", sql: "sql" };
  return map[ext] || ext || "text";
}

function parseFilesArg(raw, workspace) {
  const value = String(raw || "");
  const base = path.resolve(workspace || process.cwd());
  if (value.includes(",") && fs.existsSync(path.resolve(base, value))) {
    throw new Error(`--files value is ambiguous because it is also a real comma-containing path: ${value}`);
  }
  return value.split(",").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Verdict — turn audit prose into a blocking gate decision
// ---------------------------------------------------------------------------
// Phase 1 FAIL statuses and Phase 2 CRITICAL/HIGH bugs are blocking.
// Returns { block, p1Fail, p1Warn, p2Critical, p2High, reasons[] }.
// Count structured finding lines of the form:  LABEL: VALUE
// Anchored to line start so negations/examples in prose don't false-trigger
// ("no SEVERITY: HIGH found" starts with "no", not the label), and tolerant of
// list markers and Markdown bold around the label/value
// ("- **SEVERITY:** HIGH"). label/value are plain words (no regex metachars).
function countLabel(text, label, value) {
  // ^ [optional ws] [optional markers: list -/*/•, blockquote >, heading #] [optional ws] [**] LABEL [**] : [**] [ws] [**] VALUE [word-boundary]
  // Value must be terminated by whitespace, Markdown punctuation, or EOL — not
  // by a hyphen/word char, so "HIGH-ISH" or "HIGHLY" does NOT match "HIGH".
  // Markers may stack and repeat ('> - SEVERITY', '## SEVERITY') so a blockquoted
  // or heading-prefixed finding can't slip past the prose fallback (B-1).
  const re = new RegExp(
    `^\\s*(?:(?:[-*\\u2022>]|#{1,6}|\\d+[.)])\\s*)*\\*{0,2}${label}\\*{0,2}\\s*:\\s*\\*{0,2}\\s*${value}(?=\\s|\\*|\\.|,|;|:|\\)|$)`,
    "gim"
  );
  return (String(text || "").match(re) || []).length;
}

// Strip fenced code blocks so labels inside ``` examples / templates don't
// count as real findings (the regex-fallback false-positive case).
function stripFences(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
}

// Read the mandatory machine-readable footer the auditor emits, e.g.
//   CROSSFIRE_VERDICT fail=2 warn=1
//   CROSSFIRE_VERDICT critical=0 high=3
// Returns an object of the parsed keys, or null if absent/not final.
// The footer MUST be the LAST non-empty line: anything after it (e.g. an
// auditor that drifts and emits more findings post-footer) means we can't
// trust the footer, so we return null and force the prose regex fallback.
function parseVerdictLine(text, keys) {
  // Walk raw lines tracking fenced-code state so a footer that lives INSIDE a
  // ``` / ~~~ fence is never accepted (a fenced footer = malformed/untrusted
  // auditor output). We only consider non-fence, non-blank content lines, and
  // require the footer to be the last such REAL line.
  const raw = String(text || "").split("\n");
  let inFence = false;
  const contentLines = []; // { clean }
  for (const line of raw) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; } // fence delimiter
    if (inFence) continue; // ignore everything inside fences
    const clean = line.replace(/[`*\s]+$/g, "").replace(/^[`*\s]+/g, "");
    if (clean.trim() === "") continue;
    contentLines.push(clean);
  }
  if (!contentLines.length) return null;
  const lastLine = contentLines[contentLines.length - 1];
  const m = /^CROSSFIRE_VERDICT\s+(.+)$/i.exec(lastLine);
  if (!m) return null; // footer not the final real line -> fall back to prose regex
  const parts = m[1].trim().split(/\s+/);
  const wanted = new Set(keys);
  const seen = new Set();
  const out = {};
  for (const part of parts) {
    const kv = /^([A-Za-z]+)=(\d+)$/.exec(part);
    if (!kv) return null;
    const key = kv[1].toLowerCase();
    if (!wanted.has(key) || seen.has(key)) return null;
    seen.add(key);
    out[key] = parseInt(kv[2], 10);
  }
  for (const k of keys) {
    if (!seen.has(k)) return null; // incomplete footer -> treat as absent, fall back
  }
  return out;
}

function parseVerdict(phase1Result, phase2Result) {
  const v = { block: false, p1Fail: 0, p1Warn: 0, p2Critical: 0, p2High: 0, reasons: [], source: "footer" };
  const p1 = String(phase1Result || "");
  const p2 = String(phase2Result || "");

  // An auditor error means we could NOT verify — fail closed.
  // Anchor to line start so a quoted marker inside the report body (e.g. an
  // auditor citing the string `/PHASE 1 ERROR:/` as evidence) doesn't trip it.
  if (/^\s*PHASE 1 ERROR:/m.test(p1)) { v.block = true; v.reasons.push("Phase 1 auditor errored (could not verify)"); }
  if (/^\s*PHASE 2 ERROR:/m.test(p2)) { v.block = true; v.reasons.push("Phase 2 auditor errored (could not verify)"); }

  // Defense in depth: use BOTH the machine-readable footer AND prose regex
  // counting (with code fences stripped), then take the MAX. A model arithmetic
  // slip in the footer summary must never suppress a detailed prose finding,
  // and a missing footer must never let a finding through. Mismatches are
  // flagged so the report shows the disagreement.
  const c1 = stripFences(p1);
  const proseP1Fail = countLabel(c1, "STATUS", "FAIL");
  const proseP1Warn = countLabel(c1, "STATUS", "WARN");
  const f1 = parseVerdictLine(p1, ["fail", "warn"]);
  if (!f1) { v.source = "regex"; v.block = true; v.reasons.push("Phase 1 verdict footer missing/non-final — failing closed (auditor response incomplete)"); }
  v.p1Fail = Math.max(f1 ? f1.fail : 0, proseP1Fail);
  v.p1Warn = Math.max(f1 ? f1.warn : 0, proseP1Warn);
  if (f1 && (f1.fail !== proseP1Fail)) v.reasons.push(`Phase 1 footer/prose FAIL mismatch (footer ${f1.fail} vs prose ${proseP1Fail}; used max)`);

  const c2 = stripFences(p2);
  const proseP2Crit = countLabel(c2, "SEVERITY", "CRITICAL");
  const proseP2High = countLabel(c2, "SEVERITY", "HIGH");
  const f2 = parseVerdictLine(p2, ["critical", "high"]);
  if (!f2) { v.source = "regex"; v.block = true; v.reasons.push("Phase 2 verdict footer missing/non-final — failing closed (auditor response incomplete)"); }
  v.p2Critical = Math.max(f2 ? f2.critical : 0, proseP2Crit);
  v.p2High = Math.max(f2 ? f2.high : 0, proseP2High);
  if (f2 && (f2.critical !== proseP2Crit || f2.high !== proseP2High)) v.reasons.push(`Phase 2 footer/prose severity mismatch (footer C${f2.critical}/H${f2.high} vs prose C${proseP2Crit}/H${proseP2High}; used max)`);

  if (v.p1Fail > 0) { v.block = true; v.reasons.push(`${v.p1Fail} Phase 1 FAIL (spec non-compliance)`); }
  if (v.p2Critical > 0) { v.block = true; v.reasons.push(`${v.p2Critical} Phase 2 CRITICAL bug(s)`); }
  if (v.p2High > 0) { v.block = true; v.reasons.push(`${v.p2High} Phase 2 HIGH bug(s)`); }

  return v;
}

function formatVerdict(v) {
  const status = v.block ? "🚫 BLOCK" : "✅ PASS";
  return [
    `**Gate verdict:** ${status}`,
    `**Phase 1:** ${v.p1Fail} FAIL, ${v.p1Warn} WARN`,
    `**Phase 2:** ${v.p2Critical} CRITICAL, ${v.p2High} HIGH`,
    v.reasons.length ? `**Blocking reasons:** ${v.reasons.join("; ")}` : `**Blocking reasons:** none`,
  ].join("\n");
}

function callModel(model, systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 16384,
    });
    const options = {
      hostname: "127.0.0.1",
      port: GATEWAY_PORT,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(GATEWAY_TOKEN ? { "Authorization": `Bearer ${GATEWAY_TOKEN}` } : {}),
      },
      timeout: 300000,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(`Auth failed (${res.statusCode}). Check gateway.auth.token.`));
        }
        if (res.statusCode === 404) {
          return reject(new Error(`Endpoint 404. Enable: gateway.http.endpoints.chatCompletions.enabled=true`));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Gateway ${res.statusCode}: ${data.slice(0, 500)}`));
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content;
          if (!content || content.length < 20) {
            return reject(new Error(`Empty or malformed response from gateway. Raw: ${data.slice(0, 300)}`));
          }
          resolve(content);
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}. Raw: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on("error", (e) => {
      if (e.code === "ECONNREFUSED") {
        reject(new Error(`Gateway not reachable at 127.0.0.1:${GATEWAY_PORT}. Is it running?`));
      } else {
        reject(e);
      }
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Gateway timeout (300s)")); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const PHASE1_SYSTEM = `You are a meticulous code auditor performing a STRUCTURAL review.

Your job: verify the implementation matches the spec. Check every acceptance criterion, config key, function signature, data structure, default value, and edge case mentioned in the spec.

For each check, report:
- CHECK ID (S-1, S-2, ...)
- WHAT: what the spec requires
- STATUS: PASS | FAIL | WARN
- EVIDENCE: exact code line number and value that proves it
- FIX (if FAIL/WARN): what needs to change

REQUIRED SECTIONS (even if empty):
1. Config/defaults compliance
2. Function signatures and types
3. Data structures and schemas
4. Error handling specified in spec
5. Edge cases explicitly mentioned in spec
6. Spec omissions that create unsafe or ambiguous behavior

For each section, if no issues found, state: "No issues found in this section."

Provide a concrete test input or scenario for each FAIL finding.

End with: total checks, pass/fail/warn counts, coverage confidence (high/medium/low with rationale).

MANDATORY FINAL LINE — emit exactly one machine-readable verdict line as the
LAST line of your response, with no surrounding code fences or markdown:
CROSSFIRE_VERDICT fail=<N> warn=<N>
where <N> are the total counts of FAIL and WARN checks. This line is parsed by
tooling — do not add commentary on it or wrap it in backticks.`;

const PHASE2_SYSTEM = `You are an expert bug hunter performing a BEHAVIORAL code audit.

Your job is NOT to check if code matches a spec. Your job is to find bugs that produce WRONG RESULTS silently.

For each bug found, provide:
- BUG ID (B-1, B-2, ...)
- SEVERITY: CRITICAL | HIGH | MEDIUM | LOW
- FILE:LINE (use the line numbers provided in the source)
- WHAT: describe the wrong behavior
- CONCRETE EXAMPLE: a specific input that triggers the bug and what wrong output it produces
- TRACE: show the data flow step by step
- IMPACT: what goes wrong in production
- FIX: specific code change

MANDATORY SECTIONS (report on ALL, even if clean):

1. UNIT MISMATCHES — temperatures (°F vs °C), timestamps (UTC vs local), prices, currencies, sizes
2. DATA FLOW TRACING — pick each input value, trace through every function, verify type/unit/format at each boundary
3. BOUNDARY CONDITIONS — exactly 0, exactly threshold, empty lists, None/null, first iteration vs steady state
4. SILENT FAILURES — try/except swallowing errors, defaults masking missing data, fallbacks changing semantics
5. STATE LEAKS — mutable state shared across iterations/variants/runs that should be isolated
6. OFF-BY-ONE — loop boundaries, time windows, >= vs >, array indexing
7. RACE CONDITIONS — concurrent modification of shared state, ordering assumptions
8. EXTERNAL INTERFACES — env/config dependencies, API assumptions, missing files
9. UNEXECUTED PATHS — dead code, unreachable branches, config-driven paths that are never actually taken

For each section with no bugs found, explicitly state: "Section clean. Reasoning: [why]."

If you cannot fully trace a data flow because files are missing, say: "INCOMPLETE: need [file/function] to verify [what]."

Be adversarial in your SEARCH. Be calibrated in your SEVERITY. Hunt hard for
bugs, but do not inflate severity to manufacture a blocking finding.

SEVERITY RUBRIC (apply strictly — only CRITICAL/HIGH block the gate):
- CRITICAL: wrong output / data loss / corruption on NORMAL, expected inputs that
  occur in routine use. No attacker, no malformed input, no exotic environment
  required. A typical run hits it.
- HIGH: wrong output on REALISTIC inputs a non-malicious caller would actually
  produce (a plausible edge value, an ordinary empty/null, a documented config),
  reachable on a path that real usage takes.
- MEDIUM: requires an unusual-but-possible condition — adversarial/malformed
  input, a hostile local actor with write access, a race window, a deliberately
  mis-set env var, or truncated/garbage upstream output. Real but not on the
  normal path. Hardening, not a blocker.
- LOW: cosmetic, defense-in-depth, or theoretical with no realistic trigger.

HARD RULES for CRITICAL/HIGH — a finding may ONLY be CRITICAL or HIGH if ALL hold:
1. The trigger is an input or state a NORMAL caller produces without malice.
2. It is reachable on a code path that ordinary usage executes.
3. It produces a concretely wrong result (not just "could be hardened").
If any of these fails, it is AT MOST MEDIUM. In particular:
- "An attacker who can write the repo/swap a symlink..." => MEDIUM or LOW.
- "If an env var / config WE control is set wrong..." => MEDIUM or LOW.
- "If the model/upstream emits malformed/truncated output..." => MEDIUM or LOW
  (and note it already fails closed, if it does).
- "Defense-in-depth / belt-and-suspenders" => LOW.
When genuinely unsure between two levels, pick the LOWER. A clean gate on solid
code is the correct outcome; do not invent a HIGH to look thorough.

MANDATORY FINAL LINE — emit exactly one machine-readable verdict line as the
LAST line of your response, with no surrounding code fences or markdown:
CROSSFIRE_VERDICT critical=<N> high=<N>
where <N> are the total counts of CRITICAL and HIGH severity bugs. This line is
parsed by tooling — do not add commentary on it or wrap it in backticks.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  // Self-audit mode
  if (args.includes("--self-audit")) {
    console.log("🔄 Crossfire v2 self-audit mode\n");
    const selfRead = readFileSafe(__filename);
    if (!selfRead.ok) { console.error(selfRead.error); process.exit(1); }

    const numbered = addLineNumbers(selfRead.content, "js");
    const selfAuditPrompt = `Audit the following crossfire audit tool. Find bugs, prompt engineering flaws, missing features, failure modes, and security issues.

This tool performs two-phase post-build code auditing:
- Phase 1: structural (spec compliance) via Opus
- Phase 2: behavioral (bug hunting via data flow tracing) via Codex

Source code (with line numbers):
\`\`\`javascript
${numbered}
\`\`\``;

    console.log(`Calling ${MODEL_PHASE2} for self-audit...`);
    const result = await callModel(MODEL_PHASE2, PHASE2_SYSTEM, selfAuditPrompt);
    console.log(result);

    const outPath = path.join(process.cwd(), "data", "crossfire-v2-self-audit.md");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `# Crossfire v2 Self-Audit\n**Date:** ${new Date().toISOString()}\n**Model:** ${MODEL_PHASE2}\n\n${result}`);
    console.log(`\n✅ Saved to ${outPath}`);
    return;
  }

  // Parse args
  let specPath = null, filesArg = null, filePaths = [], workspace = null, outputPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--spec" && args[i + 1]) specPath = args[++i];
    else if (args[i] === "--files" && args[i + 1]) filesArg = args[++i];
    else if (args[i] === "--workspace" && args[i + 1]) workspace = args[++i];
    else if (args[i] === "--output" && args[i + 1]) outputPath = args[++i];
  }
  if (filesArg !== null) {
    try {
      filePaths = parseFilesArg(filesArg, workspace);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
  }

  if (!filePaths.length) {
    console.error("Usage: node crossfire.js --spec <path> --files <path1,path2,...> [--workspace <dir>] [--output <path>]");
    console.error("       node crossfire.js --self-audit");
    process.exit(1);
  }

  let base = path.resolve(workspace || process.cwd());
  try { base = fs.realpathSync(base); } catch { /* keep lexical base if missing */ }

  // Resolve and read files
  const { files: resolved, errors: resolutionErrors } = resolveFiles(filePaths, workspace);
  if (!resolved.length) {
    console.error("❌ No valid files found. Aborting.");
    process.exit(1);
  }

  console.log(`📂 ${resolved.length} source files loaded`);

  const sourceChunks = [];
  const skippedFiles = [];
  let totalLines = 0;

  for (const f of resolved) {
    const rel = path.relative(base, f);
    const read = readFileSafe(f);
    if (!read.ok) {
      skippedFiles.push({ file: rel, reason: read.error });
      console.error(`   ❌ ${rel}: ${read.error}`);
      continue;
    }
    const lang = getLangTag(f);
    const numbered = addLineNumbers(read.content, lang);
    const lines = read.content.split("\n").length;
    totalLines += lines;
    sourceChunks.push(`### ${rel} (${lines} lines)\n\`\`\`${lang}\n${numbered}\n\`\`\``);
    console.log(`   ✅ ${rel} (${lines} lines)`);
  }

  if (!sourceChunks.length) {
    console.error("❌ All files unreadable. Aborting.");
    process.exit(1);
  }

  const sourceBundle = sourceChunks.join("\n\n");
  console.log(`📊 Total: ${totalLines} lines across ${sourceChunks.length} files`);

  if (skippedFiles.length) {
    console.warn(`⚠️  ${skippedFiles.length} file(s) skipped (unreadable)`);
  }

  // Read spec
  let specContent = null;
  if (specPath) {
    const specAbs = path.resolve(base, specPath);
    // Symlink-safe containment, matching source-file handling.
    let specReal = specAbs;
    try { specReal = fs.realpathSync(specAbs); } catch { /* missing -> readFileSafe reports */ }
    if (specReal !== base && !specReal.startsWith(base + path.sep)) {
      console.error(`❌ --spec resolves outside workspace (${specReal}). Aborting.`);
      process.exit(1);
    }
    const specRead = readFileSafe(specReal);
    if (!specRead.ok) {
      console.error(`❌ --spec provided but unreadable: ${specRead.error}`);
      process.exit(1);
    }
    specContent = specRead.content;
    console.log(`📋 Spec loaded: ${specPath}`);
  }

  // Phase 1: Structural (Opus)
  let phase1Result = null;
  if (specContent) {
    console.log(`\n🔍 Phase 1: Structural audit (${MODEL_PHASE1})...`);
    const phase1Prompt = `## Spec\n${specContent}\n\n## Source Files\n${sourceBundle}`;
    try {
      phase1Result = await callModel(MODEL_PHASE1, PHASE1_SYSTEM, phase1Prompt);
      console.log("   ✅ Phase 1 complete.");
    } catch (e) {
      phase1Result = `PHASE 1 ERROR: ${e.message}`;
      console.error(`   ❌ Phase 1 failed: ${e.message}`);
    }
  } else {
    phase1Result = "SKIPPED (no --spec provided)\nCROSSFIRE_VERDICT fail=0 warn=0";
    console.log("\n⚠️  No --spec provided, skipping Phase 1 (structural)");
  }

  // Save Phase 1 incrementally
  const partialPath = (outputPath || path.join(base, "data", `crossfire-v2-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`));
  fs.mkdirSync(path.dirname(partialPath), { recursive: true });
  fs.writeFileSync(partialPath, `# Crossfire v2 Audit Report (Phase 1 complete, Phase 2 pending)\n\n## Phase 1\n${phase1Result}\n`);

  // Phase 2: Behavioral (Codex)
  console.log(`\n🐛 Phase 2: Behavioral audit (${MODEL_PHASE2})...`);
  // Source first, spec last (to avoid anchoring on compliance)
  const phase2Prompt = `## Source Files (audit these for bugs)\n${sourceBundle}\n\n${specContent ? `## Spec (for domain context only — do NOT score compliance)\n${specContent}` : ""}`;
  let phase2Result;
  try {
    phase2Result = await callModel(MODEL_PHASE2, PHASE2_SYSTEM, phase2Prompt);
    console.log("   ✅ Phase 2 complete.");
  } catch (e) {
    phase2Result = `PHASE 2 ERROR: ${e.message}`;
    console.error(`   ❌ Phase 2 failed: ${e.message}`);
  }

  // Verdict — the gate decision
  const verdict = parseVerdict(phase1Result, phase2Result);

  // Fail closed if any requested file could not be audited: a PASS must mean
  // "all requested files were audited and clean," never "the readable subset."
  // Covers both post-resolution read failures AND files that never resolved
  // (missing / outside-workspace / not-a-file).
  if (skippedFiles.length > 0) {
    verdict.block = true;
    verdict.reasons.push(`${skippedFiles.length} requested file(s) unaudited: ${skippedFiles.map(s => s.file).join(", ")}`);
  }
  if (resolutionErrors && resolutionErrors.length > 0) {
    verdict.block = true;
    verdict.reasons.push(`${resolutionErrors.length} requested file(s) failed resolution: ${resolutionErrors.join("; ")}`);
  }

  // Combine report
  const report = `# Crossfire v2 Audit Report
**Date:** ${new Date().toISOString()}
**Spec:** ${specPath || "none"}
**Files audited:** ${sourceChunks.length}
**Files skipped:** ${skippedFiles.length}${skippedFiles.length ? " — " + skippedFiles.map(s => s.file).join(", ") : ""}
**Total lines:** ${totalLines}
**Phase 1 Model:** ${specContent ? MODEL_PHASE1 : "skipped"}
**Phase 2 Model:** ${MODEL_PHASE2}

---

## Gate Verdict

${formatVerdict(verdict)}

---

## Phase 1 — Structural (Spec Compliance)

${phase1Result}

---

## Phase 2 — Behavioral (Bug Hunting)

${phase2Result}
`;

  // Write final
  fs.writeFileSync(partialPath, report);
  console.log(`\n✅ Report saved to ${partialPath}`);

  // Emit verdict to stdout and set exit code so callers (hooks/CI) can gate.
  console.log("\n" + formatVerdict(verdict).replace(/\*\*/g, ""));
  if (verdict.block) {
    console.error(`\n🚫 Crossfire BLOCK — ${verdict.reasons.join("; ")}`);
    console.error(`   Review: ${partialPath}`);
    process.exit(2);
  }
  console.log("\n✅ Crossfire PASS — no blocking findings.");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
