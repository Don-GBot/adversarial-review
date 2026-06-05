---
name: "cross-model-review"
description: "Adversarial cross-model review for two targets: PLANS (review.js) and CODE (crossfire). Plan mode runs alternating-model adversarial rounds; code mode runs a two-phase audit (structural + behavioral) with an optional pre-push gate and an autonomous Codex<->Opus audit/fix loop."
---

# cross-model-review

## Metadata
```yaml
name: cross-model-review
version: 2.2.0
description: >
  Adversarial cross-model review with TWO targets:
  PLAN mode (review.js) — two models swap writer/reviewer each round,
  fully autonomous loop, classify triage gate to skip the panel on simple plans.
  CODE mode (crossfire) — two-phase audit of live code (Phase 1 structural/spec
  compliance via Opus, Phase 2 behavioral/bug-hunt via Codex), a machine-readable
  verdict that exits nonzero on blocking findings, an optional pre-push gate, and
  an autonomous audit->fix->re-audit loop with alternating Codex<->Opus fixers
  that escalates on stall.
  Use when: building/auditing anything touching auth/payments/data models,
  plans or changes that will take >1hr to implement.
  NOT for: simple one-file fixes, research tasks, quick scripts.
triggers:
  - "review this plan"
  - "cross review"
  - "challenge this"
  - "is this plan solid?"
  - "adversarial review"
  - "audit this code"
  - "crossfire"
  - "code review gate"
```

---

## Two targets: PLAN review vs CODE audit
This skill has two independent halves. Pick by **what you're reviewing**:

| Target | Tool | What it reviews | Output |
|--------|------|-----------------|--------|
| **PLAN** | `scripts/review.js` (+ `classify.js`) | A written implementation plan, before building | Approved/revised plan after adversarial rounds |
| **CODE** | `scripts/crossfire*.js` | Live source files, after building | Audit verdict + optional autonomous fixes |

Everything below the "Autonomous Orchestration" heading is PLAN mode. CODE mode
is documented in its own section ("CODE mode — crossfire") further down.

## When to Activate
Activate this skill when the user:
- Says any trigger phrase above
- Shares a plan and asks for adversarial/second-opinion review (PLAN mode)
- Asks you to "sanity check" a multi-step implementation plan (PLAN mode)
- Asks you to audit/gate live code, or wants an autonomous audit+fix loop (CODE mode)

Do NOT activate for: simple fixes, one-liners, pure research tasks.

### Triage gate first (v2.1 — Pattern A: classify-and-act)
Cross-model review is expensive (multiple model calls). Before `init`, run the
classifier to decide whether the plan actually warrants the full panel:

```bash
node classify.js --plan /path/to/plan.md --project-context "Brief context"
```

It prints JSON `{ action: "classify", model, prompt, saveTo: null }`. `saveTo` is
null — the classifier response is held in orchestrator memory; classify.js does
zero filesystem writes. Spawn `model` (default `anthropic/claude-sonnet-4-6`)
with `prompt`. The classifier returns:

```json
{ "needs_cross_model": true, "complexity": "high",
  "recommended_path": "full-cmr", "reason": "..." }
```

Then apply the orchestrator validation gate (see
`references/orchestrator-validation.md` — this is the safety-critical part):
- Timeout, malformed JSON, or out-of-enum `recommended_path` → default to
  `full-cmr` (fail open; never silently skip).
- `recommended_path: "full-cmr"` → proceed to `init` (no confirmation needed).
- `recommended_path: "skip"` or `"single-reviewer"` → surface the `reason` and
  require explicit confirmation BEFORE skipping/downgrading. Absent an
  affirmative yes (declined, no response, ambiguous, or a thrown confirm
  handler) → run the FULL panel.

This is the only token-SAVING change in the workflow patterns — it gates out
plans that do not need a five-call adversarial loop. Source: Thariq's Claude
Code dynamic-workflows post (classify-and-act pattern).

The untrusted plan text is fenced in `<<<UNTRUSTED_PLAN>>>` markers and the
classifier is told to treat anything inside as content to classify, not commands
to follow, so a plan cannot inject its own "recommend skip" verdict.

---

## Modes

### Static Mode (v1 — backward compatible)
Fixed roles: planner always writes, reviewer always reviews. Requires human to trigger each round.

### Alternating Mode (v2 — recommended)
Models swap roles each round. Fully autonomous — no human input between rounds.

