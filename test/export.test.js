'use strict';

// The parts of the export that decide what is kept. The DOM is a small fake tree here; the real one is
// checked by hand (see DEVELOPMENT.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../media/export.js');

// ------------------------------------------------------------- fake DOM

function h(tag, attrs, ...kids) {
  const node = { type: 1, tag, attrs: Object.entries(attrs || {}), children: [], parent: null };
  for (const k of kids.flat()) {
    const child = typeof k === 'string' ? { type: 3, value: k } : k; // { type: 8 } is a comment
    child.parent = node;
    node.children.push(child);
  }
  return node;
}

const dom = {
  children: (n) => n.children.slice(),
  isElement: (n) => n.type === 1,
  isText: (n) => n.type === 3,
  text: (n) => n.value,
  tag: (n) => n.tag,
  attrNames: (n) => n.attrs.map((a) => a[0]),
  getAttr: (n, k) => {
    const a = n.attrs.find((x) => x[0] === k);
    return a ? a[1] : null;
  },
  setAttr: (n, k, v) => {
    if (!/^[a-z][a-z0-9:-]*$/i.test(k)) throw new Error(`'${k}' is not a valid attribute name.`);
    const a = n.attrs.find((x) => x[0] === k);
    if (a) a[1] = v;
    else n.attrs.push([k, v]);
  },
  removeAttr: (n, k) => {
    n.attrs = n.attrs.filter((x) => x[0] !== k);
  },
  setText: (n, v) => {
    n.value = v;
  },
  remove: (n) => {
    n.parent.children.splice(n.parent.children.indexOf(n), 1);
  },
};

const attrsOf = (n) => Object.fromEntries(n.attrs);
const tags = (n) => n.children.filter((c) => c.type === 1).map((c) => c.tag);

const T = (key, arg) => ({ image: '画像', imageNamed: '画像: ' + arg })[key];
const md = (body, opts) => X.htmlToMarkdown(h('body', null, body), dom, Object.assign({ t: T }, opts));

// ----------------------------------------------------------------- links

test('only http, https and mailto links survive, as the browser reads them', () => {
  assert.equal(X.safeLink('https://example.com/r?u=a%2Fb%26c'), 'https://example.com/r?u=a%2Fb%26c');
  assert.equal(X.safeLink('  HTTPS://Example.com/a b '), 'https://example.com/a%20b');
  assert.equal(X.safeLink('mailto:a@example.com'), 'mailto:a@example.com');
  for (const bad of ['javascript:alert(1)', 'java\nscript:alert(1)', ' javascript:x', 'file:///etc/passwd', '\\\\server\\share\\x',
    'vscode://settings', 'command:x', 'data:text/html,x', '//example.com/', 'relative/path', '', null, undefined, 42]) {
    assert.equal(X.safeLink(bad), null, String(bad));
  }
});

test('relative links resolve only against an http(s) base', () => {
  assert.equal(X.baseUrl('https://example.com/news/'), 'https://example.com/news/');
  assert.equal(X.baseUrl('file:///c:/'), null);
  assert.equal(X.baseUrl('javascript:x'), null);
  assert.equal(X.baseUrl('relative/'), null);
  assert.equal(X.safeLink('a?b=1', 'https://example.com/news/'), 'https://example.com/news/a?b=1');
  assert.equal(X.safeLink('javascript:x', 'https://example.com/'), null);
});

test('splitLinks keeps sentence punctuation out of the link', () => {
  assert.deepEqual(X.splitLinks('see https://example.com/a. and (https://example.com/b)'), [
    { text: 'see ' }, { url: 'https://example.com/a' }, { text: '. and (' }, { url: 'https://example.com/b' }, { text: ')' },
  ]);
  assert.deepEqual(X.splitLinks('no links'), [{ text: 'no links' }]);
  assert.deepEqual(X.splitLinks(''), []);
});

// -------------------------------------------------------------- sanitize

