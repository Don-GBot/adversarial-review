# Example Review Cycle

A 2-round alternating review of an auth redesign plan.

## Round 0 — Criteria Negotiation

Model A (Claude) proposes 5 task-specific acceptance criteria:
```json
{
  "criteria": [
    { "id": "AC-1", "description": "Session tokens must be rotated on privilege escalation", "risk_if_missed": "Token replay after role change grants stale permissions" },
    { "id": "AC-2", "description": "Rate limiting on login endpoint: max 5 attempts per 15 min per IP", "risk_if_missed": "Brute force attacks on user accounts" },
    { "id": "AC-3", "description": "OAuth state parameter validated server-side before token exchange", "risk_if_missed": "CSRF on OAuth callback" },
    { "id": "AC-4", "description": "Plan must NOT introduce a custom session store — use existing Redis adapter", "risk_if_missed": "Unnecessary complexity, untested code path" },
    { "id": "AC-5", "description": "Migration plan includes rollback steps for each schema change", "risk_if_missed": "Irreversible migration failure in production" }
  ],
  "scope_boundary": "This plan should NOT redesign the user model or touch email verification flows"
}
```

Model B (Codex) challenges and produces final criteria (accepts AC-1, AC-3, AC-5, modifies AC-2 threshold, replaces AC-4).

## Round 1 — First Review

Codex reviews Claude's plan. Response:
```json
{
  "verdict": "REVISE",
  "rubric": {
    "security":        { "score": 3, "rationale": "OAuth flow solid but session rotation timing unclear" },
    "data_integrity":  { "score": 4, "rationale": "Migration steps well-defined with rollback" },
    "concurrency":     { "score": 2, "rationale": "Race condition between token rotation and active requests" },
    "error_handling":  { "score": 3, "rationale": "Login failures handled but OAuth error path incomplete" },
    "scalability":     { "score": 4, "rationale": "Redis session store scales horizontally" },
    "completeness":    { "score": 3, "rationale": "Missing logout flow across devices" },
    "maintainability": { "score": 4, "rationale": "Clean separation of auth middleware" },
    "differentiation": { "score": 4, "rationale": "Specific to project's existing Redis setup" }
  },
  "prior_issues": [],
  "new_issues": [
    {
      "severity": "HIGH",
      "location": "Session rotation",
      "problem": "Race condition: active requests using old token may fail during rotation window",
      "fix": "Implement grace period — accept both old and new token for 30s after rotation"
    },
    {
      "severity": "MEDIUM",
      "location": "OAuth error handling",
      "problem": "No fallback when OAuth provider is unreachable",
      "fix": "Add timeout with retry and user-facing error state"
    }
  ],
  "summary": "Solid auth plan with one HIGH concurrency issue in session rotation and incomplete OAuth error handling"
}
```

After `parse-round`:
```json
{
  "verdict": "REVISE",
  "round": 1,
  "rubric": {
    "average": 3.38,
    "scored": 8,
    "warnings": ["concurrency scored 2/5 — critical weakness"]
  },
  "newIssues": 2,
  "dedupWarnings": 0,
  "blockers": 1
}
```

## Round 2 — Revision + Re-review

Codex rewrites the plan (alternating mode: reviewer implements their own fixes).
Claude reviews Codex's rewrite:

```json
{
  "verdict": "APPROVED",
  "rubric": {
    "security":        { "score": 4, "rationale": "Grace period and rotation now well-defined" },
    "data_integrity":  { "score": 4, "rationale": "Unchanged — still solid" },
    "concurrency":     { "score": 4, "rationale": "30s dual-token window resolves race condition" },
    "error_handling":  { "score": 4, "rationale": "OAuth timeout + retry + error state added" },
    "scalability":     { "score": 4, "rationale": "No regression" },
    "completeness":    { "score": 4, "rationale": "Multi-device logout added" },
    "maintainability": { "score": 4, "rationale": "Grace period logic clean, well-isolated" },
    "differentiation": { "score": 4, "rationale": "Implementation decisions grounded in project context" }
  },
  "prior_issues": [
    { "id": "ISS-001", "status": "resolved", "evidence": "Grace period implemented in section 3.2" },
    { "id": "ISS-002", "status": "resolved", "evidence": "OAuth timeout and retry added in section 4.1" }
  ],
  "new_issues": [],
  "summary": "All issues resolved. Plan ready for implementation."
}
```

## Finalize Output

```json
{
  "verdict": "APPROVED",
  "planFinal": "tasks/reviews/2026-04-01T16-00-00-abc123/plan-final.md",
  "summaryJson": "tasks/reviews/2026-04-01T16-00-00-abc123/summary.json",
  "changelogMd": "tasks/reviews/2026-04-01T16-00-00-abc123/changelog.md",
  "issuesJson": "tasks/reviews/2026-04-01T16-00-00-abc123/issues.json",
  "rounds": 2,
  "issuesFound": 2,
  "issuesResolved": 2,
  "forceApproved": false
}
```

## What to Present to the User

> **Cross-model review: APPROVED** (2 rounds)
>
> Models: Claude Opus 4.6 (planner) + GPT-5.4 (reviewer), alternating
>
> **Issues:** 2 found, 2 resolved, 0 unresolved
> - ISS-001 (HIGH) Session rotation race condition — resolved in round 2
> - ISS-002 (MEDIUM) OAuth error handling incomplete — resolved in round 2
>
> **Rubric:** avg 4.0/5 across 8 dimensions (up from 3.38 in round 1)
>
> **Final plan:** `tasks/reviews/2026-04-01T16-00-00-abc123/plan-final.md`

## Workspace Files After Completion

```
tasks/reviews/2026-04-01T16-00-00-abc123/
├── plan-v1.md              # Original plan (Claude)
├── plan-v2.md              # Revised by Codex after round 1
├── plan-final.md           # Clean final plan
├── changelog.md            # Round-by-round log
├── issues.json             # Full issue lifecycle
├── meta.json               # Run metadata
├── criteria-proposed.json  # Round 0a output
├── criteria-final.json     # Round 0b output
├── round-1-response.json   # Raw Codex review
├── round-1-output.json     # Parsed review + rubric
├── round-2-response.json   # Raw Claude review
├── round-2-output.json     # Parsed review + rubric
└── summary.json            # Final stats
```
