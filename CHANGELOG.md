# Changelog

## [2.2.0] - 2026-06-04

### Added — CODE review mode (crossfire)
The skill now covers two targets: **plans** (existing `review.js`) and **code** (new `crossfire`).
- **`scripts/crossfire.js`** — two-phase post-build audit. Phase 1 structural/spec-compliance (Opus), Phase 2 behavioral bug-hunt (Codex), cross-model by design via the OpenClaw gateway `/v1/chat/completions`. Emits a machine-readable `CROSSFIRE_VERDICT` footer; the gate decision uses `max(footer, prose-regex)` defense-in-depth and exits `2` on blocking findings (Phase 1 FAIL / Phase 2 CRITICAL or HIGH). Fails closed on auditor errors, unaudited/unresolved files, and spec/workspace path escapes (symlink-safe containment).
- **`scripts/crossfire-gate.js`** — pre-push enforcement wrapper. Reads a manifest (`data/crossfire-manifest.json`); no manifest = no block; `CROSSFIRE_SKIP=1` = logged override (fails closed if it cannot log). Validates manifest shape (array of non-empty strings, no commas, in-repo workspace).
- **`scripts/crossfire-loop.js`** — autonomous audit -> fix -> re-audit loop. Dedicated fixer (separate gateway call, distinct from auditors), **alternating Codex<->Opus** fixers as a stall-breaker, **no hard round cap**, escalate-on-stall (blocking count not decreasing / repeat reasons / unappliable or empty fixer output). Fixer returns Aider-style SEARCH/REPLACE blocks; apply is atomic (validate-all-then-write), exact+unique match required, JS syntax-checked with full revert on break, path-escape blocked.
- **`scripts/hooks/pre-push`** — portable pre-push hook (tracked, not just in `.git/hooks`).

### Changed
- Decoupled crossfire scripts from any host repo: `ROOT` resolves to the audited repo (cwd / `CROSSFIRE_ROOT`), sibling scripts resolve via `__dirname`, and Telegram escalation is optional via `CROSSFIRE_TG_SCRIPT` (console-only otherwise). No hardcoded chat IDs.

### Fixed — severity calibration (the stall fix)
- **Phase 2 auditor severity rubric**: the behavioral-audit prompt was "be adversarial, assume bugs" with no severity definition, so an adversarial model would always manufacture a HIGH from something theoretical (symlink races, mis-set env vars we control, malformed upstream output). Since the gate blocks on any HIGH, the audit→fix loop was structurally unable to converge. Added a strict rubric: CRITICAL/HIGH require a normal non-malicious input, on a path ordinary usage executes, producing a concretely wrong result. Attacker-write / mis-set-env / malformed-upstream / defense-in-depth findings cap at MEDIUM or LOW. Result: real bugs still block; theoretical noise no longer does. Verified by full autonomous loop converging in 1 round on the crossfire scripts themselves.
- **`countLabel()` prose-fallback (B-1)**: now counts severity lines prefixed by Markdown blockquote (`>`) and heading (`#`) markers, and lets markers stack/repeat, so a blockquoted/heading-prefixed finding can't slip past the prose fallback when footer arithmetic drifts. Negation prose ("no SEVERITY: HIGH found") and `HIGHLY`/`HIGH-ISH` still correctly do not match.
- **`crossfire-gate.js` root redirect (B-2)**: when `CROSSFIRE_ROOT` is overridden away from a cwd that has its own pending default manifest, the gate fails closed instead of silently skipping the real audit, and logs the effective root.

## [1.0.1] - 2026-02-21

### Fixed
- **`--max-rounds` implemented**: `init` now accepts `--max-rounds <n>` (default: 5); stored in `meta.json`
- **`--token-budget` implemented**: `init` now accepts `--token-budget <n>` (default: 8000); stored in `meta.json` (no chunking yet — stored for future use)
- **Removed unused imports**: Removed `os` and top-level `execSync` from `review.js`; `execSync` is no longer used anywhere (TTY confirmation replaced)
- **TTY confirmation fixed**: `execSync('read ...')` replaced with synchronous `readLineSync()` using `fs.readSync` on fd 0 — no shell subprocess needed
- **Intra-batch dedup**: `parse-round` now checks each new issue against other new issues in the same batch (not just prior open issues), detecting duplicates submitted by the reviewer in a single round
- **Stricter unknown family handling**: If both models resolve to `'unknown'` family, warn but allow. If one resolves to `'unknown'`, warn but allow. Only hard-fail when both families are known and equal.

### Documentation
- **SKILL.md**: Corrected verdict source (read from `meta.json` or `parse-round` stdout, NOT `issues.json`); clarified exact shape of `{prior_issues_json}`; added fallback path for reviewer timeout; added file path quoting guidance
- **README.md**: Added Prerequisites section (Node.js >=18, OpenClaw); added complete end-to-end CLI transcript; added Troubleshooting section; added CI badge; added "Why not single-model review?" section; added "When NOT to use" section near top; fixed claims about unimplemented features

### New Files
- `SECURITY.md`: Threat model, prompt injection mitigations, known limitations, safe usage guidance, responsible disclosure contact
- `.github/workflows/ci.yml`: GitHub Actions CI running tests on Node.js 18, 20, 22
- `.editorconfig`: Consistent formatting config for editors

### Tests
- Added: `--max-rounds` and `--token-budget` stored in `meta.json`
- Added: force-approve with `--ci-force` in non-TTY mode
- Added: `--ci-force` without `--override-reason` correctly rejected
- Added: unknown model family (both unknown, one unknown) warns but allows
- Added: intra-batch dedup detection
- Added: verdict stored in `meta.json` after finalize
- Total: 55 tests (up from 36)

---

## [1.0.0] - 2026-02-21

### Added
- Agent-orchestrated adversarial review loop (reviewer spawned via sessions_spawn, agent revises)
- `review.js` helper script with 4 subcommands: init, parse-round, finalize, status
- Stable issue tracking with lifecycle (ISS-NNN IDs, status transitions across rounds)
- Jaccard similarity dedup detection (0.6 threshold) to prevent semantic drift
- Fail-closed gating: exit codes 0 (approved), 1 (revise), 2 (error)
- Cross-model enforcement: rejects same provider family for reviewer and planner
- Force-approve with TTY confirmation, mandatory reason, and audit logging
- `--ci-force` flag for non-interactive environments (requires `--override-reason`)
- Prompt injection mitigation via UNTRUSTED content delimiters
- Token budget support for codebase context (`--token-budget`)
- Per-run isolated workspaces (`tasks/reviews/<timestamp>-<uuid>/`)
- Reviewer prompt template with structured JSON-only output format
- ClawHub-ready README with integration guide

### Security
- Reviewer and planner prompts sandboxed with instruction-level tool restriction
- Plan content wrapped in explicit UNTRUSTED delimiters
- Force-approve requires human confirmation and is audit-logged