test('remote, local and network references are removed, data: stays', () => {
  const root = h('html', { manifest: 'https://remote.example.invalid/m' },
    h('body', { background: 'https://remote.example.invalid/bg.png', onload: 'x()' },
      h('img', { src: 'https://remote.example.invalid/1.png', alt: 'one' }),
      h('img', { src: 'file:///C:/secret.png' }),
      h('img', { src: '\\\\server\\share\\x.png' }),
      h('img', { src: ' data:image/png;base64,AAAA', srcset: 'https://remote.example.invalid/2x.png 2x' }),
      h('img', { src: 'cid:missing@example' }),
      h('video', { poster: 'https://remote.example.invalid/p.png', src: 'http://remote.example.invalid/v.mp4' }),
      h('input', { type: 'image', src: 'https://remote.example.invalid/i.png', onfocus: 'x()' }),
      h('svg', null, h('image', { 'xlink:href': 'https://remote.example.invalid/s.png' }), h('use', { href: '#local' })),
      h('form', { action: 'https://remote.example.invalid/post' }, h('button', { formaction: 'https://remote.example.invalid/b' }, 'go'))));
  const removed = X.sanitize(root, dom, null);

  assert.deepEqual(attrsOf(root), {});
  const body = root.children[0];
  assert.deepEqual(attrsOf(body), {});
  const [one, file, unc, data, cid, video, input, svg, form] = body.children;
  assert.deepEqual(attrsOf(one), { alt: 'one' });
  assert.deepEqual(attrsOf(file), {});
  assert.deepEqual(attrsOf(unc), {});
  assert.deepEqual(attrsOf(data), { src: ' data:image/png;base64,AAAA' });
  assert.deepEqual(attrsOf(cid), {});
  assert.deepEqual(attrsOf(video), {});
  assert.deepEqual(attrsOf(input), { type: 'image' });
  assert.deepEqual(attrsOf(svg.children[0]), {});
  assert.deepEqual(attrsOf(svg.children[1]), { href: '#local' });
  assert.deepEqual(attrsOf(form), {});
  assert.deepEqual(attrsOf(form.children[0]), {});
  // manifest, background, 1.png, file, unc, srcset, poster, v.mp4, i.png, s.png (not the cid, not the form)
  assert.equal(removed, 10);
});

test('elements that run or load something are removed', () => {
  const root = h('html', null,
    h('head', null,
      h('meta', { 'http-equiv': 'refresh', content: '0;url=https://remote.example.invalid/' }),
      h('base', { href: 'https://remote.example.invalid/' }),
      h('link', { rel: 'stylesheet', href: 'https://remote.example.invalid/a.css' }),
      h('title', null, 'x'),
      h('style', null, 'p{color:red}')),
    h('body', null,
      h('script', null, 'alert(1)'),
      h('noscript', null, h('img', { src: 'https://remote.example.invalid/n.png' })),
      h('iframe', { src: 'https://remote.example.invalid/f' }),
      h('object', { data: 'https://remote.example.invalid/o' }),
      h('embed', { src: 'https://remote.example.invalid/e' }),
      h('template', null),
      h('svg', null, h('a', { href: '#' }, h('set', { attributeName: 'href', to: 'javascript:alert(1)' })), h('animate', null)),
      h('p', null, 'kept')));
  const removed = X.sanitize(root, dom, null);
  assert.deepEqual(tags(root.children[0]), ['style']);
  assert.deepEqual(tags(root.children[1]), ['svg', 'p']);
  assert.deepEqual(tags(root.children[1].children[0].children[0]), []);
  assert.equal(removed, 4); // link, iframe, object, embed
});

