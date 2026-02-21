#!/usr/bin/env node
/**
 * review.js — Cross-model review helper for OpenClaw cross-model-review skill
 *
 * Subcommands:
 *   init         Create a review workspace
 *   parse-round  Parse reviewer response, update issue tracker
 *   finalize     Generate plan-final.md, changelog.md, summary.json
 *   status       Print current workspace state
 *
 * Exit codes: 0=approved/ok  1=revise/unapproved  2=error
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Argument parsing — minimal, no external deps
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function die(msg, code = 2) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

function info(msg) {
  console.log(msg);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    die(`Failed to read JSON from ${filePath}: ${e.message}`);
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    die(`Cannot read file ${filePath}: ${e.message}`);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Model family detection — prevent same-provider review
// ---------------------------------------------------------------------------
const PROVIDER_FAMILIES = {
  anthropic: ['claude', 'anthropic', 'sonnet', 'haiku', 'opus'],
  openai:    ['gpt', 'openai', 'codex', 'o1', 'o3', 'davinci'],
  google:    ['gemini', 'google', 'bard', 'palm'],
  mistral:   ['mistral', 'mixtral'],
  meta:      ['llama', 'meta'],
  cohere:    ['command', 'cohere'],
};

function detectFamily(modelId) {
  const lower = modelId.toLowerCase();
  for (const [family, keywords] of Object.entries(PROVIDER_FAMILIES)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return family;
    }
  }
  return lower.split('/')[0] || 'unknown';
}

// ---------------------------------------------------------------------------
// Jaccard similarity for dedup
// ---------------------------------------------------------------------------
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return new Set(normalizeText(text).split(' ').filter(Boolean));
}

function jaccardSimilarity(a, b) {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const w of setA) { if (setB.has(w)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Issue ID generation
// ---------------------------------------------------------------------------
function nextIssueId(issues) {
  const nums = issues.map(iss => {
    const m = iss.id.match(/ISS-(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const max = nums.length ? Math.max(...nums) : 0;
  return `ISS-${String(max + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// Review schema validation
// ---------------------------------------------------------------------------
const VALID_VERDICTS  = new Set(['APPROVED', 'REVISE']);
const VALID_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
const VALID_STATUSES  = new Set(['resolved', 'still-open', 'regressed', 'not-applicable']);

function validateReviewResponse(obj) {
  const errors = [];
  if (!VALID_VERDICTS.has(obj.verdict)) {
    errors.push(`verdict must be APPROVED or REVISE, got: ${obj.verdict}`);
  }
  if (!Array.isArray(obj.prior_issues)) {
    errors.push('prior_issues must be an array');
  } else {
    obj.prior_issues.forEach((pi, i) => {
      if (!pi.id || typeof pi.id !== 'string') errors.push(`prior_issues[${i}].id missing`);
      if (!VALID_STATUSES.has(pi.status)) errors.push(`prior_issues[${i}].status invalid: ${pi.status}`);
    });
  }
  if (!Array.isArray(obj.new_issues)) {
    errors.push('new_issues must be an array');
  } else {
    obj.new_issues.forEach((ni, i) => {
      if (!VALID_SEVERITIES.has(ni.severity)) errors.push(`new_issues[${i}].severity invalid: ${ni.severity}`);
      if (!ni.location) errors.push(`new_issues[${i}].location missing`);
      if (!ni.problem)  errors.push(`new_issues[${i}].problem missing`);
      if (!ni.fix)      errors.push(`new_issues[${i}].fix missing`);
    });
  }
  if (typeof obj.summary !== 'string') {
    errors.push('summary must be a string');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Parse reviewer response text → JSON, stripping fences if needed
// ---------------------------------------------------------------------------
function extractJson(raw) {
  // Try direct parse first
  try {
    return JSON.parse(raw.trim());
  } catch (_) {}

  // Strip markdown fences
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (_) {}
  }

  // Find first { ... } block
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {}
  }

  throw new Error('Could not extract valid JSON from reviewer response');
}

// ---------------------------------------------------------------------------
// Workspace state helpers
// ---------------------------------------------------------------------------
function getWorkspaceMeta(wsDir) {
  const metaPath = path.join(wsDir, 'meta.json');
  if (!fs.existsSync(metaPath)) die(`Not a review workspace: ${wsDir}`);
  return readJson(metaPath);
}

function getIssues(wsDir) {
  const p = path.join(wsDir, 'issues.json');
  return fs.existsSync(p) ? readJson(p) : [];
}

function saveIssues(wsDir, issues) {
  writeJson(path.join(wsDir, 'issues.json'), issues);
}

function getOpenBlockers(issues) {
  return issues.filter(iss =>
    (iss.severity === 'CRITICAL' || iss.severity === 'HIGH') &&
    (iss.status === 'open' || iss.status === 'still-open' || iss.status === 'regressed')
  );
}

// ---------------------------------------------------------------------------
// COMMAND: init
// ---------------------------------------------------------------------------
function cmdInit(args) {
  const planPath      = args['plan'];
  const reviewerModel = args['reviewer-model'];
  const plannerModel  = args['planner-model'];
  const outBase       = args['out'] || path.join(process.cwd(), 'tasks/reviews');

  if (!planPath)      die('--plan <file> is required');
  if (!reviewerModel) die('--reviewer-model <model> is required');
  if (!plannerModel)  die('--planner-model <model> is required');

  if (!fs.existsSync(planPath)) die(`Plan file not found: ${planPath}`);

  const rFamily = detectFamily(reviewerModel);
  const pFamily = detectFamily(plannerModel);
  if (rFamily === pFamily && rFamily !== 'unknown') {
    die(`Reviewer and planner are from the same provider family (${rFamily}). Cross-provider review required.`);
  }

  ensureDir(outBase);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const uuid      = Math.random().toString(36).slice(2, 10);
  const wsDir     = path.join(outBase, `${timestamp}-${uuid}`);
  ensureDir(wsDir);

  // Copy plan as v1
  const planContent = readFile(planPath);
  fs.writeFileSync(path.join(wsDir, 'plan-v1.md'), planContent, 'utf8');

  // Write meta
  const meta = {
    created:       new Date().toISOString(),
    reviewerModel,
    plannerModel,
    reviewerFamily: rFamily,
    plannerFamily:  pFamily,
    maxRounds:      5,
    currentRound:   0,
    verdict:        'PENDING',
    wsDir,
  };
  writeJson(path.join(wsDir, 'meta.json'), meta);

  // Initialize issue tracker and changelog
  writeJson(path.join(wsDir, 'issues.json'), []);
  fs.writeFileSync(path.join(wsDir, 'changelog.md'), `# Review Changelog\n\nWorkspace: ${wsDir}\nStarted: ${meta.created}\nReviewer: ${reviewerModel}\nPlanner: ${plannerModel}\n\n`, 'utf8');

  info(wsDir);
  return 0;
}

// ---------------------------------------------------------------------------
// COMMAND: parse-round
// ---------------------------------------------------------------------------
function cmdParseRound(args) {
  const wsDir    = args['workspace'];
  const round    = parseInt(args['round'], 10);
  const respPath = args['response'];

  if (!wsDir)    die('--workspace <dir> is required');
  if (!round || isNaN(round)) die('--round <n> is required');
  if (!respPath) die('--response <file> is required');

  if (!fs.existsSync(wsDir))    die(`Workspace not found: ${wsDir}`);
  if (!fs.existsSync(respPath)) die(`Response file not found: ${respPath}`);

  const raw = readFile(respPath);
  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (e) {
    die(`JSON extraction failed: ${e.message}`);
  }

  const schemaErrors = validateReviewResponse(parsed);
  if (schemaErrors.length > 0) {
    console.error('Schema validation errors:');
    schemaErrors.forEach(e => console.error(`  - ${e}`));
    die(`Response failed schema validation (${schemaErrors.length} errors)`);
  }

  const issues = getIssues(wsDir);

  // ---- Process prior issue status updates ----
  const priorUpdateMap = {};
  for (const pu of (parsed.prior_issues || [])) {
    priorUpdateMap[pu.id] = pu;
  }

  for (const iss of issues) {
    if (priorUpdateMap[iss.id]) {
      const update = priorUpdateMap[iss.id];
      iss.status = update.status;
      if (update.status === 'resolved' || update.status === 'not-applicable') {
        iss.round_resolved = round;
      }
      iss.last_evidence = update.evidence || null;
    }
  }

  // ---- Dedup check on new issues ----
  const openIssues = issues.filter(i => i.status === 'open' || i.status === 'still-open' || i.status === 'regressed');
  const dedupWarnings = [];
  const assignedNewIssues = [];

  for (let idx = 0; idx < (parsed.new_issues || []).length; idx++) {
    const ni = parsed.new_issues[idx];
    let maxSim = 0;
    let dupOf  = null;

    for (const open of openIssues) {
      const sim = jaccardSimilarity(ni.problem, open.problem);
      if (sim > maxSim) {
        maxSim = sim;
        dupOf  = open.id;
      }
    }

    if (maxSim >= 0.6) {
      dedupWarnings.push({
        new_issue_index:      idx,
        possible_duplicate_of: dupOf,
        similarity:            Math.round(maxSim * 100) / 100,
        note: `New issue overlaps significantly with ${dupOf}. Confirm if distinct.`,
      });
    }

    // Assign stable ID and add to issues regardless (human reviews dedup warnings)
    const newId = nextIssueId([...issues, ...assignedNewIssues]);
    const newIssue = {
      id:             newId,
      severity:       ni.severity,
      location:       ni.location,
      problem:        ni.problem,
      fix:            ni.fix,
      status:         'open',
      round_found:    round,
      round_resolved: null,
      last_evidence:  null,
    };
    assignedNewIssues.push(newIssue);
    issues.push(newIssue);
  }

  saveIssues(wsDir, issues);

  // ---- Approval gate ----
  const blockers    = getOpenBlockers(issues);
  let finalVerdict  = parsed.verdict;

  if (finalVerdict === 'APPROVED' && blockers.length > 0) {
    console.error(`WARNING: Reviewer said APPROVED but ${blockers.length} CRITICAL/HIGH issue(s) are still open.`);
    console.error('Overriding verdict to REVISE.');
    finalVerdict = 'REVISE';
  }

  // ---- Save round output ----
  const roundOutput = {
    round,
    verdict:       finalVerdict,
    reviewVerdict: parsed.verdict,
    summary:       parsed.summary,
    newIssues:     assignedNewIssues.map(i => i.id),
    dedupWarnings,
    blockers:      blockers.map(i => i.id),
  };
  writeJson(path.join(wsDir, `round-${round}-output.json`), roundOutput);

  // ---- Update meta ----
  const meta = getWorkspaceMeta(wsDir);
  meta.currentRound = round;
  meta.verdict = finalVerdict;
  writeJson(path.join(wsDir, 'meta.json'), meta);

  // ---- Append to changelog ----
  const openCount     = issues.filter(i => i.status === 'open' || i.status === 'still-open').length;
  const resolvedCount = issues.filter(i => i.status === 'resolved').length;
  const changeEntry   = [
    `\n## Round ${round} — ${new Date().toISOString()}`,
    `Verdict: **${finalVerdict}**`,
    `Summary: ${parsed.summary}`,
    `New issues: ${assignedNewIssues.length} (${assignedNewIssues.map(i => `${i.id} ${i.severity}`).join(', ') || 'none'})`,
    `Dedup warnings: ${dedupWarnings.length}`,
    `Open blockers: ${blockers.length}`,
    `Total open: ${openCount} | Resolved: ${resolvedCount}`,
    '',
  ].join('\n');
  fs.appendFileSync(path.join(wsDir, 'changelog.md'), changeEntry, 'utf8');

  // ---- Print result ----
  info(JSON.stringify({
    verdict: finalVerdict,
    round,
    newIssues: assignedNewIssues.length,
    dedupWarnings: dedupWarnings.length,
    blockers: blockers.length,
    dedupWarningDetails: dedupWarnings,
  }, null, 2));

  return finalVerdict === 'APPROVED' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// COMMAND: finalize
// ---------------------------------------------------------------------------
function cmdFinalize(args) {
  const wsDir          = args['workspace'];
  const overrideReason = args['override-reason'];
  const ciForce        = !!args['ci-force'];

  if (!wsDir) die('--workspace <dir> is required');
  if (!fs.existsSync(wsDir)) die(`Workspace not found: ${wsDir}`);

  const meta   = getWorkspaceMeta(wsDir);
  const issues = getIssues(wsDir);
  const blockers = getOpenBlockers(issues);

  let forceApproveLog = null;

  if (blockers.length > 0) {
    if (!overrideReason) {
      die(
        `Cannot finalize: ${blockers.length} CRITICAL/HIGH issue(s) still open (${blockers.map(i => i.id).join(', ')}).\n` +
        'Use --override-reason "text" to force-approve.'
      );
    }

    if (overrideReason.length < 10) {
      die('--override-reason must be at least 10 characters.');
    }

    const isTTY = process.stdin.isTTY && process.stdout.isTTY;

    if (isTTY && !ciForce) {
      // Interactive confirmation
      const { execSync } = require('child_process');
      const warning = [
        '',
        '⚠️  FORCE APPROVE: This will bypass unresolved CRITICAL/HIGH issues.',
        `Unresolved: ${blockers.map(i => `${i.id}(${i.severity})`).join(', ')}`,
        `Override reason: "${overrideReason}"`,
        'Type CONFIRM to proceed, or Ctrl-C to abort:',
        '',
      ].join('\n');
      process.stderr.write(warning);

      let input = '';
      try {
        // Read one line from TTY
        input = execSync('read -r line && echo "$line"', { stdio: ['inherit', 'pipe', 'inherit'], shell: true })
          .toString().trim();
      } catch (_) {}

      if (input !== 'CONFIRM') {
        die('Force-approve aborted (did not receive CONFIRM).', 1);
      }
    } else if (!isTTY || ciForce) {
      // Non-interactive: require both --override-reason AND --ci-force
      if (!ciForce) {
        die(
          'Force-approve in non-interactive mode requires both --override-reason and --ci-force.',
          2
        );
      }
    }

    forceApproveLog = {
      actor:             process.env.USER || process.env.CI_ACTOR || 'unknown',
      reason:            overrideReason,
      timestamp:         new Date().toISOString(),
      unresolved_issues: blockers.map(i => i.id),
      tty_confirmed:     (process.stdin.isTTY && process.stdout.isTTY && !ciForce),
      ci_force:          ciForce,
    };

    // Mark blockers as force-approved
    for (const iss of issues) {
      if (blockers.find(b => b.id === iss.id)) {
        iss.status = 'force-approved';
        iss.round_resolved = meta.currentRound;
      }
    }
    saveIssues(wsDir, issues);
  }

  // ---- Find latest plan version ----
  const planVersions = fs.readdirSync(wsDir)
    .filter(f => /^plan-v\d+\.md$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/(\d+)/)[1], 10);
      const nb = parseInt(b.match(/(\d+)/)[1], 10);
      return na - nb;
    });

  if (planVersions.length === 0) die('No plan versions found in workspace.');
  const latestPlan = readFile(path.join(wsDir, planVersions[planVersions.length - 1]));

  // plan-final.md — clean copy without review comments
  const finalPlan = latestPlan
    .replace(/<!--[\s\S]*?-->/g, '')   // strip HTML comments
    .replace(/\n{3,}/g, '\n\n')        // collapse extra blank lines
    .trim() + '\n';
  fs.writeFileSync(path.join(wsDir, 'plan-final.md'), finalPlan, 'utf8');

  // ---- Summary ----
  const totalFound    = issues.length;
  const totalResolved = issues.filter(i => ['resolved', 'not-applicable', 'force-approved'].includes(i.status)).length;
  const bySeverity    = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const iss of issues) {
    const key = iss.severity.toLowerCase();
    if (key in bySeverity) bySeverity[key]++;
  }

  const summary = {
    rounds:           meta.currentRound,
    plannerModel:     meta.plannerModel,
    reviewerModel:    meta.reviewerModel,
    totalIssuesFound: totalFound,
    issuesBySeverity: bySeverity,
    issuesResolved:   totalResolved,
    issuesUnresolved: totalFound - totalResolved,
    finalVerdict:     blockers.length > 0 && forceApproveLog ? 'FORCE_APPROVED' : 'APPROVED',
    completedAt:      new Date().toISOString(),
    force_approve_log: forceApproveLog,
  };
  writeJson(path.join(wsDir, 'summary.json'), summary);

  // ---- Finalize changelog ----
  const finalEntry = [
    `\n## FINAL — ${summary.completedAt}`,
    `Verdict: **${summary.finalVerdict}**`,
    `Rounds: ${summary.rounds}`,
    `Issues found: ${totalFound} | Resolved: ${totalResolved} | Unresolved: ${summary.issuesUnresolved}`,
    forceApproveLog ? `Force-approved by: ${forceApproveLog.actor} — "${forceApproveLog.reason}"` : '',
    '',
  ].filter(l => l !== undefined).join('\n');
  fs.appendFileSync(path.join(wsDir, 'changelog.md'), finalEntry, 'utf8');

  // Update meta
  meta.verdict = summary.finalVerdict;
  meta.completedAt = summary.completedAt;
  writeJson(path.join(wsDir, 'meta.json'), meta);

  info(JSON.stringify({
    verdict:        summary.finalVerdict,
    planFinal:      path.join(wsDir, 'plan-final.md'),
    summaryJson:    path.join(wsDir, 'summary.json'),
    changelogMd:    path.join(wsDir, 'changelog.md'),
    issuesJson:     path.join(wsDir, 'issues.json'),
    rounds:         summary.rounds,
    issuesFound:    totalFound,
    issuesResolved: totalResolved,
    forceApproved:  !!forceApproveLog,
  }, null, 2));

  return 0;
}

// ---------------------------------------------------------------------------
// COMMAND: status
// ---------------------------------------------------------------------------
function cmdStatus(args) {
  const wsDir = args['workspace'];
  if (!wsDir) die('--workspace <dir> is required');
  if (!fs.existsSync(wsDir)) die(`Workspace not found: ${wsDir}`);

  const meta   = getWorkspaceMeta(wsDir);
  const issues = getIssues(wsDir);
  const open   = issues.filter(i => i.status === 'open' || i.status === 'still-open' || i.status === 'regressed');
  const resolved = issues.filter(i => ['resolved', 'not-applicable', 'force-approved'].includes(i.status));
  const blockers = getOpenBlockers(issues);

  const out = {
    workspace:     wsDir,
    verdict:       meta.verdict,
    currentRound:  meta.currentRound,
    reviewerModel: meta.reviewerModel,
    plannerModel:  meta.plannerModel,
    totalIssues:   issues.length,
    openIssues:    open.length,
    resolvedIssues: resolved.length,
    blockers:      blockers.map(i => ({ id: i.id, severity: i.severity, problem: i.problem })),
    allIssues:     issues.map(i => ({
      id:       i.id,
      severity: i.severity,
      status:   i.status,
      location: i.location,
      problem:  i.problem.slice(0, 80) + (i.problem.length > 80 ? '...' : ''),
    })),
  };

  info(JSON.stringify(out, null, 2));
  return meta.verdict === 'APPROVED' || meta.verdict === 'FORCE_APPROVED' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
function printHelp() {
  const text = `
review.js — Cross-model review helper

Usage: node review.js <command> [options]

Commands:
  init           Create a review workspace
  parse-round    Parse a reviewer response, update issue tracker
  finalize       Generate plan-final.md, changelog.md, summary.json
  status         Print current workspace state

Global options:
  --help         Show this help

init options:
  --plan <file>            Path to plan file (required)
  --reviewer-model <m>     Reviewer model identifier (required)
  --planner-model <m>      Planner model identifier (required)
  --out <dir>              Output base directory (default: tasks/reviews)

parse-round options:
  --workspace <dir>        Path to review workspace (required)
  --round <n>              Round number (required)
  --response <file>        Path to raw reviewer response file (required)

finalize options:
  --workspace <dir>        Path to review workspace (required)
  --override-reason <s>    Reason for force-approving with open issues (min 10 chars)
  --ci-force               Required in non-TTY mode when using --override-reason

status options:
  --workspace <dir>        Path to review workspace (required)

Exit codes:
  0   Approved / OK
  1   Revise / Unapproved
  2   Error (parse failure, bad flags, etc.)

Examples:
  node review.js init --plan /tmp/plan.md --reviewer-model openai/gpt-4 --planner-model anthropic/claude-sonnet-4-6
  node review.js parse-round --workspace tasks/reviews/2025-01-01T00-00-00-abc123 --round 1 --response /tmp/resp.json
  node review.js finalize --workspace tasks/reviews/2025-01-01T00-00-00-abc123
  node review.js status --workspace tasks/reviews/2025-01-01T00-00-00-abc123
`.trim();
  console.log(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd  = args._[0];

  if (!cmd || args['help']) {
    printHelp();
    process.exit(0);
  }

  let exitCode;
  switch (cmd) {
    case 'init':        exitCode = cmdInit(args); break;
    case 'parse-round': exitCode = cmdParseRound(args); break;
    case 'finalize':    exitCode = cmdFinalize(args); break;
    case 'status':      exitCode = cmdStatus(args); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }

  process.exit(exitCode || 0);
}

main();
