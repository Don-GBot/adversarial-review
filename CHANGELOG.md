# Changelog

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
