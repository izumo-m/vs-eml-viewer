'use strict';

// Runs the real extension.js against a small stand-in for the vscode module.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const EmlI18n = require('../media/i18n.js');

class Uri {
  constructor(scheme, p) {
    this.scheme = scheme;
    this.path = p;
  }
  static file(p) {
    return new Uri('file', p);
  }
  static parse(s) {
    return new Uri(/^[^:]+/.exec(s)[0], s);
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, path.posix.join(base.path, ...parts));
  }
}

const state = {};

function reset() {
  Object.assign(state, {
    opened: [],
    rejectStrings: false,
    files: new Map(),
    failWrites: new Set(),
    messages: [],
    errors: [],
    saveDialog: null,
    saveTarget: undefined,
    quickPick: null,
    pickFormat: undefined,
    posted: [],
    watcher: {},
  });
}
reset();

const stub = {
  Uri,
  env: {
    language: 'en',
    openExternal: async (target) => {
      if (state.rejectStrings && typeof target === 'string') throw new Error('Invalid uri');
      state.opened.push(target);
      return true;
    },
  },
  RelativePattern: class {},
  workspace: {
    createFileSystemWatcher: () => ({
      onDidChange: (fn) => { state.watcher.change = fn; },
      onDidCreate: (fn) => { state.watcher.create = fn; },
      dispose() {},
    }),
    fs: {
      readFile: async (uri) => state.files.get(uri.path),
      stat: async (uri) => {
        if (!state.files.has(uri.path)) throw new Error('missing');
      },
      writeFile: async (uri, bytes) => {
        if (Buffer.byteLength(path.posix.basename(uri.path)) > 255 || state.failWrites.has(path.posix.basename(uri.path))) {
          throw new Error('cannot write');
        }
        state.files.set(uri.path, bytes);
      },
    },
  },
  window: {
    registerCustomEditorProvider: (viewType, provider) => {
      state.provider = provider;
      return { dispose() {} };
    },
    showOpenDialog: async () => [Uri.file('/out')],
    showQuickPick: async (items, options) => {
      state.quickPick = { items, options };
      return items.find((i) => i.format === state.pickFormat);
    },
    showSaveDialog: async (options) => {
      state.saveDialog = options;
      return state.saveTarget;
    },
    showInformationMessage: (m) => state.messages.push(m),
    showErrorMessage: (m) => state.errors.push(m),
  },
  commands: { registerCommand: () => ({ dispose() {} }) },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? stub : originalLoad.call(this, request, ...rest);
};
require('../extension.js').activate({ subscriptions: [], extensionUri: Uri.file('/ext') });
Module._load = originalLoad;
const provider = state.provider;

// A mail with one attachment per name, in the order given. Saving uses the name passed by the webview.
const EML = Uri.file('/mail/a.eml');
const mail = () => state.files.get(EML.path);
function withMail(names) {
  const parts = names.map((n, i) => `--B\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="f${i}"\r\n\r\ndata${i}\r\n`);
  state.files.set(EML.path, Buffer.from(`Content-Type: multipart/mixed; boundary=B\r\n\r\n${parts.join('')}--B--\r\n`));
  return names.map((filename, index) => ({ index, filename }));
}
const savedNames = () => [...state.files.keys()].filter((p) => p.startsWith('/out/')).map((p) => path.posix.basename(p));

async function saveAs(name) {
  reset();
  const items = withMail([name]);
  await provider.saveAll(EML, mail(), items);
  assert.equal(savedNames().length, 1, JSON.stringify(name));
  return savedNames()[0];
}

test('links keep their percent-encoding', async () => {
  reset();
  const hrefs = [
    'https://example.com/r?u=https%3A%2F%2Fy.example%2Fp%3Fa%3D1%26b%3D2',
    'https://example.com/?q=a%26b%3Dc',
    'https://example.com/?q=a%2Bb',
    'https://example.com/p%2Fq/r',
    'https://example.com/?q=a%23b',
    'https://example.com/a%3Fb',
    'mailto:a@example.com?subject=a%26b',
  ];
  for (const href of hrefs) await provider.openLink(href);
  assert.deepEqual(state.opened, hrefs);
});

test('links are normalised before they reach the OS', async () => {
  reset();
  await provider.openLink('  HTTPS://Example.com/a b"c ');
  assert.deepEqual(state.opened, ['https://example.com/a%20b%22c']);
});

test('only http, https and mailto links open', async () => {
  reset();
  const refused = [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'command:workbench.action.quit',
    'vscode://settings',
    'data:text/html,x',
    'vscode-webview://abc/index.html',
    '//example.com/',
    'not a url',
    '',
    undefined,
    null,
    42,
    { href: 'https://example.com/' },
  ];
  for (const href of refused) await provider.openLink(href);
  assert.deepEqual(state.opened, []);
});

