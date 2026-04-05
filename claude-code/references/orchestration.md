# Orchestration Reference

Full loop pseudocode and CLI details for the cross-model-review state machine.

## Initialization

```bash
# Alternating mode (recommended — models swap roles each round):
node ~/.claude/skills/cross-model-review/scripts/review.js init \
  --plan /path/to/plan.md \
  --mode alternating \
  --model-a "anthropic/claude-opus-4-6" \
  --model-b "openai/gpt-5.4" \
  --project-context "Brief description of what this plan implements" \
  --out tasks/reviews

# Static mode (fixed roles — planner always writes, reviewer always reviews):
node ~/.claude/skills/cross-model-review/scripts/review.js init \
  --plan /path/to/plan.md \
  --mode static \
  --reviewer-model "openai/gpt-5.4" \
  --planner-model "anthropic/claude-opus-4-6" \
  --out tasks/reviews
```

Captures workspace path from stdout (e.g., `tasks/reviews/2026-04-01T16-00-00-abc12345`).

## The Autonomous Loop

```
REVIEW_JS="~/.claude/skills/cross-model-review/scripts/review.js"

while true:
  step = run: node $REVIEW_JS next-step --workspace <ws>
  parse step as JSON

  if step.action == "done":
    break  → go to finalize

  if step.action == "max-rounds":
    present unresolved issues to user
    ask: override with --override-reason or manual fix?
    break

  if step.action == "error":
    report step.reason to user, stop

  if step.action == "criteria-propose":
    # Round 0: Model A proposes 5 task-specific acceptance criteria
    route step.prompt to step.model (Anthropic → self, OpenAI → Codex)
    save response to temp file
    run: node $REVIEW_JS save-criteria --workspace <ws> --phase propose --response <file>
    continue

  if step.action == "criteria-challenge":
    # Round 0: Model B challenges/refines criteria to final set
    route step.prompt to step.model
    save response to temp file
    run: node $REVIEW_JS save-criteria --workspace <ws> --phase challenge --response <file>
    continue

  if step.action == "review":
    route step.prompt to step.model
    # For OpenAI family: Agent(subagent_type="codex:codex-rescue", prompt=...)
    #   Prefix prompt with: "Output ONLY valid JSON. No tool calls. No markdown fences."
    # For Anthropic family: execute prompt yourself, generate ONLY the JSON schema
    save raw response to: <ws>/round-<step.round>-response.json
    run: node $REVIEW_JS parse-round --workspace <ws> --round <step.round> --response <file>
    # Exit code 0 = APPROVED, 1 = REVISE
    continue

  if step.action == "revise":
    route step.prompt to step.model
    # Writer rewrites the plan based on review feedback
    # For OpenAI family: Agent(subagent_type="codex:codex-rescue", prompt=...)
    # For Anthropic family: execute prompt, generate ONLY the complete plan as markdown
    save output to temp file
    run: node $REVIEW_JS save-plan --workspace <ws> --plan <tempfile> --version <step.planVersion>
    continue
```

## Finalize

```bash
node $REVIEW_JS finalize --workspace <ws>
```

Returns JSON with verdict, plan-final.md path, summary.json path, rounds taken, issues found/resolved.

## Force-Approve (when max rounds hit with open blockers)

```bash
# In Claude Code (non-TTY) — must use --ci-force:
node $REVIEW_JS finalize \
  --workspace <ws> \
  --override-reason "User accepted remaining risks after reviewing issues" \
  --ci-force
```

## CLI Reference

| Command | Purpose | Exit Codes |
|---------|---------|-----------|
| `init` | Create workspace | 0=ok, 2=error |
| `next-step` | Get next action | 0=ok, 1=max-rounds, 2=error |
| `parse-round` | Parse reviewer response | 0=approved, 1=revise, 2=error |
| `save-plan` | Save revised plan | 0=ok, 2=error |
| `save-criteria` | Save Round 0 criteria | 0=ok, 2=error |
| `finalize` | Generate summary | 0=approved, 1=unapproved, 2=error |
| `status` | Print workspace state | 0=approved, 1=unapproved |

## Init Options

| Option | Default | Description |
|--------|---------|-------------|
| `--plan <file>` | required | Path to plan markdown file |
| `--mode` | `static` | `static` or `alternating` |
| `--model-a <m>` | required (alt) | Model A — writes first in alternating |
| `--model-b <m>` | required (alt) | Model B — reviews first in alternating |
| `--reviewer-model <m>` | required (static) | Reviewer model |
| `--planner-model <m>` | required (static) | Planner model |
| `--project-context <s>` | `""` | Brief context injected into reviewer prompts |
| `--out <dir>` | `tasks/reviews` | Output base directory |
| `--max-rounds <n>` | 5 (static) / 8 (alt) | Maximum review rounds |
| `--token-budget <n>` | 8000 | Token budget for codebase context |
