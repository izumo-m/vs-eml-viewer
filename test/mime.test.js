'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const M = require('../media/mime.js');

const fixture = (name) => M.parseEmail(fs.readFileSync(path.join(__dirname, 'fixtures', name)));

test('ISO-2022-JP: subject split across encoded words, NEC chars, half-width kana', () => {
  const r = fixture('1_iso2022jp.eml');
  assert.equal(r.subject, '【テスト】分割されたサンプルの件名');
  assert.equal(r.from, 'テスト送信者 <sender@example.jp>');
  assert.equal(r.to, 'テスト受信者 <receiver@example.jp>');
  assert.match(r.text, /①サンプルの本文/);
  assert.match(r.text, /㈱サンプル ﾊﾝｶｸｶﾅ/);
  assert.match(r.html, /<b>①サンプル<\/b>/);
  assert.ok(!r.text.includes('\ufffd'));
  assert.ok(!r.html.includes('\ufffd'));
  assert.equal(r.attachments.length, 0);
});

test('multipart/mixed: body selection, cid image, attachment file names', () => {
  const r = fixture('2_mixed_utf8.eml');
  assert.equal(r.subject, '添付テスト');
  assert.equal(r.from, '送信者 <sender@example.com>');
  assert.equal(r.text, '画像付きのメールです。テキスト版。');
  assert.match(r.html, /cid:img1@example/);

  const names = r.attachments.map((a) => a.filename);
  assert.deepEqual(names, [
    'attachment-1.png',
    'サンプル.pdf',
    'メモ.txt',
    'とても長い添付ファイルの名前_サンプル_テスト用データ.xlsx',
    'message-5.eml',
  ]);
  assert.equal(r.attachments[0].referenced, true, 'inline image used by the HTML');
  assert.equal(r.attachments[1].referenced, false);
  assert.equal(Buffer.from(r.attachments[1].bytes).toString(), '%PDF-1.4 dummy');
  assert.equal(M.decodeBytes(r.attachments[2].bytes, 'shift_jis'), 'メモの中身');
  r.attachments.forEach((a, i) => assert.equal(a.index, i));
});

test('raw JIS in headers and Shift_JIS body labelled x-sjis', () => {
  const r = fixture('3_raw_jis_sjis.eml');
  assert.equal(r.subject, '生のJISの件名');
  assert.equal(r.from, '古いメーラー <old@example.jp>');
  assert.equal(r.text.trim(), 'シフトJISの本文です。①②③');
  assert.equal(r.html, null);
});

test('raw UTF-8 header and EUC-JP HTML with charset only in <meta>', () => {
  const r = fixture('4_utf8hdr_eucjp.eml');
  assert.equal(r.subject, '生のUTF-8件名');
  assert.match(r.html, /EUC-JPの本文/);
});

test('encoded words: JIS continued in the next word, UTF-8 char split across words', () => {
  const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');
  const jis = `=?ISO-2022-JP?B?${b64('\x1b$B\x24\x22\x24\x24')}?= =?ISO-2022-JP?B?${b64('\x24\x26\x1b(B')}?=`;
  assert.equal(M.decodeHeaderValue(jis), 'あいう');

  const u = Buffer.from('日本', 'utf8');
  const utf = `=?UTF-8?B?${u.subarray(0, 4).toString('base64')}?=\r\n =?UTF-8?B?${u.subarray(4).toString('base64')}?=x`;
  assert.equal(M.decodeHeaderValue(utf), '日本x');

  assert.equal(M.decodeHeaderValue('=?utf-8?Q?a=E3=81=82_b?='), 'aあ b');
  assert.equal(M.decodeHeaderValue('plain ascii'), 'plain ascii');
});

test('base64 round trip and tolerance for concatenated chunks', () => {
  const data = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
  assert.deepEqual(Array.from(M.b64ToBytes(M.bytesToB64(data))), Array.from(data));
  const joined = Buffer.from('ab').toString('base64') + Buffer.from('cd').toString('base64');
  assert.equal(Buffer.from(M.b64ToBytes(joined)).toString(), 'abcd');
});

