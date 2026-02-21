#!/usr/bin/env node
/**
 * Basic test suite for review.js — no external deps
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'review.js');
let passed = 0;
let failed = 0;
let tmpDir;

function run(args, opts = {}) {
  const { expectFail = false, allowExit1 = false } = typeof opts === 'boolean' ? { expectFail: opts } : opts;
  try {
    const out = execSync(`node ${SCRIPT} ${args}`, {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    if (expectFail) throw new Error(`Expected failure but got success: ${out}`);
    return { ok: true, stdout: out.trim(), code: 0 };
  } catch (e) {
    // Exit code 1 = REVISE (expected for non-approved rounds)
    if (allowExit1 && e.status === 1) {
      return { ok: true, stdout: (e.stdout || '').trim(), code: 1 };
    }
    if (!expectFail) throw e;
    return { ok: false, stderr: (e.stderr || '').trim(), code: e.status || 1 };
  }
}

function assert(condition, msg) {
  if (!condition) {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-test-'));
  const planPath = path.join(tmpDir, 'test-plan.md');
  fs.writeFileSync(planPath, '# Test Plan\n\nThis is a test implementation plan.\n\n## Architecture\nSimple REST API with auth.\n');
  return planPath;
}

function cleanup() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Tests ----

console.log('\n=== review.js test suite ===\n');

// Test: help
console.log('--- help ---');
{
  const r = run('--help');
  assert(r.stdout.includes('review.js'), 'help output contains script name');
  assert(r.stdout.includes('init'), 'help mentions init command');
  assert(r.stdout.includes('parse-round'), 'help mentions parse-round command');
  assert(r.stdout.includes('finalize'), 'help mentions finalize command');
  assert(r.stdout.includes('status'), 'help mentions status command');
}

// Test: init — success
console.log('\n--- init ---');
const planPath = setup();
{
  const outDir = path.join(tmpDir, 'reviews');
  const r = run(`init --plan ${planPath} --reviewer-model openai/codex --planner-model anthropic/sonnet --out ${outDir}`);
  assert(r.ok, 'init exits 0');
  assert(fs.existsSync(r.stdout), 'workspace directory created');

  const wsDir = r.stdout;
  assert(fs.existsSync(path.join(wsDir, 'meta.json')), 'meta.json created');
  assert(fs.existsSync(path.join(wsDir, 'issues.json')), 'issues.json created');
  assert(fs.existsSync(path.join(wsDir, 'changelog.md')), 'changelog.md created');
  assert(fs.existsSync(path.join(wsDir, 'plan-v1.md')), 'plan-v1.md created');

  const meta = JSON.parse(fs.readFileSync(path.join(wsDir, 'meta.json'), 'utf8'));
  assert(meta.reviewerModel === 'openai/codex', 'reviewer model stored');
  assert(meta.plannerModel === 'anthropic/sonnet', 'planner model stored');
  assert(meta.verdict === 'PENDING', 'initial verdict is PENDING');

  // Test: same-provider rejection
  console.log('\n--- init: same-provider rejection ---');
  const r2 = run(`init --plan ${planPath} --reviewer-model anthropic/opus --planner-model anthropic/sonnet --out ${outDir}`, { expectFail: true });
  assert(!r2.ok, 'same-provider init fails');
  assert(r2.code === 2, 'exits with code 2');

  // Test: parse-round
  console.log('\n--- parse-round ---');
  const respPath = path.join(tmpDir, 'response.json');
  fs.writeFileSync(respPath, JSON.stringify({
    verdict: 'REVISE',
    prior_issues: [],
    new_issues: [
      { severity: 'CRITICAL', location: 'Auth', problem: 'No rate limiting on login', fix: 'Add rate limiter' },
      { severity: 'HIGH', location: 'DB', problem: 'No input validation on queries', fix: 'Add parameterized queries' },
      { severity: 'LOW', location: 'Logging', problem: 'Verbose debug logs in prod', fix: 'Set log level via env var' },
    ],
    summary: '3 issues found, 1 critical',
  }));

  const r3 = run(`parse-round --workspace ${wsDir} --round 1 --response ${respPath}`, { allowExit1: true });
  const output = JSON.parse(r3.stdout);
  assert(output.verdict === 'REVISE', 'verdict is REVISE');
  assert(output.newIssues === 3, '3 new issues parsed');
  assert(output.blockers === 2, '2 blockers (CRITICAL + HIGH)');

  const issues = JSON.parse(fs.readFileSync(path.join(wsDir, 'issues.json'), 'utf8'));
  assert(issues.length === 3, '3 issues in tracker');
  assert(issues[0].id === 'ISS-001', 'first issue is ISS-001');
  assert(issues[0].severity === 'CRITICAL', 'first issue is CRITICAL');
  assert(issues[1].id === 'ISS-002', 'second issue is ISS-002');

  // Test: parse-round with resolution
  console.log('\n--- parse-round: round 2 with resolutions ---');
  const resp2Path = path.join(tmpDir, 'response2.json');
  fs.writeFileSync(resp2Path, JSON.stringify({
    verdict: 'APPROVED',
    prior_issues: [
      { id: 'ISS-001', status: 'resolved', evidence: 'Rate limiter added' },
      { id: 'ISS-002', status: 'resolved', evidence: 'Parameterized queries implemented' },
      { id: 'ISS-003', status: 'resolved', evidence: 'Log level configurable' },
    ],
    new_issues: [],
    summary: 'All issues resolved',
  }));

  const r4 = run(`parse-round --workspace ${wsDir} --round 2 --response ${resp2Path}`);
  const output2 = JSON.parse(r4.stdout);
  assert(output2.verdict === 'APPROVED', 'verdict is APPROVED after all resolved');
  assert(output2.blockers === 0, '0 blockers');

  // Test: finalize
  console.log('\n--- finalize ---');
  const r5 = run(`finalize --workspace ${wsDir}`);
  const finalOutput = JSON.parse(r5.stdout);
  assert(finalOutput.verdict === 'APPROVED', 'final verdict is APPROVED');
  assert(finalOutput.issuesFound === 3, '3 total issues found');
  assert(finalOutput.issuesResolved === 3, '3 issues resolved');
  assert(fs.existsSync(path.join(wsDir, 'plan-final.md')), 'plan-final.md generated');
  assert(fs.existsSync(path.join(wsDir, 'summary.json')), 'summary.json generated');

  // Test: status
  console.log('\n--- status ---');
  const r6 = run(`status --workspace ${wsDir}`);
  const status = JSON.parse(r6.stdout);
  assert(status.verdict === 'APPROVED', 'status shows APPROVED');
  assert(status.totalIssues === 3, 'status shows 3 total issues');

  // Test: dedup detection
  console.log('\n--- dedup detection ---');
  const outDir2 = path.join(tmpDir, 'reviews2');
  const r7 = run(`init --plan ${planPath} --reviewer-model openai/codex --planner-model anthropic/sonnet --out ${outDir2}`);
  const wsDir2 = r7.stdout;

  const dedupResp1 = path.join(tmpDir, 'dedup-resp1.json');
  fs.writeFileSync(dedupResp1, JSON.stringify({
    verdict: 'REVISE',
    prior_issues: [],
    new_issues: [
      { severity: 'HIGH', location: 'Auth', problem: 'No rate limiting on login endpoint allows brute force attacks', fix: 'Add rate limiter' },
    ],
    summary: '1 issue',
  }));
  run(`parse-round --workspace ${wsDir2} --round 1 --response ${dedupResp1}`, { allowExit1: true });

  const dedupResp2 = path.join(tmpDir, 'dedup-resp2.json');
  fs.writeFileSync(dedupResp2, JSON.stringify({
    verdict: 'REVISE',
    prior_issues: [{ id: 'ISS-001', status: 'still-open', evidence: 'not fixed' }],
    new_issues: [
      { severity: 'HIGH', location: 'Authentication', problem: 'No rate limiting on login endpoint allows brute force attacks to succeed', fix: 'Implement rate limiting' },
    ],
    summary: '1 new issue (likely dup)',
  }));
  const r8 = run(`parse-round --workspace ${wsDir2} --round 2 --response ${dedupResp2}`, { allowExit1: true });
  const dedupOutput = JSON.parse(r8.stdout);
  assert(dedupOutput.dedupWarnings > 0, 'dedup warning detected for similar issue');

  // Test: blocked approval (reviewer says APPROVED but blockers remain)
  console.log('\n--- blocked approval ---');
  const outDir3 = path.join(tmpDir, 'reviews3');
  const r9 = run(`init --plan ${planPath} --reviewer-model openai/codex --planner-model anthropic/sonnet --out ${outDir3}`);
  const wsDir3 = r9.stdout;

  const blockResp = path.join(tmpDir, 'block-resp.json');
  fs.writeFileSync(blockResp, JSON.stringify({
    verdict: 'REVISE',
    prior_issues: [],
    new_issues: [{ severity: 'CRITICAL', location: 'Core', problem: 'Fatal flaw', fix: 'Fix it' }],
    summary: '1 critical issue',
  }));
  run(`parse-round --workspace ${wsDir3} --round 1 --response ${blockResp}`, { allowExit1: true });

  const fakeApprove = path.join(tmpDir, 'fake-approve.json');
  fs.writeFileSync(fakeApprove, JSON.stringify({
    verdict: 'APPROVED',
    prior_issues: [{ id: 'ISS-001', status: 'still-open', evidence: 'nope' }],
    new_issues: [],
    summary: 'Approving anyway',
  }));
  const r10 = run(`parse-round --workspace ${wsDir3} --round 2 --response ${fakeApprove}`, { allowExit1: true });
  const blockOutput = JSON.parse(r10.stdout);
  assert(blockOutput.verdict === 'REVISE', 'approval blocked when CRITICAL still open');

  // Test: schema validation failure
  console.log('\n--- schema validation ---');
  const badResp = path.join(tmpDir, 'bad-resp.json');
  fs.writeFileSync(badResp, JSON.stringify({ verdict: 'MAYBE', prior_issues: 'nope', new_issues: [], summary: 123 }));
  const r11 = run(`parse-round --workspace ${wsDir3} --round 3 --response ${badResp}`, { expectFail: true });
  assert(!r11.ok, 'invalid schema rejected');
}

cleanup();

// ---- Summary ----
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
