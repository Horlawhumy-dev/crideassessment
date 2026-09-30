/**
 * P8 — "contracts are generated, not transcribed".
 *
 * The backend owns the contract; this writes it down. A hand-maintained
 * `types/index.ts` is a promise that drifts, and the previous `lib/mock-data.ts`
 * was already a demonstration of exactly that failure: it described a status
 * vocabulary ('In transit', 'Arriving', 'Waiting') that matched no enum anywhere
 * in the system, and a Dispatcher role that no `UserRole` could hold.
 *
 * Run against a live API:  npm run gen:api
 * Checked in CI:        npm run check:api
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const OUT = resolve(root, 'lib/generated/api.d.ts');

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';
const specUrl = `${apiUrl}/docs-json`;

async function generate() {
  const { stdout } = await run(
    'npx',
    ['openapi-typescript', specUrl, '--output', OUT, '--alphabetize'],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  process.stdout.write(`${stdout}\nWrote ${OUT}\n`);
  return readFile(OUT, 'utf8');
}

/** Regenerate into a temp file and compare, so CI fails on drift. */
async function check() {
  const committed = await readFile(OUT, 'utf8').catch(() => null);
  if (committed === null) {
    process.stderr.write(`Missing ${OUT}. Run: npm run gen:api\n`);
    process.exit(1);
  }

  const fresh = await generate();
  if (fresh !== committed) {
    process.stderr.write(
      [
        '',
        'The backend contract has drifted from lib/generated/api.d.ts.',
        '',
        '  The API changed and the generated types were not regenerated.',
        '  Run `npm run gen:api` and commit the result.',
        '',
        '  This is the check that turns a FE/BE contract from a documentation',
        '  promise into a build failure.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  process.stdout.write('Contract is in sync with the running API.\n');
}

const mode = process.argv[2];

if (mode === 'check') {
  await check();
} else {
  await mkdir(dirname(OUT), { recursive: true }).catch(() => {});
  await generate();
}

// Kept so the module is not flagged as side-effect-only for `--check` runs.
export { generate, check };
void writeFile;