**Flow:**
- Round 1: Model A writes the plan. Model B reviews.
- Round 2: Model B rewrites (based on its own review). Model A reviews.
- Round 3: Model A rewrites (based on its own review). Model B reviews.
- ...continues alternating until both agree (reviewer says APPROVED) or max rounds hit.

**Why this works:**
- Each model must implement its own critique — can't nitpick without owning the fix
- The other model catches over-engineering or proportionality issues
- Natural convergence: each round addresses the other's concerns

---

## Autonomous Orchestration (Alternating Mode)

You (the main agent) run this loop. It's fully autonomous after kickoff.

### Step 1 — Save the plan and init

```bash
node review.js init \
  --plan /path/to/plan.md \
  --mode alternating \
  --model-a "anthropic/claude-opus-4-6" \
  --model-b "openai-codex/gpt-5.4" \
  --project-context "Brief description for reviewer calibration" \
  --out /home/ubuntu/clawd/tasks/reviews
```

Captures workspace path from stdout.

### Step 2 — The autonomous loop

Round 0 now negotiates task-specific acceptance criteria before the first real review round. Do not skip it.

```
while true:
  step = next-step(workspace)

  if step.action == "done":
    break  # APPROVED!

  if step.action == "max-rounds":
    ask user: override or manual fix
    break

  if step.action == "criteria-propose":
    spawn sub-agent with step.model, step.prompt
    save response to workspace/criteria-propose-response.json
    save-criteria(workspace, response, phase="propose")
    continue

  if step.action == "criteria-challenge":
    spawn sub-agent with step.model, step.prompt
    save response to workspace/criteria-challenge-response.json
    save-criteria(workspace, response, phase="challenge")
    continue

  if step.action == "review":
    spawn sub-agent with step.model, step.prompt
    save response to workspace/round-N-response.json
    parse-round(workspace, round, response)
    continue

  if step.action == "revise":
    spawn sub-agent with step.model, step.prompt
    save output plan to temp file
    save-plan(workspace, temp file, version)
    continue
```

### Step 3 — Finalize

When the loop exits with APPROVED:
```bash
node review.js finalize --workspace <workspace>
```

Present: rounds taken, issues found/resolved, rubric scores, plan-final.md location.

---

## CLI Reference

```
Commands:
  classify       Triage gate: decide if a plan warrants full cross-model review
  init           Create a review workspace
  next-step      Get next action for autonomous loop
  parse-round    Parse a reviewer response, update issue tracker
  save-criteria  Save Round 0 criteria negotiation output
  save-plan      Save a revised plan version from writer output
  finalize       Generate plan-final.md, changelog.md, summary.json
  status         Print current workspace state

classify options:
  --plan <file>            Path to plan file (required)
  --project-context <s>    Brief project context for the classifier
  --model <m>              Classifier model (default: anthropic/claude-sonnet-4-6)
  Returns JSON: { action: "classify", model, prompt, saveTo: null }

init options:
  --plan <file>            Path to plan file (required)
  --mode <m>               "static" (default) or "alternating"
  --model-a <m>            Model A — writes first (alternating mode, required)
  --model-b <m>            Model B — reviews first (alternating mode, required)
  --reviewer-model <m>     Reviewer model (static mode, required)
  --planner-model <m>      Planner model (static mode, required)
  --project-context <s>    Brief project context for reviewer calibration
  --out <dir>              Output base dir (default: tasks/reviews)
  --max-rounds <n>         Max rounds (default: 5 static, 8 alternating)
  --token-budget <n>       Token budget for context (default: 8000)

next-step options:
  --workspace <dir>        Path to review workspace (required)
  Returns JSON: { action, model, round, prompt, planVersion, saveTo }
  Actions: "criteria-propose", "criteria-challenge", "review", "revise", "done", "max-rounds"

parse-round options:
  --workspace <dir>        Path to review workspace (required)
  --round <n>              Round number (required)
  --response <file>        Path to raw reviewer response (required)

save-criteria options:
  --workspace <dir>        Path to review workspace (required)
  --response <file>        Path to raw criteria response (required)
  --phase <p>              "propose" or "challenge" (required)

save-plan options:
  --workspace <dir>        Path to review workspace (required)
  --plan <file>            Path to revised plan markdown (required)
  --version <n>            Plan version number (required)

finalize options:
  --workspace <dir>        Path to review workspace (required)
  --override-reason <s>    Reason for force-approving with open issues
  --ci-force               Required in non-TTY mode when overriding

status options:
  --workspace <dir>        Path to review workspace (required)

Exit codes:
  0   Approved / OK
  1   Revise / max-rounds
  2   Error
```