test('links are kept only when safe, and written as the browser reads them', () => {
  const body = h('body', null,
    h('a', { href: 'https://example.com/?q=a%26b', ping: 'https://remote.example.invalid/ping' }, 'ok'),
    h('a', { href: ' HTTPS://Example.com/x' }, 'normalised'),
    h('a', { href: 'javascript:alert(1)' }, 'js'),
    h('a', { href: 'file:///etc/passwd' }, 'file'),
    h('a', { href: '#top' }, 'fragment'),
    h('a', { href: 'page.html' }, 'relative'),
    h('area', { href: 'vbscript:x' }),
    h('svg', null, h('a', { 'xlink:href': 'javascript:alert(1)' }, 'svg')));
  X.sanitize(body, dom, null);
  const a = body.children;
  assert.deepEqual(attrsOf(a[0]), { href: 'https://example.com/?q=a%26b' });
  assert.deepEqual(attrsOf(a[1]), { href: 'https://example.com/x' });
  assert.deepEqual(attrsOf(a[2]), {});
  assert.deepEqual(attrsOf(a[3]), {});
  assert.deepEqual(attrsOf(a[4]), { href: '#top' });
  assert.deepEqual(attrsOf(a[5]), {});
  assert.deepEqual(attrsOf(a[6]), {});
  assert.deepEqual(attrsOf(a[7].children[0]), {});

  const based = h('body', null, h('a', { href: 'page.html' }, 'relative'));
  X.sanitize(based, dom, 'https://example.com/news/');
  assert.deepEqual(attrsOf(based.children[0]), { href: 'https://example.com/news/page.html' });
});

test('every event handler goes, whatever its case or prefix', () => {
  const el = h('div', { onclick: 'x', ONMOUSEOVER: 'x', 'xlink:onload': 'x', class: 'c', style: 'color:red' });
  X.sanitize(h('body', null, el), dom, null);
  assert.deepEqual(attrsOf(el), { class: 'c', style: 'color:red' });
});

