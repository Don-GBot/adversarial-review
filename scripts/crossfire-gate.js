#!/usr/bin/env node
/**
 * Crossfire gate — pre-push enforcement wrapper.
 *
 * Reads a manifest (default: data/crossfire-manifest.json) that the build step
 * writes, describing what to audit:
 *   { "spec": "tasks/foo-spec.md", "files": ["scripts/a.js","scripts/b.js"] }
 *
 * Behavior:
 *   - No manifest        -> exit 0 (nothing staged for audit; don't block).
 *   - CROSSFIRE_SKIP=1   -> exit 0 but log a loud override notice.
 *   - Manifest present   -> run crossfire.js; propagate its exit code.
 *
 * Crossfire exit codes: 0 PASS, 2 BLOCK (findings), 1 tool/usage error.
 * This wrapper fails closed: a tool error (1) also blocks.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// ROOT = the repository being audited (cwd at pre-push time), NOT the skill dir.
// The manifest, data/ logs, and audited files all live in the target repo.
const ROOT = process.env.CROSSFIRE_ROOT ? path.resolve(process.env.CROSSFIRE_ROOT) : process.cwd();
// CROSSFIRE_JS = sibling auditor, resolved by this script's own location so it
// works regardless of cwd or where the skill is installed.
const CROSSFIRE_JS = path.join(__dirname, "crossfire.js");
const MANIFEST_OVERRIDDEN = !!process.env.CROSSFIRE_MANIFEST;
const MANIFEST = MANIFEST_OVERRIDDEN
  ? path.resolve(ROOT, process.env.CROSSFIRE_MANIFEST)
  : path.join(ROOT, "data", "crossfire-manifest.json");

function log(msg) { console.error(`[crossfire-gate] ${msg}`); }

// Pre-push diff awareness. A static manifest means "these files require audit",
// but auditing them on EVERY push (including unrelated commits / automated backup
// crons) is intolerable: each run is a multi-minute cross-model audit. So we only
// audit when the commits actually being pushed touch a manifest file.
//
// git feeds pre-push hooks ref updates on stdin, one per line:
//   <local_ref> <local_sha> <remote_ref> <remote_sha>
// We diff <remote_sha>..<local_sha> per updated ref and union the changed paths.
// FAIL-SAFE: if we cannot bound the diff (no stdin / new remote branch / git
// error / interactive run), we return null and the caller audits conservatively.
// We never SKIP on uncertainty — only on a concrete "nothing relevant changed".
const ZERO_SHA = /^0+$/;
function readPrePushStdin() {
  try {
    if (process.stdin.isTTY) return null; // interactive: no push payload
    return fs.readFileSync(0, "utf8");
  } catch {
    return null; // unreadable -> conservative (audit)
  }
}
function changedFilesForPush(root) {
  const raw = readPrePushStdin();
  if (raw === null) return null;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null; // no ref data -> conservative audit
  const changed = new Set();
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const localSha = parts[1];
    const remoteSha = parts[3];
    if (!localSha || ZERO_SHA.test(localSha)) continue; // branch delete: nothing to push-audit
    if (!remoteSha || ZERO_SHA.test(remoteSha)) return null; // new remote branch: can't bound -> audit
    const r = spawnSync("git", ["diff", "--name-only", `${remoteSha}..${localSha}`], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) return null; // git failed -> conservative audit
    r.stdout.split("\n").map((s) => s.trim()).filter(Boolean).forEach((f) => changed.add(f));
  }
  return changed; // concrete set (possibly empty = nothing changed in pushed range)
}

// B-2: a stale/wrong CROSSFIRE_ROOT must not silently redirect the gate away
// from the repo actually being pushed. If ROOT was overridden to somewhere other
// than cwd, and cwd has its own pending default manifest, fail closed rather than
// let the override skip the real audit.
if (process.env.CROSSFIRE_ROOT && !MANIFEST_OVERRIDDEN) {
  const cwdManifest = path.join(process.cwd(), "data", "crossfire-manifest.json");
  let rootReal = ROOT, cwdReal = process.cwd();
  try { rootReal = fs.realpathSync(ROOT); } catch { /* keep raw */ }
  try { cwdReal = fs.realpathSync(process.cwd()); } catch { /* keep raw */ }
  if (rootReal !== cwdReal && fs.existsSync(cwdManifest) && !fs.existsSync(MANIFEST)) {
    log(`❌ CROSSFIRE_ROOT=${rootReal} has no manifest but cwd (${cwdReal}) has a pending audit manifest — failing closed.`);
    process.exit(1);
  }
  log(`effective ROOT=${rootReal} (cwd=${cwdReal})`);
}

// Containment applies to BOTH the default manifest AND an explicit
// CROSSFIRE_MANIFEST override: an override pointing outside the repo (e.g.
// /tmp/empty.json) must not silently replace the repo's real pending manifest
// and let the push through. Fail closed if the resolved manifest is outside ROOT.
if (fs.existsSync(MANIFEST)) {
  let manifestReal = MANIFEST, rootReal = ROOT;
  try { manifestReal = fs.realpathSync(MANIFEST); } catch { /* existsSync already checked */ }
  try { rootReal = fs.realpathSync(ROOT); } catch { /* fall through */ }
  if (manifestReal !== rootReal && !manifestReal.startsWith(rootReal + path.sep)) {
    log(`❌ Manifest (${manifestReal}) resolves outside the repo — failing closed.`);
    process.exit(1);
  }
}

