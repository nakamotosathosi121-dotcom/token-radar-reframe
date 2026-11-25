// Token Radar, model radar-4 (Node 22, standard library only) — reframe build.
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), fits the
// radar-4 model on the snapshot's traded protocols and scores every rankable pre-token
// protocol with it (lib/model.ts), writes the ranked board to /output/board.json, writes
// the dashboard's data to /output/data.js, copies this repository's dashboard/ and
// screenshots/ to /output, and writes /output/dossier.json with the vendored make.fun
// library.
//
// This build is a dashboard reframe of the radar-4 entry, not a new model: the fit,
// the premiums, the odds and the board are byte-identical to radar-4's. What changed
// is the presentation layer only — the dashboard now reads as a mispricing screen
// (see dashboard/app.js): traded protocols are shown with their measured residual
// against the curve, pre-token protocols only with an implied value and a P25-P75
// range, never with a "mispricing" claim. lib/model.ts carries the three extra
// fields that presentation needs (LiveRow curve/deviation/flag, the mispricing
// summary, and a growth tier); the model arithmetic is untouched.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// Deterministic: the fits come from the snapshot alone and every PRNG is seeded, so the
// grader's two runs write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import type { BoardRow, RadarData, Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** `--name value` out of the arguments, or undefined. */
function argSpaced(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : undefined;
}

/** `--name=value` out of the arguments, or undefined. */
function argJoined(name: string): string | undefined {
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? undefined : withEquals.slice(name.length + 3);
}

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  return argSpaced(name) ?? argJoined(name) ?? fallback;
}

/** The run's inputs: where the snapshot lives and where the output goes. */
interface RunConfig {
  inputFile: string;
  out: string;
}

/** The inputs out of the arguments and the environment, refused unless the snapshot exists. */
function readConfig(): RunConfig {
  const inputArg = arg('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
    process.exit(2);
  }
  return { inputFile, out: arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output') };
}

/** The snapshot scored: its board, its radar data, and the gate's verdict on the board. */
function scoreSnapshot(inputFile: string): { snapshot: Snapshot; board: BoardRow[]; radar: RadarData } {
  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
    process.exit(1);
  }
  return { snapshot, board, radar };
}

const config = readConfig();
const { snapshot, board, radar } = scoreSnapshot(config.inputFile);

mkdirSync(config.out, { recursive: true });
writeFileSync(join(config.out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(config.out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

/** The dashboard and the screenshots, copied into the output. */
function copyAssets(out: string): { dash: string[]; shots: string[] } {
  const dash = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
  const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
  return { dash, shots };
}

/** The screenshots, refused unless three or more are handed in, each with a plain name. */
function checkScreenshots(shots: string[]): void {
  if (shots.length < 3) {
    process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
    process.exit(1);
  }
  for (const name of shots) {
    if (!IMAGE_NAME.test(name)) {
      process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
      process.exit(1);
    }
  }
}

const { dash, shots } = copyAssets(config.out);
checkScreenshots(shots);

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(config.out, 'dossier.json'), buildDossier(config.out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: fit on ${radar.comps_n} comps: log10(mcap) = ${radar.fit.a.toFixed(3)} + ${radar.fit.b.toFixed(3)} * log10(TVL), R^2 ${radar.fit.r2.toFixed(3)}; LOO median miss x${radar.validation.loo.median_miss_x.toFixed(2)} vs flat x${radar.validation.flat_median_miss_x.toFixed(2)}; walk-forward x${radar.validation.walk_forward.median_miss_x.toFixed(2)}; 5-fold x${radar.validation.kfold.median_miss_x.toFixed(2)}\n` +
    `token radar: mispricing screen on ${radar.live_size} live tokens: ${radar.mispricing_summary.rich_count} RICH (market above model), ${radar.mispricing_summary.cheap_count} CHEAP (market below model), ${radar.mispricing_summary.fair_count} in line; median deviation x${radar.mispricing_summary.median_deviation_ratio.toFixed(2)} (flags from the LOO residuals' P10-P90 quantiles)\n` +
    `token radar: wrote ${join(config.out, 'board.json')}, ${join(config.out, 'data.js')}, ${join(config.out, 'dashboard')} (${dash.length} files), ${join(config.out, 'screenshots')} (${shots.length} images) and ${join(config.out, 'dossier.json')}\n`,
);