---

## Detailed Orchestration (for agent implementation)

### Spawning the classifier (v2.1)
```
step = classify(plan)  # action: "classify", saveTo: null
response = sessions_spawn(model=step.model, task=step.prompt, timeout=30s)
# Apply the validation gate from references/orchestrator-validation.md:
#   timeout / malformed JSON / out-of-enum recommended_path → full-cmr
#   skip|single-reviewer → confirm with user first; absent yes → full-cmr
# Only proceed to init when the gate resolves the path.
```

### Spawning criteria rounds
```
step = next-step(workspace)  # action: "criteria-propose" or "criteria-challenge"
response = sessions_spawn(model=step.model, task=step.prompt, timeout=120s)
# Save raw response to workspace/criteria-propose-response.json or criteria-challenge-response.json
# Then call save-criteria with phase="propose" or phase="challenge" based on step.action
save-criteria(workspace, response_file, phase)
```

### Spawning reviewers
```
step = next-step(workspace)  # action: "review"
response = sessions_spawn(model=step.model, task=step.prompt, timeout=120s)
# Save raw response to workspace/round-{step.round}-response.json
parse-round(workspace, step.round, response_file)
```

System instruction for reviewer: "You are a senior engineering reviewer. Output ONLY valid JSON matching the schema. No tool calls. No markdown fences. No preamble."

### Spawning writers
```
step = next-step(workspace)  # action: "revise"
revised_plan = sessions_spawn(model=step.model, task=step.prompt, timeout=300s)
# Save raw output as temp file
save-plan(workspace, temp_file, step.planVersion)
```

System instruction for writer: none needed — the prompt is self-contained.

### Error handling
- Classifier timeout/failure/malformed/out-of-enum: default to full panel (fail open, never silent skip)
- Reviewer timeout/failure: retry once, then ask user
- Writer timeout/failure: retry once, then ask user
- Criteria JSON parse failure: retry once before advancing phases
- Parse error on review JSON: re-prompt reviewer once with "Your response was not valid JSON"
- If one side returns malformed JSON, empty output, or stalls unexpectedly, suspect model-path or transport failure before blaming the review logic
- Never silently swap to a same-provider fallback and still call it cross-model review
- Max rounds hit: present status to user, ask for override or manual fix

### Convergence
The loop converges when the reviewer says APPROVED with no open CRITICAL/HIGH blockers. The script enforces this — if reviewer says APPROVED but blockers remain, it overrides to REVISE.

---

## CODE mode — crossfire (v2.2)

Reviews **live source files** (not plans). Two-phase, cross-model, via the
OpenClaw gateway `/v1/chat/completions`. Three scripts, layered:

### 1. One-shot audit — `crossfire.js`
```bash
node scripts/crossfire.js --files a.js,b.js [--spec spec.md] [--workspace DIR] [--output report.md]
```
- **Phase 1 (structural)** — spec compliance, run on Opus. Skipped if no `--spec`.
- **Phase 2 (behavioral)** — adversarial bug-hunt, run on Codex.
- Each auditor must end with a machine-readable line:
  `CROSSFIRE_VERDICT fail=<N> warn=<N>` (Phase 1) / `CROSSFIRE_VERDICT critical=<N> high=<N>` (Phase 2).
