#!/usr/bin/env node
/**
 * §5.15 — "no arbitrary values in feature code".
 *
 * `bg-[#111c27]` is how a design system dies: one literal, then another, until
 * nothing in the app can be restyled. The audit found 191 hardcoded hex values
 * against a complete and entirely unused token set, which is a symptom of
 * building screens before building the system.
 *
 * This is the enforcement that makes the token set real. It is deliberately a
 * dumb grep over a fixed set of globs rather than a styled-components linter: it
 * has no opinions about what a hex value *means*, only that it is not allowed to
 * live outside the design system.
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '../..');

/** Where tokens are allowed to be spelled out. */
const ALLOWED = [
  'components/ui',
  'app/globals.css',
  'lib/places.ts',
  // MapLibre's imperative API takes colour values at runtime, where a Tailwind
  // class does not exist. The file reads the same CSS custom properties as
  // everything else, so it is where tokens are *used* rather than invented.
  'lib/map/maplibre-view.tsx',
  // `viewport.themeColor` is a `<meta>` value, not CSS. It cannot reference a
  // custom property, so a literal is the only way to express it.
  'app/layout.tsx',
];
/** Where they are not. */
const SCANNED = ['app', 'features', 'components/layout', 'lib'];

const CODE = new Set(['.ts', '.tsx', '.css']);
/** Matches `#rgb`, `#rrggbb`, `#rrggbbaa`. */
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Arbitrary values on utilities that are colour-only. `bg-[#fff]` is a colour
 * literal wearing a different hat, and is the form that actually appears in
 * practice.
 */
const COLOUR_UTILITY = /\b(?:bg|border|ring|fill|stroke|from|to|via|outline|decoration|accent|caret|divide|shadow)-\[[^\]]+\]/g;

/**
 * `text-[…]` is the awkward one: `text-[#fff]` is a colour and `text-[0.7rem]`
 * is a size, and flagging both is a false positive on half of the codebase. So
 * this only fires when the bracket holds something that is recognisably a colour.
 */
const TEXT_ARBITRARY = /\btext-\[[^\]]+\]/g;
const LOOKS_LIKE_COLOUR = /^\s*(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\()/i;

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dev']);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (CODE.has(extname(entry.name))) {
      yield full;
    }
  }
}

const violations = [];

for (const area of SCANNED) {
  for await (const file of walk(join(root, area))) {
    const rel = relative(root, file);
    if (ALLOWED.some((allowed) => rel === allowed || rel.startsWith(`${allowed}/`))) continue;

    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');

    lines.forEach((line, index) => {
      // Ignore comment lines: prose about a colour is not a colour.
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;

      const hex = [...line.matchAll(HEX)];
      const colours = [...line.matchAll(COLOUR_UTILITY)];
      const textBrackets = [...line.matchAll(TEXT_ARBITRARY)].filter((match) => LOOKS_LIKE_COLOUR.test(match[0].slice(5)));

      for (const match of hex) violations.push({ rel, line: index + 1, text: match[0], kind: 'hex literal' });
      for (const match of colours) violations.push({ rel, line: index + 1, text: match[0], kind: 'arbitrary colour' });
      for (const match of textBrackets) violations.push({ rel, line: index + 1, text: match[0], kind: 'arbitrary colour' });
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(
    [
      '',
      `Design-system violation: ${violations.length} colour literal(s) outside components/ui.`,
      '',
      ...violations.slice(0, 40).map((v) => `  ${v.rel}:${v.line}  ${v.text}   (${v.kind})`),
      ...(violations.length > 40 ? [`  … and ${violations.length - 40} more`] : []),
      '',
      'Colours come from a token in app/globals.css, applied through a',
      'components/ui primitive or a semantic class such as bg-success-soft.',
      'Add the token first if the colour you need does not exist yet.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stdout.write('No colour literals outside the design system.\n');
