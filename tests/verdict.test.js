#!/usr/bin/env node
/**
 * Unit tests for parseVerdict() footer/prose reconciliation.
 *
 * Focus: the phantom-FAIL stall bug. The blocking count must come from
 * ITEMIZED PROSE findings (the only thing a fixer can act on), with the footer
 * acting as a presence/finality gate. Truncation is caught separately (footer
 * goes null -> fail closed), so a present+final footer implies complete output.
 */
'use strict';

const { parseVerdict, isTransient } = require('../scripts/crossfire.js');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok  - ${name}`); }
  else { failed++; console.log(`  FAIL- ${name}`); }
}

// Helpers to build minimal phase reports with a valid final footer.
const p1Footer = (fail, warn) => `CROSSFIRE_VERDICT fail=${fail} warn=${warn}`;
const p2Footer = (crit, high) => `CROSSFIRE_VERDICT critical=${crit} high=${high}`;
const item = (label, val, txt) => `- **${label}:** ${val} — ${txt}`;

// --- 1. PHANTOM OVERCOUNT (the bug we fixed) -------------------------------
// Footer claims 1 fail, but ZERO itemized STATUS: FAIL lines. Must NOT block.
{
  const p1 = [
    item('STATUS', 'PASS', 'S-1 looks fine'),
    item('STATUS', 'WARN', 'S-2 minor'),
    p1Footer(1, 1), // footer overcounts fail
  ].join('\n');
  const p2 = [item('SEVERITY', 'LOW', 'B-1 nit'), p2Footer(0, 0)].join('\n');
  const v = parseVerdict(p1, p2);
  check('phantom footer fail (1 vs prose 0) does NOT block', v.block === false);
  check('phantom: p1Fail reported as prose value 0', v.p1Fail === 0);
  check('phantom: mismatch still flagged in reasons',
    v.reasons.some(r => /footer\/prose FAIL mismatch/.test(r)));
}

// --- 2. UNDERCOUNT PROTECTION (must NOT regress) ---------------------------
// Footer claims 0 fail, but prose has a real itemized FAIL. Must STILL block.
{
  const p1 = [
    item('STATUS', 'FAIL', 'S-3 spec violation, real finding'),
    p1Footer(0, 0), // footer undercounts (model slip)
  ].join('\n');
  const p2 = p2Footer(0, 0);
  const v = parseVerdict(p1, p2);
  check('undercount: real prose FAIL still blocks despite footer 0', v.block === true);
  check('undercount: p1Fail = prose 1', v.p1Fail === 1);
}

// --- 3. AGREEMENT: clean pass ----------------------------------------------
{
  const p1 = [item('STATUS', 'PASS', 'S-1 fine'), p1Footer(0, 0)].join('\n');
  const p2 = [item('SEVERITY', 'LOW', 'nit'), p2Footer(0, 0)].join('\n');
  const v = parseVerdict(p1, p2);
  check('clean: no findings, no block', v.block === false);
  check('clean: no mismatch reasons', !v.reasons.some(r => /mismatch/.test(r)));
}

// --- 4. AGREEMENT: real fail blocks ----------------------------------------
{
  const p1 = [item('STATUS', 'FAIL', 'S-5 real'), p1Footer(1, 0)].join('\n');
  const v = parseVerdict(p1, p2Footer(0, 0));
  check('agree: footer 1 + prose 1 blocks', v.block === true && v.p1Fail === 1);
}

// --- 5. PHASE 2 phantom HIGH (same fix, severity axis) ---------------------
{
  const p2 = [item('SEVERITY', 'LOW', 'B-1 nit'), p2Footer(0, 1)].join('\n');
  const v = parseVerdict(p1Footer(0, 0), p2);
  check('p2 phantom HIGH (footer 1 vs prose 0) does NOT block', v.block === false);
  check('p2 phantom: p2High = prose 0', v.p2High === 0);
}

// --- 6. PHASE 2 real HIGH still blocks --------------------------------------
{
  const p2 = [item('SEVERITY', 'HIGH', 'B-2 real bug'), p2Footer(0, 1)].join('\n');
  const v = parseVerdict(p1Footer(0, 0), p2);
  check('p2 real HIGH blocks', v.block === true && v.p2High === 1);
}

// --- 7. TRUNCATION: missing/non-final footer fails closed -------------------
{
  // No CROSSFIRE_VERDICT line at all (truncated mid-report).
  const p1 = item('STATUS', 'PASS', 'S-1 fine') + '\n(report cut off here';
  const v = parseVerdict(p1, p2Footer(0, 0));
  check('truncated P1 (no footer) fails closed/blocks', v.block === true);
  check('truncated: reason cites missing/non-final footer',
    v.reasons.some(r => /footer missing\/non-final/.test(r)));
}

// --- 8. Footer NOT the last line (drift) fails closed -----------------------
{
  const p1 = [p1Footer(0, 0), item('STATUS', 'FAIL', 'S-9 drifted after footer')].join('\n');
  const v = parseVerdict(p1, p2Footer(0, 0));
  check('footer not final -> blocks (drift caught by prose authority)', v.block === true);
}

// --- 9. TRANSIENT NETWORK CLASSIFICATION (auditor-leg retry, spec §2.3) ------
{
  check('EPIPE is transient', isTransient({ code: 'EPIPE', message: 'write EPIPE' }) === true);
  check('ECONNRESET is transient', isTransient({ code: 'ECONNRESET', message: 'socket hang up' }) === true);
  check('ETIMEDOUT is transient', isTransient({ code: 'ETIMEDOUT', message: '' }) === true);
  check('Gateway timeout msg is transient', isTransient({ message: 'Gateway timeout (600s)' }) === true);
  check('Auth 401 is NOT transient (deterministic)', isTransient({ message: 'Auth failed (401). Check gateway.auth.token.' }) === false);
  check('404 endpoint is NOT transient', isTransient({ message: 'Endpoint 404. Enable: ...' }) === false);
  check('JSON parse error is NOT transient', isTransient({ message: 'JSON parse error: Unexpected token' }) === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
