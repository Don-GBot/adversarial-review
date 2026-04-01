---
name: cross-model-review
version: 1.0.0
description: >
  Adversarial plan review using two AI models from different providers.
  Claude (Anthropic) plans, Codex (OpenAI) reviews — cross-provider blind spots surface real issues.
  Supports static mode (fixed roles) and alternating mode (models swap writer/reviewer each round).
  Triggers when: "review this plan", "cross review", "challenge this", "is this plan solid?",
  "adversarial review", or user shares a plan and asks for second-opinion review.
  NOT for: simple one-file fixes, research tasks, quick scripts, changes reversible in <5 minutes.
metadata:
  filePattern:
    - "**/tasks/reviews/**"
    - "**/plan*.md"
  bashPattern:
    - "review\\.js"
    - "cross.model.review"
---

# cross-model-review — Claude Code Skill

Adversarial plan review using two AI models from different providers.
Claude (Anthropic) acts as planner, Codex (OpenAI) acts as reviewer — or they alternate roles.

## Prerequisites

- **Codex CLI** installed and authenticated (`codex --version` and `codex login`)
- **Node.js >= 18.0.0**
- The `scripts/review.js` state machine (ships with this skill, zero npm deps)

## How It Works

```
User shares a plan
       │
       ▼
┌──────────────────────────────────────────────┐
│  Round N (max 5 static / 8 alternating)      │
│                                              │
│  1. next-step → get prompt + model           │
│  2. If model is OpenAI family:               │
│     → Delegate to Codex via codex-rescue     │
│  3. If model is Anthropic family:            │
│     → Execute directly (we are Claude)       │
│  4. Save response → parse-round              │
│  5. APPROVED? → finalize. REVISE? → loop.    │
└──────────────────────────────────────────────┘
```

## Orchestration Contract

You (Claude) are the orchestrator. You drive the loop by calling `review.js` subcommands
and spawning sub-agents for the cross-provider model.

### Step 0 — Save the plan

The user provides a plan (inline or as a file). Save it to a temp file if inline.

### Step 1 — Initialize workspace

```bash
# For alternating mode (recommended):
node <skill-root>/scripts/review.js init \
  --plan /path/to/plan.md \
  --mode alternating \
  --model-a "anthropic/claude-opus-4-6" \
  --model-b "openai/gpt-5.4" \
  --project-context "Brief description of what this plan implements" \
  --out tasks/reviews

# For static mode:
node <skill-root>/scripts/review.js init \
  --plan /path/to/plan.md \
  --mode static \
  --reviewer-model "openai/gpt-5.4" \
  --planner-model "anthropic/claude-opus-4-6" \
  --out tasks/reviews
```

Capture the workspace path from stdout.

### Step 2 — The autonomous loop

```
while true:
  step = run: node review.js next-step --workspace <ws>
  parse step JSON

  if step.action == "done":
    break  → go to finalize

  if step.action == "max-rounds":
    ask user: override or manual fix
    break

  if step.action == "error":
    report error to user, stop

  if step.action == "criteria-propose":
    # Round 0: Model A proposes acceptance criteria
    # If model is Anthropic → execute prompt yourself
    # If model is OpenAI → delegate to Codex
    save response to temp file
    run: node review.js save-criteria --workspace <ws> --phase propose --response <file>
    continue

  if step.action == "criteria-challenge":
    # Round 0: Model B challenges/refines criteria
    # Route to appropriate model
    save response to temp file
    run: node review.js save-criteria --workspace <ws> --phase challenge --response <file>
    continue

  if step.action == "review":
    # Route based on step.model provider family
    # OpenAI family → spawn Codex: delegate prompt via codex:codex-rescue subagent
    #   System instruction: "Output ONLY valid JSON. No tool calls. No markdown fences."
    # Anthropic family → execute prompt yourself, output JSON only
    save raw response to: <ws>/round-<step.round>-response.json
    run: node review.js parse-round --workspace <ws> --round <step.round> --response <file>
    continue

  if step.action == "revise":
    # Route based on step.model provider family
    # The writer rewrites the plan based on review feedback
    # Save output to temp file
    run: node review.js save-plan --workspace <ws> --plan <tempfile> --version <step.planVersion>
    continue
```

### Step 3 — Finalize

```bash
node review.js finalize --workspace <ws>
```

Present to user: verdict, rounds taken, issues found/resolved, rubric scores, plan-final.md path.

## Model Routing

| Model family detected | Route to |
|---|---|
| `openai`, `gpt`, `codex`, `o1`, `o3` | Codex CLI via `codex:codex-rescue` subagent |
| `anthropic`, `claude`, `sonnet`, `opus`, `haiku` | Execute directly (you are Claude) |
| `google`, `gemini` | Not yet supported — future extension |
| `unknown` | Warn user, attempt Codex as fallback |

## Delegating to Codex

When the step requires an OpenAI-family model, use the `codex:codex-rescue` subagent:

```
Agent(subagent_type="codex:codex-rescue", prompt=step.prompt)
```

**For reviewer steps**: Prefix the prompt with the system instruction:
"You are a senior engineering reviewer. Output ONLY valid JSON matching the schema. No tool calls. No markdown fences. No preamble."

**For writer steps**: The prompt from `next-step` is self-contained — pass it directly.

**For criteria steps**: Same as reviewer — JSON-only output required.

## Executing as Claude

When the step requires an Anthropic-family model, you execute the prompt yourself:
- For review actions: Generate ONLY the JSON review schema. No other text.
- For revise actions: Generate ONLY the complete revised plan as markdown.
- For criteria actions: Generate ONLY the JSON criteria schema.

Save your output to the appropriate file before calling the next review.js subcommand.

## Error Handling

- **Codex timeout/failure**: Retry once. If it fails again, report to user.
- **JSON parse error from reviewer**: Re-prompt once with: "Your response was not valid JSON. Please respond with ONLY the JSON schema specified."
- **Max rounds hit**: Present unresolved issues to user. Offer force-approve with `--override-reason`.
- **Same-provider rejection**: `review.js init` will reject if both models are from the same family.

## Presenting Results

After finalize, show the user:
1. **Verdict** (APPROVED / FORCE_APPROVED)
2. **Rounds taken** and models used
3. **Issue summary** — total found, resolved, by severity
4. **Rubric scores** — per-dimension scores with rationale
5. **Final plan location** — path to `plan-final.md`
6. **Any force-approve details** if applicable

## Notes

- `review.js` is the state machine — always call `next-step` to determine what to do next
- All workspace state is in `tasks/reviews/<timestamp>/` — fully auditable
- Cross-provider enforcement: models must be from different families
- Prompt injection protection: plan content wrapped in `<<<UNTRUSTED_PLAN_CONTENT>>>` delimiters
- The skill works with both OpenClaw (`sessions_spawn`) and Claude Code (Agent tool) — same `review.js`, different orchestrators
