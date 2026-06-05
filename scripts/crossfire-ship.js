#!/usr/bin/env node
/**
 * Crossfire ship — fully autonomous audit→fix→converge→PUSH.
 *
 * Hands the entire job to the loop and gets the human out of the chair:
 *   1. run crossfire-loop.js (alternating Codex<->Opus fixers, no hard cap,
 *      escalate on stall) against the target files/spec
 *   2. ON CONVERGE (loop exit 0): git add the target paths, commit, push
 *   3. ON STALL (exit 3) or FATAL (exit 1): escalate, do NOT push
 *
 * Nothing is pushed unless the audit comes back clean with no changes needed
 * (i.e. the loop reached a PASS verdict). Designed to run detached.
 *
 * Usage:
 *   node scripts/crossfire-ship.js \
 *     --spec audit/spec.md \
 *     --files scripts/a.js,scripts/b.js \
 *     --workspace /path/to/repo \
 *     --git-dir /path/to/repo \
 *     --add scripts/,SKILL.md,package.json,CHANGELOG.md \
 *     --message "auto: crossfire-clean update" \
 *     [--branch main] [--chat ID] [--remote origin] [--no-push] [--no-escalate]
 *
 * Exit codes: 0 pushed (or committed with --no-push), 3 stalled, 1 fatal.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const LOOP = path.join(__dirname, "crossfire-loop.js");
const TG_SCRIPT = process.env.CROSSFIRE_TG_SCRIPT || "";

function parseArgs(argv) {
  const o = {
    spec: null, files: [], workspace: process.cwd(), gitDir: null,
    add: [], message: null, branch: null, remote: "origin",
    chat: process.env.CROSSFIRE_CHAT || "", push: true, escalate: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") o.spec = argv[++i];
    else if (a === "--files") o.files = (argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--workspace") o.workspace = path.resolve(argv[++i]);
    else if (a === "--git-dir") o.gitDir = path.resolve(argv[++i]);
    else if (a === "--add") o.add = (argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--message") o.message = argv[++i];
    else if (a === "--branch") o.branch = argv[++i];
    else if (a === "--remote") o.remote = argv[++i];
    else if (a === "--chat") o.chat = argv[++i];
    else if (a === "--no-push") o.push = false;
    else if (a === "--no-escalate") o.escalate = false;
  }
  if (!o.gitDir) o.gitDir = o.workspace;
  return o;
}

function log(m) { console.log(`[crossfire-ship] ${m}`); }

function notify(chat, text) {
  console.log(`[crossfire-ship:notify] ${text.replace(/\n/g, " | ")}`);
  if (!chat || !TG_SCRIPT) return;
  try {
    spawnSync(process.execPath, [TG_SCRIPT, chat, "--stdin"], { input: text, encoding: "utf8" });
  } catch (e) { console.error(`[crossfire-ship] notify threw: ${e.message}`); }
}

function git(gitDir, args, opts = {}) {
  return spawnSync("git", ["-C", gitDir, ...args], { encoding: "utf8", ...opts });
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.files.length) { console.error("--files required"); process.exit(1); }
  if (o.push && !o.message) { console.error("--message required to commit/push"); process.exit(1); }

  notify(o.chat, `🚢 Crossfire ship started — will fix until clean, then ${o.push ? "PUSH" : "commit"}.\nFiles: ${o.files.join(", ")}`);

  // --- 1. Hand off to the autonomous loop ---
  const loopArgs = [LOOP, "--files", o.files.join(","), "--workspace", o.workspace];
  if (o.spec) loopArgs.push("--spec", o.spec);
  if (o.chat) loopArgs.push("--chat", o.chat);
  if (!o.escalate) loopArgs.push("--no-escalate");

  log(`Running loop: node ${loopArgs.join(" ")}`);
  const loop = spawnSync("node", loopArgs, {
    cwd: o.workspace, stdio: "inherit",
    env: { ...process.env, CROSSFIRE_ROOT: o.workspace },
  });
  const code = loop.status;

  // --- 2/3. Decide based on loop outcome ---
  if (code !== 0) {
    const why = code === 3 ? "STALLED — needs a human" : "FATAL error";
    notify(o.chat, `🛑 Crossfire ship: loop ${why} (exit ${code}). NOT pushing.`);
    process.exit(code === 3 ? 3 : 1);
  }

  log("Loop converged (PASS). Proceeding to commit/push.");

  if (!o.push) {
    // Commit only.
    const a = git(o.gitDir, ["add", ...o.add]);
    if (a.status !== 0) { notify(o.chat, `🛑 git add failed: ${a.stderr}`); process.exit(1); }
    const c = git(o.gitDir, ["commit", "-m", o.message]);
    if (c.status !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) {
      notify(o.chat, `🛑 git commit failed: ${c.stderr || c.stdout}`); process.exit(1);
    }
    notify(o.chat, `✅ Crossfire ship: audit clean, committed (no push per --no-push).`);
    process.exit(0);
  }

  // --- Commit + push ---
  const branch = o.branch || (git(o.gitDir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "main").trim();

  const add = git(o.gitDir, ["add", ...o.add]);
  if (add.status !== 0) { notify(o.chat, `🛑 git add failed: ${add.stderr}`); process.exit(1); }

  const commit = git(o.gitDir, ["commit", "-m", o.message]);
  const commitOut = commit.stdout + commit.stderr;
  if (commit.status !== 0 && !/nothing to commit/.test(commitOut)) {
    notify(o.chat, `🛑 git commit failed: ${commitOut}`); process.exit(1);
  }
  const nothingToCommit = /nothing to commit/.test(commitOut);

  const push = git(o.gitDir, ["push", o.remote, branch]);
  if (push.status !== 0) {
    notify(o.chat, `🛑 Crossfire ship: audit clean + committed, but PUSH failed:\n${(push.stderr || push.stdout).slice(0, 400)}`);
    process.exit(1);
  }

  const sha = (git(o.gitDir, ["rev-parse", "--short", "HEAD"]).stdout || "").trim();
  notify(o.chat, `✅ Crossfire ship COMPLETE — audit clean, ${nothingToCommit ? "nothing new to commit, " : ""}pushed ${sha} to ${o.remote}/${branch}.`);
  process.exit(0);
}

main();
