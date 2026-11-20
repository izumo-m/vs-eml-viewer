'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I18n = require('../media/i18n.js');

const ROOT = path.join(__dirname, '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));

test('every language defines the same keys', () => {
  const en = Object.keys(I18n.STRINGS.en).sort();
  for (const lang of Object.keys(I18n.STRINGS)) {
    assert.deepEqual(Object.keys(I18n.STRINGS[lang]).sort(), en, lang);
  }
});

test('forLocale picks the language, falls back to English and fills placeholders', () => {
  assert.equal(I18n.forLocale('ja')('tabText'), 'テキスト');
  assert.equal(I18n.forLocale('JA-jp')('tabText'), 'テキスト');
  assert.equal(I18n.forLocale('fr')('tabText'), 'Text');
  assert.equal(I18n.forLocale(undefined)('tabText'), 'Text');
  assert.equal(I18n.forLocale('constructor')('tabText'), 'Text');
  assert.equal(I18n.forLocale('en')('saved', 'a.txt'), 'Saved: a.txt');
  assert.equal(I18n.forLocale('en')('no-such-key'), 'no-such-key');
});

test('every string the code uses exists', () => {
  for (const file of ['extension.js', 'media/viewer.js', 'media/export.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of src.matchAll(/\bt\('([^']+)'/g)) {
      assert.ok(m[1] in I18n.STRINGS.en, `${file}: ${m[1]}`);
    }
  }
});

test('every %key% in package.json exists in each package.nls file', () => {
  const keys = [...JSON.stringify(readJson('package.json')).matchAll(/"%([^"%]+)%"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  for (const file of ['package.nls.json', 'package.nls.ja.json']) {
    const nls = readJson(file);
    for (const key of keys) assert.ok(key in nls, `${file}: ${key}`);
  }
});