test('labelled non-Japanese charsets', () => {
  const cases = [
    ['GB2312', [0xd6, 0xd0, 0xce, 0xc4], '中文'],
    ['Big5', [0xa4, 0xa4, 0xa4, 0xe5], '中文'],
    ['EUC-KR', [0xc7, 0xd1, 0xb1, 0xdb], '한글'],
    ['ks_c_5601-1987', [0xc7, 0xd1, 0xb1, 0xdb], '한글'],
    ['KOI8-R', [0xf2, 0xd5, 0xd3], 'Рус'],
    ['windows-1251', [0xd0, 0xf3, 0xf1], 'Рус'],
    ['ISO-8859-1', [0x63, 0x61, 0x66, 0xe9], 'café'],
    ['ISO-8859-15', [0xa4], '€'],
    ['cp936', [0xd6, 0xd0, 0xce, 0xc4], '中文'],
    ['cp949', [0xc7, 0xd1, 0xb1, 0xdb], '한글'],
    ['cp950', [0xa4, 0xa4, 0xa4, 0xe5], '中文'],
  ];
  for (const [charset, bytes, expected] of cases) {
    const b = Buffer.from(bytes);
    assert.equal(M.decodeHeaderValue(`=?${charset}?B?${b.toString('base64')}?=`), expected, charset);
    const raw = Buffer.concat([Buffer.from(`Content-Type: text/plain; charset=${charset}\r\n\r\n`), b]);
    assert.equal(M.parseEmail(raw).text, expected, charset);
  }
});

test('unlabelled text: UTF-8 first, then the legacy charsets of the UI language', (t) => {
  t.after(() => M.setLocale(''));
  const unlabelled = (bytes) => M.parseEmail(Buffer.concat([Buffer.from('Subject: x\r\n\r\n'), Buffer.from(bytes)])).text;
  const expectations = [
    ['', [0x63, 0x61, 0x66, 0xe9], 'café'],
    ['en', [0x63, 0x61, 0x66, 0xe9], 'café'],
    ['fr-CA', [0x63, 0x61, 0x66, 0xe9], 'café'],
    ['ja', [0x93, 0xfa, 0x96, 0x7b], '日本'],
    ['zh-cn', [0xd6, 0xd0, 0xce, 0xc4], '中文'],
    ['zh-tw', [0xa4, 0xa4, 0xa4, 0xe5], '中文'],
    ['ko', [0xc7, 0xd1, 0xb1, 0xdb], '한글'],
    ['ru', [0xd0, 0xf3, 0xf1], 'Рус'],
  ];
  for (const [locale, bytes, expected] of expectations) {
    M.setLocale(locale);
    assert.equal(unlabelled(bytes), expected, locale);
    assert.equal(unlabelled(Buffer.from('日本語', 'utf8')), '日本語', locale + ' utf-8');
  }
});

test('an escape that is not ISO-2022-JP is not decoded as JIS', () => {
  const r = M.parseEmail(Buffer.from('Subject: x\r\n\r\n\x1b[1mbold\x1b[0m', 'latin1'));
  assert.equal(r.text, '\x1b[1mbold\x1b[0m');
});

const unlabelledBody = (body) => M.parseEmail(Buffer.concat([Buffer.from('Subject: x\r\n\r\n'), body])).text;

test('"ESC ( B" in unlabelled UTF-8 does not turn it into ISO-2022-JP', () => {
  const body = Buffer.concat([Buffer.from('\x1b(B\x1b[m', 'latin1'), Buffer.from('日本語', 'utf8')]);
  assert.equal(unlabelledBody(body), '\x1b(B\x1b[m日本語');
});

