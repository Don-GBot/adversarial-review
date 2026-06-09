# Crossfire Tooling Self-Audit Spec

Audit target: `scripts/crossfire.js` and `scripts/crossfire-loop.js` — the auditor
and the autonomous audit→fix→re-audit loop. These are the tooling that gates all
other code review, so correctness here is load-bearing.

## §1 Verdict reconciliation (crossfire.js `parseVerdict`) — CRITICAL

1. **Itemized prose is the blocking authority.** The blocking count (Phase 1
   FAIL, Phase 2 CRITICAL/HIGH) MUST be derived from itemized findings
   (`STATUS: FAIL`, `SEVERITY: CRITICAL|HIGH` lines), not from the footer
   integer alone. Rationale: a fixer can only act on an itemized finding; a bare
   footer count with no matching itemized line is unactionable.
2. **No phantom-overcount stall.** If the footer claims a blocking count higher
   than the itemized prose count (e.g. `fail=1` but zero `STATUS: FAIL` lines),
   the gate MUST NOT block on the phantom. Blocking on a finding the fixer cannot
   locate creates an unbreakable stall. This is the primary bug this audit guards.
3. **Undercount protection preserved.** If the footer claims 0 but prose has a
   real itemized FAIL/CRITICAL/HIGH, the gate MUST still block. A footer slip
   must never suppress a real finding.
4. **Truncation fails closed.** A missing or non-final `CROSSFIRE_VERDICT` footer
   (truncated / drifted response) MUST force a block (incomplete output =
   unverifiable = fail closed). This is the safety net that makes prose
   authority sound: a present+final footer implies complete output.
5. **Mismatches surfaced.** Any footer/prose disagreement MUST still be recorded
   in `reasons[]` for human visibility, even when it does not block.
6. Fenced code blocks MUST be stripped before prose counting so example/template
   labels inside ``` fences are not counted as real findings.

## §2 Retry / timeout / token budget (both files) — HIGH

1. Truncation retry loop (`finish_reason === "length"`) MUST terminate: bounded
   by `CROSSFIRE_TRUNCATE_RETRIES`, no unbounded recursion or infinite loop.
2. Timeouts and token budgets MUST be env-overridable with safe defaults
   (timeout ≥ old 300s, tokens ≥ old 16k) and MUST NOT regress below the old
   hardcoded values by default.
3. EPIPE / transient gateway errors MUST be retried with bounded attempts, not
   retried forever, and a terminal failure MUST surface (not silently pass).
4. The loop MUST propagate the timeout/token/retry env settings to the spawned
   child auditor so parent and child agree.

## §3 Loop safety (crossfire-loop.js) — HIGH

1. Stall detection MUST escalate (no silent infinite looping): identical blocking
   reasons across rounds, or no reduction in blocking count, MUST stop and notify.
2. Edit-block application MUST be atomic: validate all SEARCH blocks match (and
   are unique) before writing; syntax-check after; revert ALL on any failure.
3. The loop MUST refuse a workspace outside ROOT (no editing trees outside the
   repo) and MUST reject edits to files that resolve outside the workspace.
4. A non-source blocking reason (missing footer, auditor error, unaudited files)
   MUST NOT be mistaken for a fixable code finding.

## §4 Out of scope
Network behavior of the live gateway, model quality, and the content of audits
of OTHER projects. This audit is strictly about the tooling's control flow,
verdict math, and safety rails.
