# Orchestrator validation gate (Pattern A safety-critical logic)

`classify.js` only builds the classifier prompt. ALL fail-safe guarantees live
in the orchestrator that spawns the classifier and acts on its response. This
file specifies that logic. It MUST be implemented and exercised before relying
on the triage gate to skip any review.

## Rules
- Timeout, malformed JSON, out-of-enum / missing `recommended_path` → default to
  `full-cmr` (fail open to the full panel; never silently skip).
- Only `skip` or `single-reviewer` may downgrade the panel, and only after
  explicit user confirmation. Any decline, no-response, ambiguous reply, or a
  thrown confirmation handler → `full-cmr`.

## Reference implementation

```javascript
const VALID_PATHS = new Set(['skip', 'single-reviewer', 'full-cmr']);
const CLASSIFY_TIMEOUT_MS = 30000;

// raw = classifier stdout string; timedOut = spawn exceeded CLASSIFY_TIMEOUT_MS
function resolvePath(raw, timedOut) {
  if (timedOut) return { path: 'full-cmr', reason: 'classifier timeout → full panel' };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { path: 'full-cmr', reason: `classifier JSON parse error → full panel (${e.message})` }; }
  const p = parsed && parsed.recommended_path;
  if (!VALID_PATHS.has(p)) {
    return { path: 'full-cmr', reason: `classifier path "${p}" not in allowlist → full panel` };
  }
  return { path: p, reason: parsed.reason || '(no reason given)' };
}

// Only skip/downgrade after explicit user confirmation.
// NOTE: confirmFn is wrapped in try/catch so a thrown handler fails open to full-cmr.
async function gate(raw, timedOut, confirmFn) {
  const { path, reason } = resolvePath(raw, timedOut);
  if (path === 'full-cmr') return 'full-cmr';        // safe default, no prompt
  try {
    const ok = await confirmFn(path, reason);        // surface reason, ask user
    return ok === true ? path : 'full-cmr';          // anything but explicit yes → full panel
  } catch {
    return 'full-cmr';                               // confirmation threw → full panel
  }
}
```

## Verification cases (must all pass before trusting a skip)
- Malformed JSON input → `full-cmr`.
- Out-of-enum `recommended_path` (e.g. `"yolo"`) → `full-cmr`.
- Missing `recommended_path` → `full-cmr`.
- `timedOut = true` → `full-cmr` (without parsing).
- Valid `skip`/`single-reviewer` + `confirmFn` returns `true` → that path.
- Valid `skip` + `confirmFn` returns `false`/`undefined`/throws → `full-cmr`.
