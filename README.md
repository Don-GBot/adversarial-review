# cross-model-review

Runs implementation plans through an adversarial review loop between two different AI models — a reviewer and a planner — iterating until the reviewer approves or maximum rounds are hit. The reviewer challenges the plan, the planner (you, the main agent) revises it, and this continues until all CRITICAL and HIGH issues are resolved. Think of it as a built-in second opinion that can't be gamed because it's a different model from a different provider.

---

## Quick Start

**Install from ClawHub:**
```
/install cross-model-review
```

**Trigger phrases** (say any of these with a plan in context):
- "review this plan"
- "cross review"
- "challenge this"
- "is this plan solid?"

The skill activates automatically and manages the full loop. No manual setup needed.

---

## How It Works

```
You share a plan
      │
      ▼
┌─────────────────────────────────────────────┐
│  Round N (max 5)                            │
│                                             │
│  1. Agent builds reviewer prompt            │
│     (plan wrapped in UNTRUSTED delimiters)  │
│                                             │
│  2. Reviewer (different model) spawned      │
│     → outputs structured JSON verdict       │
│                                             │
│  3. review.js parses response:              │
│     - Assigns stable issue IDs (ISS-001...) │
│     - Runs dedup check (Jaccard ≥ 0.6)      │
│     - Updates issue tracker                 │
│     - Checks CRITICAL/HIGH blockers         │
│                                             │
│  4a. APPROVED → finalize, present summary   │
│  4b. REVISE → agent revises plan, loop      │
└─────────────────────────────────────────────┘
      │
      ▼ (if max rounds hit without approval)
Present unresolved issues → ask user to override or manually revise
```

**Cross-provider enforcement:** reviewer and planner must be from different provider families (e.g. Anthropic + OpenAI). Same-provider reviews are rejected.

**Prompt injection protection:** plan content is always wrapped in `<<<UNTRUSTED_PLAN_CONTENT>>>` delimiters and the reviewer is instructed to treat it as data only.

---

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| Reviewer model | `openai/codex` | Must be different provider from planner |
| Planner model | Your current model | Detected automatically |
| Max rounds | `5` | Override via `--max-rounds` in review.js |
| Token budget | `8000` | For codebase context via `--token-budget` |

To use a different reviewer model, ask: *"cross review this plan using gemini as reviewer"*

---

## Output Structure

Each review run creates a workspace in `tasks/reviews/<timestamp>-<uuid>/`:

```
tasks/reviews/2025-01-15T12-00-00-abc12345/
├── plan-v1.md          # Original plan
├── plan-v2.md          # After round 1 revisions
├── plan-v3.md          # After round 2 revisions (if needed)
├── plan-final.md       # Clean final plan (no review comments)
├── changelog.md        # What changed each round
├── issues.json         # Full issue tracker with lifecycle
├── meta.json           # Run metadata (models, rounds, verdict)
├── round-1-response.json  # Raw reviewer response
├── round-1-output.json    # Parsed round output + dedup warnings
└── summary.json        # Final stats and verdict
```

**summary.json:**
```json
{
  "rounds": 3,
  "plannerModel": "anthropic/claude-sonnet-4-6",
  "reviewerModel": "openai/gpt-4",
  "totalIssuesFound": 8,
  "issuesBySeverity": { "critical": 1, "high": 2, "medium": 3, "low": 2 },
  "issuesResolved": 8,
  "issuesUnresolved": 0,
  "finalVerdict": "APPROVED",
  "completedAt": "2025-01-15T12:03:45.000Z",
  "force_approve_log": null
}
```

---

## Force-Approve (Override)

If max rounds hit and CRITICAL/HIGH issues remain unresolved:

**Interactive (TTY):**
```bash
node scripts/review.js finalize \
  --workspace tasks/reviews/<run> \
  --override-reason "Deadline constraint, will fix post-launch"
# Prompts: Type "CONFIRM" to proceed
```

**Non-interactive (CI):**
```bash
node scripts/review.js finalize \
  --workspace tasks/reviews/<run> \
  --override-reason "Emergency hotfix, security team notified" \
  --ci-force
```

Force-approvals are logged in `summary.json` under `force_approve_log` with actor, reason, timestamp, and unresolved issue IDs.

---

## Integration with coding-agent

When `coding-agent` dispatches a plan that touches auth, payments, or data models, `cross-model-review` runs as a pre-flight gate. Coding-agent only proceeds if `review.js` exits with code 0.

Exit codes:
- `0` — Approved, all blockers resolved
- `1` — Revise (max rounds hit or unresolved issues)
- `2` — Error (parse failure, bad flags, unavailable model)

---

## Issue Tracking

Issues get stable IDs on first detection (`ISS-001`, `ISS-002`, ...):

```json
{
  "id": "ISS-003",
  "severity": "HIGH",
  "location": "Auth module",
  "problem": "No rate limiting on login endpoint",
  "fix": "Add rate-limit middleware, 5 attempts per 15 min",
  "status": "resolved",
  "round_found": 1,
  "round_resolved": 2,
  "last_evidence": "Rate limiting added in section 3.2"
}
```

Statuses: `open` → `resolved | still-open | regressed | not-applicable | force-approved`

Dedup: script flags new issues with Jaccard similarity ≥ 0.6 vs open issues as `dedup_warnings`. Human reviews the flags — no auto-merge.

---

## Publishing

Built by Don-GBot for the OpenClaw ecosystem. v1.0.0 targets single-reviewer, sessions_spawn backend only. Parallel multi-reviewer and Codex CLI resume mode are v2 scope.

ClawHub slug: `cross-model-review`
Tags: `code-review` `multi-model` `adversarial` `planning` `quality`