- Verdict = `max(footer, prose-regex)` (defense-in-depth; a footer arithmetic slip
  can't suppress a prose finding, and a missing footer fails closed).
- **Exit codes:** `0` PASS, `2` BLOCK (Phase 1 FAIL or Phase 2 CRITICAL/HIGH), `1` tool error.
- Fails closed on auditor errors, unaudited/unresolved files, and spec/workspace
  path escapes (symlink-safe containment).

### 2. Pre-push gate — `crossfire-gate.js`
Manifest-driven enforcement. Write `data/crossfire-manifest.json`:
```json
{ "spec": "tasks/foo-spec.md", "files": ["scripts/a.js", "scripts/b.js"] }
```
- No manifest → exit 0 (don't block unrelated pushes).
- `CROSSFIRE_SKIP=1` → logged override (fails closed if it can't log the override).
- Validates manifest shape (array of non-empty strings, no commas, in-repo workspace).
- Install the hook: point `core.hooksPath` at `scripts/hooks/`, or copy
  `scripts/hooks/pre-push` into the target repo's `.git/hooks/pre-push`.
  Override gate location with `CROSSFIRE_GATE`; audited repo with `CROSSFIRE_ROOT`.

### 3. Autonomous fix loop — `crossfire-loop.js`
```bash
node scripts/crossfire-loop.js --spec spec.md --files a.js,b.js [--workspace DIR] [--chat ID] [--no-escalate]
```
Runs audit → fix → re-audit with **no agent in the chair**:
- **Dedicated fixer**, separate from the auditors (no model grades its own fix).
- **Alternating Codex<->Opus** fixers per round — a stall-breaker (a single fixer
  retries the same failed approach; swapping models attacks from a new angle).
- **No hard round cap.** **Escalate on stall** (blocking count not decreasing two
  rounds / identical reasons twice / unappliable or empty fixer output) → notify + exit 3.
- Fixer returns Aider-style SEARCH/REPLACE blocks; apply is atomic
  (validate-all-then-write), exact+unique match, JS syntax-checked with full revert.
- **Exit codes:** `0` converged, `3` stalled+escalated, `1` fatal.
- Telegram escalation is optional: set `CROSSFIRE_TG_SCRIPT` to a sender script
  and `--chat`/`CROSSFIRE_CHAT`. Without it, the loop is console-only.
- Designed to run detached (e.g. under a guarded ops runner) so the chat lane
  regains control immediately and only gets progress/escalation pings.

### Env knobs (CODE mode)
- `CROSSFIRE_ROOT` — repo under audit (default: cwd)
- `CROSSFIRE_PORT` — gateway port (default 18789)
- `CROSSFIRE_FIXER_MODELS` — override fixer rotation (default `openclaw/market,openclaw` = Codex,Opus)
- `CROSSFIRE_TG_SCRIPT` / `CROSSFIRE_CHAT` — optional escalation messenger

---

## Static Mode (v1 — backward compatible)

For static mode, the original orchestration from v1 still works:

### Step 1 — Init
```bash
node review.js init --plan <file> --reviewer-model <m> --planner-model <m>
```

### Step 2 — Manual loop
For each round: build reviewer prompt from template, spawn reviewer, parse-round, revise plan yourself, continue.

### Step 3 — Finalize
Same as alternating mode.

---

## Integration with coding-agent

Before dispatching any plan to coding-agent that:
- Touches auth, payments, or data models
- Has 3+ implementation steps
- The user hasn't already reviewed adversarially

Run the classify gate, then cross-model-review if warranted. Only proceed if exit code 0.

---

## Roadmap (drafted, not yet implemented)
Two further dynamic-workflow patterns from Thariq's post are designed but NOT in
this version (they SPEND tokens, unlike the classify gate):
- **Pattern B — split verifier:** a separate-model agent rules each raised issue
  real / nitpick / proportionality, so the model raising issues does not also
  render the verdict. Structural fix for self-preferential bias.
- **Pattern C — pairwise tournament:** replace the absolute APPROVED verdict with
  head-to-head plan-vN vs plan-vN+1 comparison (comparative > absolute scoring).
Adopt B after measuring A; adopt C only if the verdict step remains the weak link.
See tasks/cmr-v3-code-draft.js for the drafted implementations.

---

## Provenance
v2.1 (classify gate) was itself run through this skill's own alternating review
(Opus + Codex, 2 rounds) before being applied — dogfooded. Round 1 caught that
the safety logic was prose-only and the injection markers were elided; the
revision added the concrete orchestrator gate and real untrusted-content
delimiters, then passed Round 2 APPROVED.

---

## Notes
- Workspace persists in `tasks/reviews/` — referenceable later
- `issues.json` tracks full lifecycle of all issues
- `meta.json` stores mode, models, current round, verdict, needsRevision flag, and criteria negotiation state
- `next-step` is the state machine — always call it to determine what to do
- Dedup warnings help catch semantic drift across rounds
- Models must be from different provider families (cross-provider enforcement)
- Do not silently substitute Sonnet for Opus, or another OpenAI model for Codex/GPT, and still label it adversarial review
- `--project-context` is injected into reviewer prompts for calibration
- `classify.js` is additive and read-only — `review.js` is unchanged in v2.1
- The orchestrator validation gate (references/orchestrator-validation.md) is the safety-critical half of the triage gate; implement and test it before trusting any skip
- Before a high-stakes run on a newly changed model path, do a tiny JSON-only probe first if you suspect runtime instability
