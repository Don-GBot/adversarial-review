# Spec: cross-model-review CODE mode (crossfire) — merged skill v2.2

## Goal
A two-phase, cross-model CODE audit that is a blocking gate which cannot be
silently skipped, plus an autonomous audit→fix→re-audit loop. All three scripts
must be self-contained and decoupled from any host repo so the skill is publishable.

## crossfire.js — auditor + verdict
- S-1: `parseVerdict(phase1Result, phase2Result)` returns an object with fields
  `block` (bool), `p1Fail`, `p1Warn`, `p2Critical`, `p2High` (ints), `reasons` (string[]).
- S-2: Verdict prefers a machine-readable footer line `CROSSFIRE_VERDICT fail=<N> warn=<N>`
  (Phase 1) / `CROSSFIRE_VERDICT critical=<N> high=<N>` (Phase 2), and ALSO counts
  structured prose lines, taking the MAX of footer and prose for each count
  (defense in depth: a footer arithmetic slip must not suppress a prose finding).
- S-3: A missing/non-final footer must fail closed (treated as block-worthy), not silently pass.
- S-4: Findings inside fenced code blocks (``` or ~~~) must NOT be counted as real findings.
- S-5: Verdict `block` is true if any of: p1Fail>0, p2Critical>0, p2High>0, a missing footer,
  an auditor error marker (`PHASE 1 ERROR:` / `PHASE 2 ERROR:` at line start), or any
  unaudited/unresolved requested file. Fail closed on all of these.
- S-6: WARN and LOW severity alone do NOT block.
- S-7: Final report includes a `## Gate Verdict` section.
- S-8: Exit codes: 0 PASS, 2 BLOCK, 1 tool/usage error. On block, print reasons + report path to stderr.
- S-9: Matching is case-insensitive and whitespace/markdown-prefix tolerant; value boundaries
  must be respected (e.g. "HIGH" must not match "HIGHLY"/"HIGH-ISH").
- S-10: File and --spec paths must be contained within the workspace using realpath
  (symlink-safe); paths resolving outside the workspace are rejected/skipped.

## crossfire-gate.js — pre-push wrapper
- G-1: ROOT = the audited repo (process.cwd(), or CROSSFIRE_ROOT if set), NOT the skill dir.
- G-2: The sibling auditor crossfire.js is resolved via __dirname so it works from any cwd.
- G-3: Reads manifest at <ROOT>/data/crossfire-manifest.json (override via CROSSFIRE_MANIFEST).
- G-4: No default manifest -> exit 0 (do not block unrelated pushes). An explicit
  CROSSFIRE_MANIFEST override that does not exist -> fail closed (typo guard).
- G-5: CROSSFIRE_SKIP=1 -> exit 0 but append to <ROOT>/data/crossfire-skips.log;
  if it cannot record the override, fail closed.
- G-6: Manifest validation, all failing closed on violation: files must be an array;
  empty/missing files -> exit 0; entries must be non-empty strings; no commas in paths;
  spec/workspace must be non-empty strings; workspace must resolve inside ROOT (realpath).
- G-7: Otherwise spawn crossfire.js (absolute path) with --files (and --spec/--workspace
  if present) and propagate its exit code; if launch fails, fail closed.
- G-8: Diff-aware enforcement. A full cross-model audit is expensive, so the gate
  only runs it when the commits being pushed actually touch a manifest file. It
  reads git's pre-push ref updates from stdin (`<localref> <localsha> <remoteref>
  <remotesha>` per line) and unions `git diff --name-only <remotesha>..<localsha>`
  across updated refs. If NO audited file changed in the pushed range -> exit 0
  (allow). FAIL-SAFE: if the diff cannot be bounded (no/unreadable stdin, a new
  remote branch with a zero remote sha, or a git error) -> audit conservatively
  rather than skip. A branch deletion (zero local sha) contributes nothing. The
  gate must never silently skip on uncertainty — only on a concrete "nothing
  relevant changed".

## crossfire-loop.js — autonomous audit→fix→re-audit
- L-1: ROOT = audited repo (cwd / CROSSFIRE_ROOT); run artifacts written under <ROOT>/data;
  sibling crossfire.js resolved via __dirname.
- L-2: Dedicated fixer via a separate gateway model call, distinct from the auditors.
- L-3: Fixers alternate across rounds (default Codex then Opus); overridable via
  CROSSFIRE_FIXER_MODELS. No hard round cap.
- L-4: Stall detection: escalate and stop (exit 3) when the blocking count does not
  decrease for 2 rounds, OR identical blocking reasons repeat, OR the fixer returns
  no usable/appliable edit blocks.
- L-5: Fixer edits are SEARCH/REPLACE blocks; apply is atomic (validate every block
  matches uniquely before writing), and JS edits are syntax-checked with full revert on break.
- L-6: Edits to paths outside the workspace are rejected.
- L-7: Telegram escalation is optional: only sends if CROSSFIRE_TG_SCRIPT is set and a
  chat id is provided; otherwise console-only. No hardcoded chat id in source.
- L-8: Exit codes: 0 converged (PASS), 3 stalled+escalated, 1 fatal.

## Constraints
- No new npm dependencies (stdlib only: fs, path, child_process, http).
- Scripts must not hard-depend on any clawd-specific file (tg-send.js, ops-guard.js)
  by absolute path; such integrations must be optional/env-gated.
- Must not break unrelated `git push` when no audit is pending.