test('8-bit bytes rule out ISO-2022-JP even with a Japanese escape', () => {
  const body = Buffer.concat([Buffer.from('\x1b$Bx', 'latin1'), Buffer.from('日本語', 'utf8')]);
  assert.equal(unlabelledBody(body), '\x1b$Bx日本語');
});

test('unlabelled ISO-2022-JP is still recognised', () => {
  assert.equal(unlabelledBody(Buffer.from('\x1b$B\x24\x22\x24\x24\x1b(B', 'latin1')), 'あい');
  assert.equal(unlabelledBody(Buffer.from('\x1b(I\x31\x1b(B', 'latin1')), 'ｱ');
});

test('Japanese UI: unlabelled EUC-JP and Shift_JIS are told apart', (t) => {
  t.after(() => M.setLocale(''));
  M.setLocale('ja');
  assert.equal(unlabelledBody(Buffer.from([0xa4, 0xa2, 0xa4, 0xa4, 0xa4, 0xa6])), 'あいう');
  assert.equal(unlabelledBody(Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4])), 'あいう');
});

test('labels that claim ASCII are ignored when the text has 8-bit bytes', () => {
  for (const label of ['us-ascii', 'ascii', 'x-unknown', 'unknown-8bit', 'default']) {
    const raw = Buffer.concat([Buffer.from(`Content-Type: text/plain; charset=${label}\r\n\r\n`), Buffer.from('日本語', 'utf8')]);
    assert.equal(M.parseEmail(raw).text, '日本語', label);
  }
});

test('charset names that TextDecoder does not know', () => {
  const samples = {
    shift_jis: [[0x93, 0xfa, 0x96, 0x7b], '日本', ['cp932', 'ms932', 'windows-932', 'x-cp932', 'cswindows31j', 'sjis', 'x-sjis', 's_jis', 'shift-jis', 'shift_jisx0213', 'Shift_JIS-2004']],
    'euc-jp': [[0xc6, 0xfc, 0xcb, 0xdc], '日本', ['eucjp', 'EUC_JP', 'ujis', 'x-eucjp', 'x-euc-jp', 'eucjp-ms', 'euc-jis-2004', 'euc-jisx0213']],
    gbk: [[0xd6, 0xd0, 0xce, 0xc4], '中文', ['euc-cn', 'euccn', 'x-euc-cn', 'GB-2312', 'cp936', 'ms936', 'windows-936', 'x-cp936']],
    'euc-kr': [[0xc7, 0xd1, 0xb1, 0xdb], '한글', ['euckr', 'EUC_KR', 'ks_c_5601', 'cp949', 'ms949', 'windows-949', 'x-windows-949', 'uhc']],
    big5: [[0xa4, 0xa4, 0xa4, 0xe5], '中文', ['big-5', 'x-big5', 'big5hkscs', 'big5_hkscs', 'cp950', 'ms950', 'windows-950', 'x-windows-950']],
  };
  for (const [bytes, expected, labels] of Object.values(samples)) {
    for (const label of labels) assert.equal(M.decodeBytes(Buffer.from(bytes), label), expected, label);
  }
});

test('parameter names that exist on Object.prototype', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const raw = `Content-Type: text/plain; ${name}=x; charset=utf-8\r\nContent-Disposition: inline; ${name}=y\r\n\r\nbody`;
    assert.equal(M.parseEmail(Buffer.from(raw)).text, 'body', name);
  }
});

test('RFC 2231 name wins over the plain one', () => {
  const raw = 'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="plain.pdf"; filename*=UTF-8\'\'%E3%81%82.pdf\r\n\r\nx';
  assert.equal(M.parseEmail(Buffer.from(raw)).attachments[0].filename, 'あ.pdf');
});