if (process.env.CROSSFIRE_SKIP === "1") {
  log("⚠️  OVERRIDE: CROSSFIRE_SKIP=1 set — audit gate bypassed. This is logged.");
  // The override must be auditable. If we cannot record it, fail closed so the
  // "cannot be silently skipped" guarantee holds.
  try {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.appendFileSync(
      path.join(ROOT, "data", "crossfire-skips.log"),
      `${new Date().toISOString()} skip override (CROSSFIRE_SKIP=1)\n`
    );
  } catch (e) {
    log(`❌ Could not record skip override (${e.message}) — failing closed.`);
    process.exit(1);
  }
  process.exit(0);
}

if (!fs.existsSync(MANIFEST)) {
  // An explicit override that points at a non-existent file is almost certainly
  // a misconfiguration (typo) — fail closed rather than silently skip the audit.
  if (MANIFEST_OVERRIDDEN) {
    log(`❌ CROSSFIRE_MANIFEST set but not found at ${MANIFEST} — failing closed.`);
    process.exit(1);
  }
  // Default manifest absent: nothing flagged for audit — don't block unrelated pushes.
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
} catch (e) {
  log(`❌ Manifest unreadable (${e.message}) — failing closed.`);
  process.exit(1);
}

// Distinguish "no files key" (nothing to audit) from a malformed shape.
// A string like "scripts/a.js" must NOT silently collapse to an empty list
// and bypass the gate — fail closed on any present-but-non-array value.
if (manifest.files !== undefined && !Array.isArray(manifest.files)) {
  log(`❌ Manifest "files" is ${typeof manifest.files}, expected an array — failing closed.`);
  process.exit(1);
}
const files = Array.isArray(manifest.files) ? manifest.files : [];
if (!files.length) {
  log("Manifest has no files — nothing to audit, allowing push.");
  process.exit(0);
}

// Every entry must be a non-empty string. null/{}/""/whitespace would coerce
// into bogus paths that crossfire silently skips — reject and fail closed.
const badEntry = files.find((f) => typeof f !== "string" || f.trim() === "");
if (badEntry !== undefined) {
  log(`❌ Manifest "files" has an invalid entry (${JSON.stringify(badEntry)}) — expected non-empty strings, failing closed.`);
  process.exit(1);
}

// crossfire.js receives --files as a comma-joined string, so a comma in a path
// would be split into two wrong paths. Reject rather than silently mis-audit.
const commaPath = files.find((f) => f.includes(","));
if (commaPath) {
  log(`❌ Manifest file path contains a comma ("${commaPath}") — unsupported, failing closed.`);
  process.exit(1);
}

// spec/workspace, if present, must be non-empty strings — a truthy non-string
// (object/number) would coerce to a bogus arg like "[object Object]".
for (const key of ["spec", "workspace"]) {
  if (manifest[key] !== undefined && (typeof manifest[key] !== "string" || manifest[key].trim() === "")) {
    log(`❌ Manifest "${key}" must be a non-empty string — failing closed.`);
    process.exit(1);
  }
}

// workspace must stay inside the repo: a manifest must not redirect the audit
// at an unrelated tree (e.g. /tmp/fake-repo) and report success.
if (manifest.workspace) {
  const wsAbs = path.resolve(ROOT, manifest.workspace);
  let wsReal = wsAbs, rootReal = ROOT;
  try { wsReal = fs.realpathSync(wsAbs); } catch { /* fall through */ }
  try { rootReal = fs.realpathSync(ROOT); } catch { /* fall through */ }
  if (wsReal !== rootReal && !wsReal.startsWith(rootReal + path.sep)) {
    log(`❌ Manifest "workspace" (${wsReal}) is outside the repo — failing closed.`);
    process.exit(1);
  }
}

// Diff gate: only run the (expensive) audit when this push actually touches an
// audited file. Conservative fallback (null) audits anyway, preserving the
// "can't be silently skipped" guarantee.
const changed = changedFilesForPush(ROOT);
if (changed !== null) {
  // git diff yields ROOT-relative paths, but manifest `files` are interpreted by
  // crossfire.js relative to `workspace` (default ROOT). Normalize each audited
  // file to a ROOT-relative path before matching, or a workspace'd manifest
  // (files=["a.js"], workspace="src") would never match git's "src/a.js" and the
  // gate would silently skip a real change. Use forward slashes (git's format).
  const wsRel = manifest.workspace ? path.relative(ROOT, path.resolve(ROOT, manifest.workspace)) : "";
  const toRootRel = (f) => path.join(wsRel, f).split(path.sep).join("/");
  const touched = files.filter((f) => changed.has(toRootRel(f)));
  if (!touched.length) {
    log(`No audited files changed in this push (${changed.size} file(s) changed, none in manifest) — allowing.`);
    process.exit(0);
  }
  log(`Audited file(s) changed in this push (${touched.join(", ")}) — running crossfire.`);
} else {
  log("Could not bound the push diff — auditing the manifest conservatively.");
}

const args = [CROSSFIRE_JS, "--files", files.join(",")];
if (manifest.spec) { args.push("--spec", manifest.spec); }
if (manifest.workspace) { args.push("--workspace", manifest.workspace); }

log(`Running crossfire on ${files.length} file(s)${manifest.spec ? " vs spec " + manifest.spec : ""}...`);
const res = spawnSync("node", args, { cwd: ROOT, stdio: "inherit" });

if (res.error) {
  log(`❌ Failed to launch crossfire: ${res.error.message} — failing closed.`);
  process.exit(1);
}
// Propagate crossfire's exit code (0 pass, 2 block, 1 error).
process.exit(res.status === null ? 1 : res.status);