test('falls back to a Uri if VS Code stops accepting strings', async () => {
  reset();
  state.rejectStrings = true;
  await provider.openLink('https://example.com/');
  assert.equal(state.opened.length, 1);
  assert.ok(state.opened[0] instanceof Uri);
});

test('attachment names cannot leave the folder or use special characters', async () => {
  assert.equal(await saveAs('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(await saveAs('..\\..\\x.exe'), '_.._x.exe');
  assert.equal(await saveAs('a:b*c?d"e<f>g|h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(await saveAs('a\x01b\x7fc\x85d.txt'), 'a_b_c_d.txt');
  assert.equal(await saveAs(' .hidden. '), 'hidden');
  assert.equal(await saveAs('...'), 'attachment');
});

test('invisible and bidirectional characters are removed', async () => {
  assert.equal(await saveAs('invoice\u202egnp.exe'), 'invoicegnp.exe');
  assert.equal(await saveAs('a\u200b.\u2066e\u2069xe'), 'a.exe');
  assert.equal(await saveAs('\ufeffa.txt'), 'a.txt');
  assert.equal(await saveAs('👨\u200d👩.txt'), '👨\u200d👩.txt', 'emoji joiner stays');
});

test('Windows device names get a prefix', async () => {
  for (const name of ['CON', 'con.txt', 'PRN.log', 'aux', 'NUL.tar.gz', 'COM1.log', 'lpt9', 'COM¹.txt']) {
    assert.equal(await saveAs(name), '_' + name, name);
  }
  for (const name of ['console.txt', 'nullable', 'COM10.txt', 'com.txt']) {
    assert.equal(await saveAs(name), name, name);
  }
});

test('long names are cut to fit, keeping the extension and whole characters', async () => {
  const ascii = await saveAs('a'.repeat(300) + '.txt');
  assert.ok(ascii.endsWith('.txt'));
  assert.equal(Buffer.byteLength(ascii), 200);

  const japanese = await saveAs('あ'.repeat(200) + '.pdf');
  assert.ok(japanese.endsWith('.pdf'));
  assert.ok(Buffer.byteLength(japanese) <= 200);
  assert.ok(!japanese.includes('\ufffd'));

  const emoji = await saveAs('😀'.repeat(100));
  assert.ok(Buffer.byteLength(emoji) <= 200);
  assert.equal(emoji, '😀'.repeat(50));

  const longExt = await saveAs('a.' + 'b'.repeat(300));
  assert.ok(Buffer.byteLength(longExt) <= 200);
});

test('saving one attachment offers a cleaned name', async () => {
  reset();
  const [item] = withMail(['a/b\u202e.txt']);
  await provider.saveAttachment(EML, mail(), item.index, item.filename);
  assert.equal(state.saveDialog.defaultUri.path, '/mail/a_b.txt');
});

test('Save All keeps going after a failure and reports it', async () => {
  reset();
  state.failWrites.add('bad.txt');
  const items = withMail(['one.txt', 'bad.txt', 'three.txt']);
  await provider.saveAll(EML, mail(), items);
  assert.deepEqual(savedNames(), ['one.txt', 'three.txt']);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.errors, ['Saved 2 attachment(s). Could not save 1: bad.txt']);
});

test('Save All does not overwrite existing files', async () => {
  reset();
  const items = withMail(['same.txt', 'same.txt']);
  state.files.set('/out/same.txt', Buffer.from('existing'));
  await provider.saveAll(EML, mail(), items);
  assert.deepEqual(savedNames(), ['same.txt', 'same (1).txt', 'same (2).txt']);
  assert.equal(state.files.get('/out/same.txt').toString(), 'existing');
  assert.deepEqual(state.messages, ['Saved 2 attachment(s).']);
});

test('Save All never overwrites, even when all the numbered names are taken', async () => {
  reset();
  const items = withMail(['full.txt', 'other.txt']);
  state.files.set('/out/full.txt', Buffer.from('existing'));
  for (let i = 1; i <= 1000; i++) state.files.set(`/out/full (${i}).txt`, Buffer.from('existing'));
  await provider.saveAll(EML, mail(), items);
  assert.equal(state.files.get('/out/full (1000).txt').toString(), 'existing');
  assert.ok(state.files.has('/out/other.txt'));
  assert.deepEqual(state.errors, ['Saved 1 attachment(s). Could not save 1: full.txt']);
});

test('a crafted name does not stall the extension host', async () => {
  for (const name of ['a' + '.'.repeat(1000000) + 'b.exe', 'a' + ' '.repeat(1000000) + 'b.exe', '.'.repeat(1000000)]) {
    const start = Date.now();
    await saveAs(name);
    assert.ok(Date.now() - start < 1000, `${Date.now() - start} ms`);
  }
});

// Opens the mail the way VS Code does, so the messages and the file watcher are the real ones.
async function openEditor() {
  let onMessage;
  const panel = {
    webview: {
      cspSource: 'vscode-resource:',
      asWebviewUri: (u) => 'res:' + u.path,
      postMessage: async (m) => state.posted.push(m),
      onDidReceiveMessage: (fn) => { onMessage = fn; },
    },
    onDidDispose() {},
  };
  await provider.resolveCustomEditor({ uri: EML }, panel);
  await onMessage({ type: 'ready' });
  return onMessage;
}

test('saving uses the mail on screen, even if the file has changed since', async () => {
  reset();
  const items = withMail(['first.txt', 'second.txt']);
  const send = await openEditor();
  const onScreen = state.posted[0].data;
  assert.equal(Buffer.from(onScreen, 'base64').toString('latin1'), mail().toString('latin1'));

  // replaced behind the viewer's back, and no reload has reached it
  state.files.set(EML.path, Buffer.from('Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Disposition: attachment; filename="evil.exe"\r\n\r\nMZ-EVIL\r\n--B--\r\n'));

  state.saveTarget = Uri.file('/picked/first.txt');
  await send({ type: 'saveAttachment', index: 0, filename: 'first.txt' });
  assert.equal(Buffer.from(state.files.get('/picked/first.txt')).toString(), 'data0');

  await send({ type: 'saveAll', items });
  assert.deepEqual(savedNames(), ['first.txt', 'second.txt']);
  assert.equal(Buffer.from(state.files.get('/out/second.txt')).toString(), 'data1');
  assert.deepEqual(state.errors, []);
});

test('the file changing or being replaced reloads the view, and saves follow it', async () => {
  for (const event of ['change', 'create']) {
    reset();
    withMail(['old.txt']);
    const send = await openEditor();
    const replacement = Buffer.from('Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Disposition: attachment; filename="new.txt"\r\n\r\nnew data\r\n--B--\r\n');
    state.files.set(EML.path, replacement);
    await state.watcher[event]();
    assert.equal(state.posted.length, 2, event);
    assert.equal(state.posted[1].data, replacement.toString('base64'), event);

    state.saveTarget = Uri.file('/picked/new.txt');
    await send({ type: 'saveAttachment', index: 0, filename: 'new.txt' });
    assert.equal(Buffer.from(state.files.get('/picked/new.txt')).toString(), 'new data', event);
  }
});

test('Save All reports an attachment it cannot find', async () => {
  reset();
  const items = withMail(['one.txt']);
  await provider.saveAll(EML, mail(), [...items, { index: 5, filename: 'gone/x.txt' }]);
  assert.deepEqual(savedNames(), ['one.txt']);
  assert.deepEqual(state.errors, ['Saved 1 attachment(s). Could not save 1: gone_x.txt']);
});

test('saving before the mail has loaded reports an error', async () => {
  reset();
  await assert.rejects(provider.saveAttachment(EML, null, 0, 'x.txt'), { message: EmlI18n.forLocale('en')('attachmentNotFound') });
  assert.equal(state.saveDialog, null);
});

test('the page CSP only runs our own scripts', () => {
  const webview = { cspSource: 'vscode-resource:', asWebviewUri: (u) => 'res:' + u.path };
  const html = provider.getHtml(webview, Uri.file('/ext/media'));
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /(?:^|; )default-src 'none'(?:;|$)/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
  assert.ok(!/script-src[^;]*(?:unsafe|https?:)/.test(csp));
  const scripts = [...html.matchAll(/<script ([^>]*)>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 4);
  for (const s of scripts) assert.ok(s.includes(`nonce="${nonce}"`), s);
});

test('the mail frame stays sandboxed and locked down', () => {
  // buildSrcdoc needs a DOM, so its behaviour is checked by hand (see DEVELOPMENT.md). These lines must stay.
  const src = fs.readFileSync(path.join(ROOT, 'media/viewer.js'), 'utf8');
  assert.match(src, /sandbox: 'allow-same-origin'[,\s]/);
  assert.match(src, /const csp = "default-src 'none'; /);
  assert.match(src, /return DOCTYPE \+ '<meta http-equiv="Content-Security-Policy" content="' \+ csp \+ '">'/);
  assert.match(src, /parseFromString\(DOCTYPE \+ html, 'text\/html'\)/);
  assert.match(src, /const DOCTYPE = '<!doctype html>';/);
  assert.match(src, /querySelectorAll\.call\(doc, 'link, meta\[http-equiv\], iframe, frame, object, embed, template'\)/);
  assert.match(src, /cleanUntilStable\(html, remoteImages\);/);
  assert.match(src, /parseEmail\([^\n]*\n\s*remoteImages = false;/);
});

test('the exported file keeps its own policy and leaves remote content out', () => {
  // The export needs a DOM too. These lines must stay.
  const src = fs.readFileSync(path.join(ROOT, 'media/viewer.js'), 'utf8');
  assert.match(src, /return EmlExport\.htmlHead\(summary\.subject, locale\) \+\n\s*cleanUntilStable\(html, false, \(d\) => EmlExport\.sanitize\(rootOf\(d\), DOM, base\)\);/);
  assert.match(src, /const removed = EmlExport\.sanitize\(rootOf\(doc\), DOM, base\);/);
});

test('Save As writes what the webview made, in the format picked', async () => {
  for (const [format, name, text] of [['html', 'a.html', '<p>あ</p>'], ['md', 'a.md', '# あ\n']]) {
    reset();
    withMail(['x.txt']);
    const send = await openEditor();
    state.pickFormat = format;
    await send({ type: 'saveAs' });
    assert.deepEqual(state.posted.at(-1), { type: 'export', format });
    assert.deepEqual(state.quickPick.items.map((i) => i.format), ['html', 'md']);

    state.saveTarget = Uri.file('/picked/' + name);
    await send({ type: 'exported', format, content: text });
    assert.equal(state.saveDialog.defaultUri.path, '/mail/' + name);
    assert.equal(Buffer.from(state.files.get('/picked/' + name)).toString('utf8'), text);
    assert.deepEqual(state.messages, ['Saved: ' + name]);
    assert.deepEqual(state.errors, []);
  }
});

test('Save As writes nothing the user did not ask for', async () => {
  reset();
  withMail([]);
  const send = await openEditor();
  state.saveTarget = Uri.file('/picked/x.html');

  // no format picked yet
  await send({ type: 'exported', format: 'html', content: 'x' });
  assert.equal(state.saveDialog, null);

  // cancelled
  state.pickFormat = undefined;
  await send({ type: 'saveAs' });
  assert.equal(state.posted.length, 1);
  await send({ type: 'exported', format: 'html', content: 'x' });
  assert.equal(state.saveDialog, null);

  // another format, or content that is not text
  state.pickFormat = 'md';
  await send({ type: 'saveAs' });
  await send({ type: 'exported', format: 'html', content: 'x' });
  await send({ type: 'exported', format: 'md', content: { length: 1 } });
  await send({ type: 'exported', format: '__proto__', content: 'x' });
  assert.equal(state.saveDialog, null);

  // only one file per request
  await send({ type: 'exported', format: 'md', content: 'x' });
  state.saveDialog = null;
  await send({ type: 'exported', format: 'md', content: 'y' });
  assert.equal(state.saveDialog, null);
  assert.equal(Buffer.from(state.files.get('/picked/x.html')).toString(), 'x');
});

test('Save As reports a failure in the webview', async () => {
  reset();
  withMail([]);
  const send = await openEditor();
  state.pickFormat = 'html';
  await send({ type: 'saveAs' });
  // whatever the webview sends, the notification shows only our own text: it renders links
  await send({ type: 'exportFailed', message: '[retry](command:workbench.action.quit)' });
  assert.deepEqual(state.errors, ['EML Viewer: ' + EmlI18n.forLocale('en')('exportFailed')]);
  await send({ type: 'exported', format: 'html', content: 'x' });
  assert.equal(state.saveDialog, null);
});

test('Save As offers a clean name next to the mail', async () => {
  for (const [file, expected] of [['/mail/a.b.eml', '/mail/a.b.md'], ['/mail/.eml', '/mail/eml.md'], ['/mail/CON.eml', '/mail/_CON.md']]) {
    reset();
    await provider.saveExport(Uri.file(file), 'md', 'x');
    assert.equal(state.saveDialog.defaultUri.path, expected, file);
    assert.deepEqual(state.saveDialog.filters, { Markdown: ['md'] });
  }
});

test('every file a README links to is in the package', () => {
  const { INCLUDE } = require('../scripts/package.js');
  for (const readme of ['README.md', 'README.ja.md']) {
    assert.ok(INCLUDE.includes(readme), readme);
    const src = fs.readFileSync(path.join(ROOT, readme), 'utf8');
    for (const [, target] of src.matchAll(/\]\(([^)]+)\)/g)) {
      if (!/^[a-z]+:/i.test(target)) assert.ok(INCLUDE.includes(target), `${readme}: ${target}`);
    }
  }
});