test('mbox separator line and UTF-8 BOM before the headers', () => {
  const mbox = M.parseEmail(Buffer.from('From a@example.com Thu Jan  1 00:00:00 2026\r\nSubject: x\r\n\r\nbody'));
  assert.deepEqual(mbox.headers.map((h) => h.name), ['Subject']);
  const bom = M.parseEmail(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Subject: x\r\n\r\nbody')]));
  assert.equal(bom.subject, 'x');
});

test('hasRemoteContent finds what can load and ignores what cannot', () => {
  const remote = [
    '<img src="https://x.example/a.png">',
    "<img src='http://x.example/a.png'>",
    '<img/src=https://x.example/a.png>',
    '<img SRC = "HTTPS://x.example/a.png">',
    '<img srcset="https://x.example/a.png 2x">',
    '<body background="https://x.example/a.png">',
    '<video poster="https://x.example/a.png">',
    '<div style="background:url(https://x.example/a.png)">',
    '<style>@import "https://x.example/a.css";</style>',
    '<link rel="stylesheet" href="https://x.example/a.css">',
    '<svg><image href="https://x.example/a.png"/></svg>',
    '<svg><image xlink:href="https://x.example/a.png"/></svg>',
  ];
  for (const html of remote) assert.equal(M.hasRemoteContent(html), true, html);
  const local = [
    '<a href="https://x.example/">link</a>',
    '<img src="data:image/png;base64,AAAA">',
    '<img src="cid:a@example">',
    '<img data-src="https://x.example/a.png">',
    'see https://x.example/',
  ];
  for (const html of local) assert.equal(M.hasRemoteContent(html), false, html);
});

const HOSTILE_HTML = [
  '<link '.repeat(200000),
  '<image '.repeat(200000),
  ' src'.repeat(300000),
  'url('.repeat(300000),
  ' '.repeat(1200000),
  '<img src=' + ' '.repeat(1000000),
  '<img src= "' + ' '.repeat(1000000),
  'url(' + ' '.repeat(1000000),
  '<link href=' + ' '.repeat(1000000),
  '@import ' + ' '.repeat(1000000),
  '<!--'.repeat(300000),
];

test('hasRemoteContent stays fast on hostile input', () => {
  for (const html of HOSTILE_HTML) {
    const start = Date.now();
    M.hasRemoteContent(html);
    assert.ok(Date.now() - start < 1000, `${html.slice(0, 12)}: ${Date.now() - start} ms`);
  }
});

test('parsing stays fast on hostile input', () => {
  const inputs = [
    ...HOSTILE_HTML.map((html) => 'Content-Type: text/html\r\n\r\n' + html),
    `Content-Type: text/plain; charset=a${"'".repeat(1000000)}b\r\n\r\nbody`,
    `Subject: ${' '.repeat(1000000)}x\r\n\r\nbody`,
    `Content-Disposition: attachment; filename=${' '.repeat(1000000)}x\r\n\r\nbody`,
  ];
  for (const raw of inputs) {
    const start = Date.now();
    M.parseEmail(Buffer.from(raw));
    assert.ok(Date.now() - start < 1000, `${raw.slice(0, 50)}: ${Date.now() - start} ms`);
  }
});

test('8-bit header values keep a last byte of 0xA0', (t) => {
  t.after(() => M.setLocale(''));
  const raw = (head, value) => Buffer.concat([Buffer.from(head), value, Buffer.from('\r\n\r\nbody')]);
  for (const locale of ['en', 'ja']) {
    M.setLocale(locale);
    for (const s of ['\u30b2\u30fc\u30e0', '\u3053\u308c\u3060', 'voil\u00e0']) {
      assert.equal(M.parseEmail(raw('Subject: ', Buffer.from(s, 'utf8'))).subject, s, locale);
      const file = M.parseEmail(raw('Content-Type: application/pdf\r\nContent-Disposition: attachment; filename=', Buffer.from(s, 'utf8')));
      assert.equal(file.attachments[0].filename, s, locale);
    }
    assert.equal(M.parseEmail(raw('Subject:  \t', Buffer.from('spaces  \t'))).subject, 'spaces', locale);
  }
  M.setLocale('ja');
  assert.equal(M.parseEmail(raw('Subject: ', Buffer.from([0x82, 0xa0, 0x82, 0xa0]))).subject, '\u3042\u3042');
});

test('an attachment leaves the list only when the HTML really loads an image', () => {
  const mail = (html, type = 'image/png') => M.parseEmail(Buffer.from(
    'Content-Type: multipart/mixed; boundary=B\r\n\r\n' +
    `--B\r\nContent-Type: text/html\r\n\r\n${html}\r\n` +
    `--B\r\nContent-Type: ${type}\r\nContent-ID: <x1@example>\r\n\r\ndata\r\n--B--\r\n`
  )).attachments[0].referenced;

  assert.equal(mail('<img src="cid:x1@example">'), true);
  assert.equal(mail('<img src="CID:X1@EXAMPLE">'), true);
  assert.equal(mail("<img src='cid:x1%40example'>"), true);
  assert.equal(mail('<img src=cid:x1@example>'), true);
  assert.equal(mail('<div style="background:url(cid:x1@example)">'), true);
  assert.equal(mail('<body background="cid:x1@example">'), true);

  assert.equal(mail('<!-- cid:x1@example -->'), false);
  assert.equal(mail('<!-- <img src="cid:x1@example"> -->'), false);
  assert.equal(mail('see cid:x1@example'), false);
  assert.equal(mail('<a href="cid:x1@example">file</a>'), false);
  assert.equal(mail('<img src="cid:x1@example">', 'application/pdf'), false, 'not an image');
  assert.equal(mail('<img src="cid:x1@example">', 'image/png\r\nContent-Disposition: attachment'), false, 'says it is an attachment');
  assert.equal(mail('<img src="cid:x1@example">', 'image/png\r\nContent-Disposition: inline'), true);
});

test('format characters are removed from attachment names, except the emoji joiner', () => {
  const names = (encoded) => M.parseEmail(Buffer.from(`Content-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''${encoded}\r\n\r\nx`)).attachments[0].filename;
  assert.equal(names('a%E2%80%AEb.pdf'), 'ab.pdf', 'U+202E');
  assert.equal(names('a%E2%81%A1b.pdf'), 'ab.pdf', 'U+2061');
  assert.equal(names('a%EF%BF%B9b.pdf'), 'ab.pdf', 'U+FFF9');
  assert.equal(names('a%F3%A0%81%A5b.pdf'), 'ab.pdf', 'U+E0065');
  assert.equal(names('a%E2%80%8Db.pdf'), 'a\u200db.pdf', 'U+200D');
});

test('hostile fixture: nothing is hidden from the attachment list', () => {
  const r = fixture('5_safety_check.eml');
  assert.equal(r.attachments.length, 4);
  assert.equal(r.attachments.filter((a) => a.referenced).length, 0);
  assert.equal(M.hasRemoteContent(r.html), true);
  assert.equal(r.attachments[2].filename, 'invoicegnp.exe', 'name cannot be disguised on screen');
});

test('text after the closing dashes does not end the multipart', () => {
  const att = 'Content-Disposition: attachment; filename="hidden.pdf"\r\n\r\ndummy\r\n';
  const inBody = `Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nline\r\n--B--not-the-end\r\nmore\r\n--B\r\n${att}--B--\r\n`;
  const r = M.parseEmail(Buffer.from(inBody));
  assert.deepEqual(r.attachments.map((a) => a.filename), ['hidden.pdf']);
  assert.match(r.text, /--B--not-the-end/);

  const nested = 'Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: multipart/mixed; boundary=B--x\r\n\r\n' +
    `--B--x\r\n${att}--B--x--\r\n--B\r\nContent-Disposition: attachment; filename="second.pdf"\r\n\r\ndummy\r\n--B--\r\n`;
  assert.deepEqual(M.parseEmail(Buffer.from(nested)).attachments.map((a) => a.filename), ['hidden.pdf', 'second.pdf']);

  for (const tail of ['--B-- x', '--B--\tx', '--B--  x', '--B x']) {
    const raw = `Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nline\r\n${tail}\r\nmore\r\n--B\r\n${att}--B--\r\n`;
    const parsed = M.parseEmail(Buffer.from(raw));
    assert.deepEqual(parsed.attachments.map((a) => a.filename), ['hidden.pdf'], JSON.stringify(tail));
    assert.ok(parsed.text.includes(tail), JSON.stringify(tail));
  }

  for (const close of ['--B--', '--B-- ', '--B--\t', '--B--  \t', '--B--\n']) {
    const raw = `Content-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\n\r\nhello\r\n${close}\r\n--B\r\n${att}`;
    assert.equal(M.parseEmail(Buffer.from(raw)).attachments.length, 0, JSON.stringify(close));
  }
});

test('a charset that changes on every encoded word creates few decoders', (t) => {
  // Counted rather than timed, because a time limit fails on a busy machine.
  const Original = globalThis.TextDecoder;
  let created = 0;
  globalThis.TextDecoder = class extends Original {
    constructor(...args) {
      created++;
      super(...args);
    }
  };
  t.after(() => { globalThis.TextDecoder = Original; });
  const parse = (raw) => {
    created = 0;
    M.parseEmail(Buffer.from(raw));
    return created;
  };
  const words = 20000;
  assert.ok(parse(`Subject: ${'=?x?B??= =?y?B??= '.repeat(words)}\r\n\r\nbody`) < 20);
  assert.ok(parse(`Subject: ${'=?koi8-r?B?QQ==?= =?big5?B?QQ==?= '.repeat(words)}\r\n\r\nbody`) < 20);
  assert.ok(parse(`Content-Disposition: attachment; filename="${'=?x?B?QQ==?= =?y?B?QQ==?= '.repeat(words)}"\r\n\r\nbody`) < 20);
  const unique = Array.from({ length: words }, (_, i) => `=?x${i}?B?QQ==?=`).join(' ');
  assert.ok(parse(`Subject: ${unique}\r\n\r\nbody`) < 300);
});

test('strict and lenient decoders of one charset are kept apart', () => {
  // The header uses the lenient UTF-8 decoder. If the guess for the body got it too, the body would not fall back.
  const r = M.parseEmail(Buffer.from('Subject: =?utf-8?B?/w==?=\r\nContent-Type: text/plain\r\n\r\ncaf\xe9', 'latin1'));
  assert.equal(r.text, 'caf\u00e9');
});

test('a mail that exhausts the decoder limit does not affect the next one', () => {
  const words = Array.from({ length: 1000 }, (_, i) => `=?x${i}?B?QQ==?=`).join(' ');
  M.parseEmail(Buffer.from(`Subject: ${words}\r\n\r\nbody`));
  // a charset no other test uses, so it cannot already be among the kept decoders
  const ibm866 = Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]);
  const r = M.parseEmail(Buffer.from(`Subject: =?ibm866?B?${ibm866.toString('base64')}?=\r\n\r\nbody`));
  assert.equal(r.subject, 'Привет');
});

test('a decoder can be used again after it rejected some bytes', () => {
  const raw = 'Subject: =?x?B?/w==?= =?utf-8?B?44GC?=\r\nContent-Type: text/plain\r\n\r\n\xe3\x81\x82';
  const r = M.parseEmail(Buffer.from(raw, 'latin1'));
  assert.ok(r.subject.endsWith('あ'), r.subject);
  assert.equal(r.text, 'あ');
});

test('message without boundary end or headers still parses', () => {
  const raw = 'Subject: x\r\nContent-Type: multipart/mixed; boundary=B\r\n\r\n--B\r\n\r\nhello\r\n--B\r\nContent-Type: text/plain\r\n\r\nworld';
  const r = M.parseEmail(Buffer.from(raw));
  assert.equal(r.text, 'hello\n\nworld');
});
