/**
 * src/jev/cli.ts
 * Run a continuous control test from the command line.
 *
 *   npm run jev:build
 *   export TYPESAFE_API_KEY=...
 *   node dist/jev/src/jev/cli.js --pack strong
 *   node dist/jev/src/jev/cli.js --pack weak --out report-weak.json
 *   node dist/jev/src/jev/cli.js --replay report-strong.json --pass-at 0.6
 *
 * One request evaluates every control and every element in the library. Cost and
 * latency are printed on every run, because both are load-bearing: at roughly a
 * tenth of a cent per thousand assertions, continuous testing stops being a
 * sampling exercise.
 *
 * `--replay` re-applies policy to a saved report without calling the API. The
 * probabilities are already paid for, so changing a threshold or the combination
 * rule is free and instant — which is the practical difference between typed
 * probabilities and generated prose.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ASSERTION_LIBRARY_VERSION,
  buildControlSpecs,
  buildQuestionMap,
} from './control-assertions';
import { DEFAULT_COMBINE_RULE, DEFAULT_THRESHOLDS, assess, replay } from './control-tester';
import { AssessmentReport, CombineRule, EvidencePack, RoutingThresholds, Verdict } from './types';

interface CliArgs {
  pack: string;
  out?: string;
  replayFrom?: string;
  thresholds: Partial<RoutingThresholds>;
  combine?: CombineRule;
  json: boolean;
  listAssertions: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { pack: 'strong', thresholds: {}, json: false, listAssertions: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--pack':
        args.pack = next();
        break;
      case '--out':
        args.out = next();
        break;
      case '--replay':
        args.replayFrom = next();
        break;
      case '--pass-at':
        args.thresholds.passAt = Number(next());
        break;
      case '--fail-at':
        args.thresholds.failAt = Number(next());
        break;
      case '--evidence-floor':
        args.thresholds.evidenceFloor = Number(next());
        break;
      case '--confidence-floor':
        args.thresholds.confidenceFloor = Number(next());
        break;
      case '--combine': {
        const rule = next();
        if (rule !== 'all' && rule !== 'mean') throw new Error(`--combine must be all or mean`);
        args.combine = rule;
        break;
      }
      case '--json':
        args.json = true;
        break;
      case '--list-assertions':
        args.listAssertions = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
        args.pack = arg;
    }
  }

  return args;
}

function samplesDir(): string {
  return path.resolve(process.cwd(), 'src/jev/samples');
}

function resolvePackPath(pack: string): string {
  if (fs.existsSync(pack)) return path.resolve(pack);
  const bundled = path.join(samplesDir(), `${pack}.json`);
  if (fs.existsSync(bundled)) return bundled;
  const available = fs.existsSync(samplesDir())
    ? fs
        .readdirSync(samplesDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .join(', ')
    : 'none found';
  throw new Error(`Evidence pack "${pack}" not found. Pass a file path or one of: ${available}`);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

const VERDICT_MARK: Record<Verdict, string> = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  ESCALATE: 'ESCALATE',
  INSUFFICIENT_EVIDENCE: 'NO-EVIDENCE',
};

function printReport(report: AssessmentReport, pack: EvidencePack, title: string): void {
  console.log('');
  console.log(`${title} — ${report.packName}  (${pack.institution.name}, ${pack.institution.size})`);
  console.log(
    `Window ${pack.institution.assessmentWindow.from} → ${pack.institution.assessmentWindow.to}  ·  ` +
      `evidence records: ${pack.records.length}  ·  assertion library v${report.assertionLibraryVersion}  ·  ` +
      `combine rule: ${report.combineRule}`,
  );
  console.log('');
  console.log(
    pad('CONTROL', 10) +
      pad('FRAMEWORK', 20) +
      padStart('EVID', 6) +
      padStart('MET', 6) +
      padStart('MAT', 6) +
      padStart('CONF', 6) +
      '  VERDICT',
  );
  console.log('-'.repeat(78));

  for (const control of report.controls) {
    console.log(
      pad(control.controlId, 10) +
        pad(control.framework, 20) +
        padStart(control.evidenceSupplied.toFixed(2), 6) +
        padStart(control.controlMet.toFixed(2), 6) +
        padStart(control.maturity.toFixed(2), 6) +
        padStart(control.confidence.toFixed(2), 6) +
        '  ' +
        VERDICT_MARK[control.verdict],
    );
  }

  const attention = report.controls.filter(
    (c) => c.verdict === 'FAIL' || c.verdict === 'INSUFFICIENT_EVIDENCE' || c.verdict === 'ESCALATE',
  );
  if (attention.length > 0) {
    console.log('');
    console.log('Where the evidence is thin (weakest element per control)');
    for (const control of attention) {
      const weakest = control.elements.find((e) => e.id === control.weakestElementId);
      console.log(
        `  ${pad(VERDICT_MARK[control.verdict], 12)} ${control.controlId}  ${control.name}`,
      );
      if (weakest) {
        console.log(`               ${weakest.key} @ ${weakest.probability.toFixed(2)} — ${weakest.requirement}`);
      }
    }
  }

  const s = report.summary;
  const stale = report.controls.filter(
    (c) => c.windowCoverage.outsideWindow > 0 || c.windowCoverage.undated > 0,
  );
  console.log('');
  console.log(
    `Summary  pass ${s.pass}  ·  fail ${s.fail}  ·  escalate ${s.escalate}  ·  ` +
      `no-evidence ${s.insufficientEvidence}  ·  mean maturity ${s.meanMaturity}/4`,
  );
  console.log(
    `Elements ${s.elementsBelowPass} of ${s.elementCount} read below the ${report.thresholds.passAt} pass mark`,
  );
  console.log(
    `Recency  ${stale.length} of ${report.controls.length} controls rely on records dated outside the window ` +
      `or undated (checked in code, not by the model)`,
  );
  console.log(
    `Cost     ${report.assertionCount} assertions in 1 request  ·  ` +
      `${report.usage.inputTokens.toLocaleString()} input tokens  ·  $${report.costUsd.toFixed(6)}`,
  );
  console.log(
    `Latency  ${report.serverMs} ms server-side  ·  ${report.wallMs} ms end-to-end  ·  ` +
      `model ${report.model}${report.requestId ? `  ·  ${report.requestId}` : ''}`,
  );
  console.log('');
}

function printReplayComparison(before: AssessmentReport, after: AssessmentReport): void {
  console.log('');
  console.log(
    `Replay — no inference call. thresholds ${JSON.stringify(before.thresholds)} combine ${before.combineRule}` +
      `  →  ${JSON.stringify(after.thresholds)} combine ${after.combineRule}`,
  );
  console.log('');
  console.log(pad('CONTROL', 10) + pad('MET', 6) + pad('BEFORE', 16) + 'AFTER');
  console.log('-'.repeat(48));
  let changed = 0;
  for (let i = 0; i < before.controls.length; i += 1) {
    const b = before.controls[i];
    const a = after.controls[i];
    const moved = b.verdict !== a.verdict;
    if (moved) changed += 1;
    console.log(
      pad(b.controlId, 10) +
        padStart(a.controlMet.toFixed(2), 6) +
        pad(VERDICT_MARK[b.verdict], 16) +
        (moved ? `→ ${VERDICT_MARK[a.verdict]}` : VERDICT_MARK[a.verdict]),
    );
  }
  console.log('');
  console.log(
    `Verdicts moved: ${changed} of ${before.controls.length}  ·  ` +
      `before pass ${before.summary.pass}/fail ${before.summary.fail}/escalate ${before.summary.escalate}  ·  ` +
      `after pass ${after.summary.pass}/fail ${after.summary.fail}/escalate ${after.summary.escalate}`,
  );
  console.log(`Additional cost: $0.000000 (probabilities reused)`);
  console.log('');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.listAssertions) {
    const specs = buildControlSpecs();
    const questions = buildQuestionMap(specs);
    const elements = specs.reduce((n, s) => n + s.elements.length, 0);
    console.log(
      `assertion library v${ASSERTION_LIBRARY_VERSION} — ${specs.length} controls, ` +
        `${elements} elements, ${Object.keys(questions).length} assertions`,
    );
    for (const spec of specs) {
      console.log(`\n${spec.controlId}  [${spec.framework}]  ${spec.name}`);
      console.log(`  expectation: ${spec.expectation}`);
      console.log(`  elements:`);
      for (const element of spec.elements) {
        console.log(`    - ${element.key}: ${element.requirement}`);
      }
      console.log(`  assertions: ${spec.assertions.length}`);
    }
    return;
  }

  if (args.replayFrom) {
    const before = JSON.parse(fs.readFileSync(args.replayFrom, 'utf8')) as AssessmentReport;
    const after = replay(before, {
      thresholds: { ...before.thresholds, ...args.thresholds },
      combineRule: args.combine ?? before.combineRule,
    });
    if (args.json) console.log(JSON.stringify(after, null, 2));
    else printReplayComparison(before, after);
    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(after, null, 2));
      console.log(`Replayed report written to ${args.out}`);
    }
    return;
  }

  const packPath = resolvePackPath(args.pack);
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8')) as EvidencePack;

  const report = await assess(pack, {
    thresholds: { ...DEFAULT_THRESHOLDS, ...args.thresholds },
    combineRule: args.combine ?? DEFAULT_COMBINE_RULE,
  });

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report, pack, 'Continuous control test');

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log(`Report written to ${args.out}`);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Control test failed: ${message}`);
  process.exitCode = 1;
});