test('the exported HTML starts with its policy, before anything from the mail', () => {
  const head = X.htmlHead('<\/title><script>alert(1)<\/script>', 'ja');
  assert.ok(head.startsWith('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + X.EXPORT_CSP + '">'));
  assert.ok(head.includes('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>'));
  assert.match(X.EXPORT_CSP, /^default-src 'none';/);
  assert.match(X.EXPORT_CSP, /(?:^|; )form-action 'none'(?:;|$)/);
  assert.match(X.EXPORT_CSP, /(?:^|; )base-uri 'none'(?:;|$)/);
  assert.ok(!/script-src|https?:|\*|unsafe-eval/.test(X.EXPORT_CSP));
});

test('header values and text bodies are escaped', () => {
  const summary = { subject: '<b>s</b>', rows: [['From', '"A" <a@example.com>']], notes: ['n & m'] };
  const header = X.headerHtml(summary);
  assert.ok(header.includes('<h1>&lt;b&gt;s&lt;/b&gt;</h1>'));
  assert.ok(header.includes('<td>&quot;A&quot; &lt;a@example.com&gt;</td>'));
  assert.ok(header.includes('n &amp; m'));

  const doc = X.textDocument(summary, '\n<img src=x onerror=alert(1)> https://example.com/?a=1&b="2"', 'en');
  assert.ok(doc.includes('<pre class="eml-export-text">\n\n&lt;img src=x onerror=alert(1)&gt; <a href="https://example.com/?a=1&amp;b=">https://example.com/?a=1&amp;b=</a>&quot;2&quot;</pre>'));
  assert.ok(!/<img/i.test(doc));
});

// -------------------------------------------------------------- Markdown

test('text from the mail never becomes markup', () => {
  const evil = '<img src=x> ![x](https://remote.example.invalid/md.png) [x](javascript:alert(1)) &lt; `c` *e* _u_ ~~s~~ | $1 \\';
  const out = X.textToMarkdown(evil);
  assert.equal(out, '\\<img src=x\\> \\!\\[x\\](<https://remote.example.invalid/md.png>) \\[x\\](javascript:alert(1)) \\&lt; \\`c\\` \\*e\\* \\_u\\_ \\~\\~s\\~\\~ \\| \\$1 \\\\');
  const fromHtml = md(h('p', null, evil));
  // nothing unescaped but the autolink
  assert.ok(!/(?:^|[^\\])[<[&!]/.test(fromHtml.replace(/\\\\/g, '').replace('<https://remote.example.invalid/md.png>', '')), fromHtml);
  assert.ok(!fromHtml.includes('!['));
});

test('characters that start a block are escaped at the start of a line', () => {
  assert.equal(X.textToMarkdown('# not a heading\n- not a list\n1. not a list\n-----\n+ x\n===\n2026) x'),
    ['\\# not a heading  ', '\\- not a list  ', '1\\. not a list  ', '\\-----  ', '\\+ x  ', '\\===  ', '2026\\) x'].join('\n'));
  assert.equal(md([h('p', null, '# a'), h('p', null, 'x', h('br'), '- b', h('br'), ' 10. c')]), '\\# a\n\nx  \n\\- b  \n10\\. c');
});

test('quotes, indentation and paragraphs in text bodies', () => {
  const out = X.textToMarkdown('Hello\n\n> quoted\n> more\n>> deeper\nback\n    indented\nhttps://example.com/a_b');
  assert.equal(out, [
    'Hello',
    '',
    '> quoted  ',
    '> more',
    '',
    '> > deeper',
    '',
    'back  ',
    '\u00a0\u00a0\u00a0\u00a0indented  ',
    '<https://example.com/a_b>',
  ].join('\n'));
});

test('HTML structure becomes Markdown', () => {
  const out = md([
    h('h2', null, 'Title #'),
    h('p', null, 'Some ', h('b', null, 'bold '), 'and ', h('i', null, 'italic'), ' and ', h('code', null, 'a`b'), '.'),
    h('ul', null, h('li', null, 'one'), h('li', null, 'two', h('ol', { start: '3' }, h('li', null, 'three')))),
    h('blockquote', null, h('p', null, 'q1'), h('p', null, 'q2')),
    h('pre', null, 'line 1\n```\nline 2\n'),
    h('hr'),
    h('div', null, h('span', null, h('div', null, 'block in span'), h('div', null, 'second'))),
  ]);
  assert.equal(out, [
    '## Title \\#',
    '',
    'Some **bold** and *italic* and ``a`b``.',
    '',
    '- one',
    '- two',
    '',
    '  3. three',
    '',
    '> q1',
    '>',
    '> q2',
    '',
    '````\nline 1\n```\nline 2\n````',
    '',
    '___',
    '',
    'block in span',
    '',
    'second',
  ].join('\n'));
});

test('links and images: nothing loads when the Markdown is previewed', () => {
  const out = md([
    h('p', null, h('a', { href: 'https://example.com/a(b) c' }, 'link ', h('img', { src: 'https://remote.example.invalid/in-link.png', alt: 'logo' }))),
    h('p', null, h('a', { href: 'javascript:alert(1)' }, 'js link')),
    h('p', null, h('a', { href: 'mailto:a<b>@example.com' }, 'mail')),
    h('p', null, h('img', { src: 'https://remote.example.invalid/pic.png', alt: 'a ]pic[' })),
    h('p', null, h('img', { src: 'https://remote.example.invalid/pixel.gif', width: '1', height: '1' })),
    h('p', null, h('img', { src: 'cid:img1@example', alt: 'alt' })),
    h('p', null, h('img', { src: 'data:image/png;base64,AAAA', alt: 'inline' })),
    h('p', null, h('a', { href: 'rel' }, 'relative')),
  ], { cidName: (id) => (id === 'img1@example' ? 'photo.png' : null), base: 'https://example.com/' });
  assert.equal(out, [
    '[link logo](<https://example.com/a(b)%20c>)',
    'js link',
    '[mail](<mailto:a\\<b\\>@example.com>)',
    '[画像: a \\]pic\\[](<https://remote.example.invalid/pic.png>)',
    '\\[画像: photo.png\\]',
    '\\[画像: inline\\]',
    '[relative](<https://example.com/rel>)',
  ].join('\n\n'));
  assert.ok(!out.includes('!['));
});

test('hidden and non-content elements are skipped', () => {
  const out = md([
    h('div', { style: 'display: none' }, 'preheader'),
    h('div', { hidden: '' }, 'hidden'),
    h('style', null, 'p{}'),
    h('script', null, 'x'),
    h('p', { style: 'mso-hide:all' }, 'mso'),
    h('form', null, h('button', null, 'send'), h('input', { value: 'v' })),
    h('p', null, 'shown'),
  ]);
  assert.equal(out, 'shown');
});

test('text a crafted mail moved into <math> or <svg> is kept', () => {
  const out = md(h('math', null, h('mtext', null, h('p', null, h('a', { href: 'https://example.com/' }, 'link'))), h('svg', null, h('text', null, 'svg text'))));
  assert.equal(out, '[link](<https://example.com/>)\n\nsvg text');
});

test('deep nesting does not overflow the stack', () => {
  let node = h('span', null, 'deep');
  for (let i = 0; i < 20000; i++) node = h(i % 2 ? 'div' : 'span', null, node);
  assert.match(md(node), /deep/);
  let quiet = h('img', { src: 'https://remote.example.invalid/x.png' });
  for (let i = 0; i < 20000; i++) quiet = h('div', null, quiet);
  const root = h('html', null, h('body', null, quiet));
  assert.equal(X.sanitize(root, dom, null), 1);
});

test('the Markdown document has the header first', () => {
  const doc = X.markdownDocument({ subject: '[RE] #1 ##', rows: [['From', '<a@example.com>'], ['To', 'x\ny']], notes: [] }, 'body');
  assert.equal(doc, '# \\[RE\\] #1 \\##\n\n- **From:** \\<a@example.com\\>\n- **To:** x y\n\n---\n\nbody\n');
});

test('crafted input does not stall the export', () => {
  const start = Date.now();
  X.textToMarkdown(' '.repeat(200000) + 'x\n' + '>'.repeat(200000) + '\n' + '#'.repeat(200000) + 'a');
  X.markdownDocument({ subject: '#'.repeat(200000) + 'a', rows: [], notes: [] }, '');
  X.attrAction('img', 'src', ' '.repeat(200000) + 'x' + ' '.repeat(200000), null);
  md(h('pre', null, '\n'.repeat(200000) + 'x' + '\n'.repeat(200000)));
  assert.ok(Date.now() - start < 2000, `${Date.now() - start} ms`);
});

// ------------------------------------------------- found in review

test('a crafted attribute name is removed, not echoed in an error', () => {
  const a = h('a', { '=[retry](command:x)x:href': 'HTTP://example.com', title: 't' }, 'x');
  X.sanitize(h('body', null, a), dom, null);
  assert.deepEqual(attrsOf(a), { title: 't' });
});

test('comments go, and so do raw text elements; <style> loses its "<"', () => {
  const style = h('style', null, 'p{color:red}</style><meta http-equiv=refresh content=0>');
  const body = h('body', null,
    { type: 8, value: '[if gte mso 9]><v:image src="\\\\attacker\\share\\p.png"/><![endif]' },
    style,
    h('xmp', null, '<meta http-equiv=refresh>'), h('noembed', null, 'x'), h('noframes', null, 'x'), h('plaintext', null, 'x'),
    h('p', null, 'kept'));
  for (const c of body.children) c.parent = body;
  X.sanitize(body, dom, null);
  assert.deepEqual(body.children.map((c) => c.tag || c.type), ['style', 'p']);
  assert.equal(style.children[0].value, 'p{color:red}\\3c /style>\\3c meta http-equiv=refresh content=0>');
});

test('a srcset of embedded images is not counted as remote', () => {
  const img = h('img', { srcset: 'cid:a@example 2x', src: 'data:image/png;base64,AA' });
  assert.equal(X.sanitize(h('body', null, img), dom, null), 0);
});

test('emphasis is only written where CommonMark reads it', () => {
  const cases = [
    [h('p', null, 'これは', h('b', null, '重要'), 'です'), 'これは**重要**です'],
    [h('p', null, h('b', null, '【重要】'), 'お知らせ'), '【重要】お知らせ'],
    [h('p', null, '詳細は', h('b', null, h('a', { href: 'https://example.com/' }, 'こちら')), 'をご覧'), '詳細は[こちら](<https://example.com/>)をご覧'],
    [h('p', null, h('b', null, 'Total:\u00a0'), '100'), '**Total:**\u00a0100'],
    [h('p', null, h('b', null, h('span', null, 'Excel')), h('b', null, h('span', null, 'ファイル'))), '**Excelファイル**'],
    [h('p', null, h('b', null, h('b', null, 'x')), 'y'), '**x**y'],
    [h('p', null, h('b', null, 'a ', h('i', null, 'b')), 'c'), '**a *b***c'],
    [h('p', null, h('s', null, h('del', null, 'x')), ' after'), 'x after'],
  ];
  for (const [node, want] of cases) assert.equal(md(node), want);
  assert.equal(X.resolveEmphasis('a\uFDD0\uFDD1b'), 'ab');
});

test('the mail cannot fake emphasis with the placeholder characters', () => {
  assert.equal(md(h('p', null, 'a\uFDD0b\uFDD1c')), 'abc');
  assert.equal(X.textToMarkdown('a\uFDD2b\uFDD3c'), 'abc');
});

test('bare URLs become autolinks, so a preview that links them keeps them whole', () => {
  assert.equal(md(h('p', null, 'See https://example.com/a_b?x=1&y=2 and <https://example.com/>')),
    'See <https://example.com/a_b?x=1&y=2> and \\<<https://example.com/>\\>');
  assert.equal(md(h('p', null, h('a', { href: 'https://example.com/' }, 'https://example.com/a_b'))),
    '[https://example.com/a\\_b](<https://example.com/>)');
  assert.equal(X.textToMarkdown('http://\x01![a](https://evil.example/x.png)'), 'http://\x01\\!\\[a\\](<https://evil.example/x.png>)');
});

test('"!" right before a link does not make an image', () => {
  assert.equal(md(h('p', null, 'Thanks!', h('a', { href: 'https://evil.example/open.png' }, 'x'))),
    'Thanks\\![x](<https://evil.example/open.png>)');
});

test('entities in a link destination stay as written', () => {
  assert.equal(md(h('a', { href: 'https://example.com/?a=1&copy;b' }, 'x')), '[x](<https://example.com/?a=1\\&copy;b>)');
});

test('lists: text inside them, neighbours, long numbers and rules', () => {
  assert.equal(md(h('ul', null, 'Intro:', h('li', null, 'a'), 'tail')), 'Intro:\n\n- a\n\n  tail');
  assert.equal(md([h('ol', null, h('li', null, 'a')), h('ol', { start: '5' }, h('li', null, 'b'))]), '1. a\n\n5) b');
  assert.equal(md([h('div', null, h('ul', null, h('li', null, 'a'))), h('div', null, h('ul', null, h('li', null, 'b')))]), '- a\n\n* b');
  assert.equal(md(h('ol', { start: '999999999' }, h('li', null, 'a'), h('li', null, h('pre', null, '<img src=x>')))),
    '999999999. a\n- ```\n  <img src=x>\n  ```');
  assert.equal(md(h('ul', null, h('li', null, h('hr')))), '- ___');
});

test('a heading keeps a "#" before trailing spaces', () => {
  assert.equal(X.markdownDocument({ subject: 'Issue # ', rows: [], notes: [] }, ''), '# Issue \\#\n\n---\n');
});

test('deep quotes do not blow up the output', () => {
  let node = h('p', null, 'x\n'.repeat(1000));
  for (let i = 0; i < 300; i++) node = h('blockquote', null, node);
  const start = Date.now();
  const out = md(node);
  assert.ok(Date.now() - start < 2000, `${Date.now() - start} ms`);
  assert.ok(out.length < 100000, String(out.length));
  assert.ok(out.startsWith('> '.repeat(16) + 'x'), out.slice(0, 60));
});
