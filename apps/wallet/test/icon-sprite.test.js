// The icon sprite is a set, and this is the only thing that checks it stays one.
//
// Every icon in the app is `<use href="#ic-NAME"/>`, written either straight
// into index.html or by app.js's icon() helper. A reference to a symbol that
// does not exist renders NOTHING — no console error, no thrown exception, just
// an empty box where a mark should be. Nothing else in the repo greps for
// 'ic-': the drivers click by id and assert on text, and an <svg> is not in
// textContent, so a typo'd name ships fully green through 13 drivers and 300+
// unit tests. That is the exact failure this file exists to catch.
//
// It also catches the inverse (a symbol nobody renders) as a soft inventory,
// and it pins the authoring contract, because a presentation attribute baked
// onto a symbol silently defeats the size-class ladder everywhere it renders —
// ic-more carried stroke-width="2.6" for exactly that reason until .ic-dots
// replaced it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pub = fileURLToPath(new URL('../public/', import.meta.url));
const html = readFileSync(pub + 'index.html', 'utf8');
// The sprite's own docs spell the call shape out as `href="#ic-name"`, and the
// CSS comment above .ic does it again — prose, not call sites. Scan references
// against the comment-stripped source so documentation cannot fail the build
// (nor, more importantly, hide a real miss behind a known-bogus one).
// Both comment syntaxes: the sprite's docs are an HTML comment, the .ic docs
// are a CSS one inside <style>, and both spell out `href="#ic-name"`.
const htmlLive = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const scripts = readdirSync(pub)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: f, src: readFileSync(pub + f, 'utf8') }));

/** Every `<symbol id="ic-…">` defined in the sprite.
 *  htmlLive, not html, and the two halves MUST agree on their source: a symbol
 *  commented out still matches the raw text, so scanning it here while
 *  referencedSymbols() scans the stripped text would let a reference to a
 *  commented-out symbol pass the resolves-test and still render an empty box —
 *  the exact silent miss this file exists to prevent. */
function definedSymbols() {
  return new Set([...htmlLive.matchAll(/<symbol\s+id="(ic-[a-z0-9-]+)"/g)].map((m) => m[1]));
}

/** Every symbol NAME the app asks for, with where it asked. Two call shapes:
 *  markup writes `href="#ic-name"`, app.js calls `icon('name')`. */
function referencedSymbols() {
  const refs = [];
  for (const m of htmlLive.matchAll(/href="#(ic-[a-z0-9-]+)"/g)) refs.push({ name: m[1], where: 'index.html' });
  for (const { file, src } of scripts) {
    const live = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of live.matchAll(/\bicon\(\s*'([a-z0-9-]+)'/g)) refs.push({ name: 'ic-' + m[1], where: file });
  }
  return refs;
}

test('every referenced icon resolves to a symbol in the sprite', () => {
  const defined = definedSymbols();
  const missing = referencedSymbols().filter((r) => !defined.has(r.name));
  assert.deepEqual(
    missing, [],
    'these render as an empty box, silently:\n' +
      missing.map((r) => `  ${r.where} → ${r.name}`).join('\n'),
  );
});

test('the sprite is not empty and every symbol is on the 24x24 grid', () => {
  const symbols = [...html.matchAll(/<symbol\s+id="(ic-[a-z0-9-]+)"([^>]*)>/g)];
  // A guard that passes on an empty set is worse than none: if the sprite ever
  // moves or the id convention changes, these tests must fail, not vacuously pass.
  assert.ok(symbols.length >= 30, `expected the full sprite, found ${symbols.length} symbols`);
  const offGrid = symbols.filter(([, , attrs]) => !/viewBox="0 0 24 24"/.test(attrs)).map(([, id]) => id);
  assert.deepEqual(offGrid, [], 'symbols not authored on the 24x24 grid');
});

test('no symbol carries a presentation attribute', () => {
  // Weight, fill and colour come from the size class and from currentColor. A
  // value baked here follows the shape into every context it renders in and
  // cannot be overridden by the component that owns the slot.
  const offenders = [];
  // attrs AND body. Scanning only the body was a hole big enough to drive the
  // original bug through: `<symbol id="x" stroke-width="9">` puts the value on
  // the element every <use> instances, so it reaches the rendered path exactly
  // like ic-more's did — and `[^>]*` swallowed the opening tag unchecked.
  // `id=`/`viewBox=` are safe here: none of them end in `stroke=`/`fill=`, and
  // `\sstroke="` cannot match `stroke-width="`.
  for (const m of htmlLive.matchAll(/<symbol\s+id="(ic-[a-z0-9-]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)) {
    const [, id, attrs, body] = m;
    for (const attr of ['stroke-width', 'stroke', 'fill']) {
      const re = new RegExp(`\\s${attr}="`);
      if (re.test(attrs)) offenders.push(`${id} → ${attr} (on the <symbol> tag)`);
      if (re.test(body)) offenders.push(`${id} → ${attr}`);
    }
  }
  assert.deepEqual(offenders, [], 'presentation attributes defeat the size-class ladder');
});

test('the sprite grows no new symbols nobody renders', () => {
  // SUBSET, not equality. An unused symbol is dead weight, not a bug, so the
  // point is to stop the set growing a tail — never to punish the good change.
  // Rendering one of these shrinks `unused`, which still satisfies a subset
  // assertion; equality would turn that into a red suite reading like a
  // regression. Adding a NEW unrendered symbol is what fails here.
  const referenced = new Set(referencedSymbols().map((r) => r.name));
  const unused = [...definedSymbols()].filter((id) => !referenced.has(id)).sort();
  const known = new Set([
    'ic-arrow-left', 'ic-coins', 'ic-dollar', 'ic-download', 'ic-external',
    'ic-eye-off', 'ic-info', 'ic-lock', 'ic-pencil', 'ic-plus', 'ic-qr',
    'ic-refresh', 'ic-signature', 'ic-unlock', 'ic-upload',
  ]);
  const grew = unused.filter((id) => !known.has(id));
  assert.deepEqual(
    grew, [],
    'new symbol(s) nobody renders — add the call site, or add the name to `known` with a reason:\n' +
      grew.map((id) => `  ${id}`).join('\n'),
  );
});
