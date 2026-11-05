/* global acquireVsCodeApi, EmlMime, EmlI18n */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const saved = vscode.getState() || {};
  const locale = document.documentElement.lang || 'en';
  const t = EmlI18n.forLocale(locale);
  EmlMime.setLocale(locale);

  let model = null;
  let tab = saved.tab || null;
  let remoteImages = false;

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === 'load') {
      try {
        model = EmlMime.parseEmail(EmlMime.b64ToBytes(msg.data));
        remoteImages = false; // the permission was for the previous content of the file
        render();
      } catch (e) {
        showError(t('parseFailed', e && e.message ? e.message : e));
      }
    } else if (msg.type === 'error') {
      showError(msg.message);
    }
  });

  vscode.postMessage({ type: 'ready' });

  // ------------------------------------------------------------ helpers

  function el(tag, attrs) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    const kids = Array.prototype.slice.call(arguments, 2).flat(Infinity);
    for (const c of kids) {
      if (c == null || c === false) continue;
      e.append(c instanceof Node ? c : String(c));
    }
    return e;
  }

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatDate(raw) {
    if (!raw) return '';
    const time = Date.parse(raw.replace(/\([^()]*\)/g, '').trim());
    if (isNaN(time)) return raw;
    try {
      return new Date(time).toLocaleString(locale, {
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
        hour: '2-digit', minute: '2-digit',
      });
    } catch (e) {
      return raw; // locale tag the runtime rejects
    }
  }

  function openLink(href) {
    vscode.postMessage({ type: 'openLink', href });
  }

  function showError(message) {
    app.replaceChildren(
      el('div', { class: 'error' },
        el('p', null, message),
        el('button', { class: 'btn', onclick: () => vscode.postMessage({ type: 'openAsText' }) }, t('viewSource')))
    );
  }

  // ------------------------------------------------------------- render

  function metaRow(label, value, title) {
    if (!value) return null;
    return el('div', { class: 'row' },
      el('span', { class: 'label' }, label),
      el('span', { class: 'value', title: title || value }, value));
  }

  function render() {
    const m = model;
    const tabs = [];
    if (m.html !== null) tabs.push(['html', 'HTML']);
    if (m.text !== null) tabs.push(['text', t('tabText')]);
    tabs.push(['headers', t('tabHeaders')]);
    if (!tab || !tabs.some((t) => t[0] === tab)) tab = tabs[0][0];

    const atts = m.attachments.filter((a) => !a.referenced);
    const hasRemote = m.html !== null && EmlMime.hasRemoteContent(m.html);

    const header = el('header', { class: 'hdr' },
      el('h1', { class: 'subject', title: m.subject }, m.subject || t('noSubject')),
      el('div', { class: 'meta' },
        metaRow(t('from'), m.from),
        metaRow(t('to'), m.to),
        metaRow('CC', m.cc),
        metaRow('BCC', m.bcc),
        metaRow(t('replyTo'), m.replyTo),
        metaRow(t('date'), formatDate(m.date), m.date)),
      atts.length
        ? el('div', { class: 'atts' },
          el('span', { class: 'label' }, t('attachments', atts.length)),
          atts.map((a) => el('button', {
            class: 'att',
            title: a.filename + '\n' + a.contentType + '\n' + t('clickToSave'),
            onclick: () => vscode.postMessage({ type: 'saveAttachment', index: a.index, filename: a.filename }),
          }, el('span', { class: 'att-name' }, a.filename), el('span', { class: 'att-size' }, formatSize(a.size)))),
          atts.length > 1
            ? el('button', {
              class: 'btn',
              onclick: () => vscode.postMessage({
                type: 'saveAll',
                items: atts.map((a) => ({ index: a.index, filename: a.filename })),
              }),
            }, t('saveAll'))
            : null)
        : null,
      el('div', { class: 'toolbar' },
        el('div', { class: 'tabs', role: 'tablist' },
          tabs.map(([id, label]) => el('button', {
            class: 'tab' + (id === tab ? ' active' : ''),
            role: 'tab',
            'aria-selected': id === tab ? 'true' : 'false',
            onclick: () => {
              tab = id;
              vscode.setState({ tab });
              render();
            },
          }, label))),
        el('div', { class: 'actions' },
          tab === 'html' && hasRemote
            ? el('button', {
              class: 'btn',
              title: t('remoteTitle'),
              onclick: () => {
                remoteImages = !remoteImages;
                render();
              },
            }, remoteImages ? t('hideRemote') : t('showRemote'))
            : null,
          el('button', {
            class: 'btn',
            title: t('viewSourceTitle'),
            onclick: () => vscode.postMessage({ type: 'openAsText' }),
          }, t('viewSource'))))
    );

    app.replaceChildren(header, el('main', { class: 'content content-' + tab }, renderBody()));
  }

  function renderBody() {
    const m = model;
    if (tab === 'html') return renderHtml(m.html);
    if (tab === 'text') return renderText(m.text);
    if (tab === 'headers') {
      return el('table', { class: 'hdr-table' },
        el('tbody', null, m.headers.map((h) => el('tr', null, el('th', null, h.name), el('td', null, h.value)))));
    }
    return el('div', { class: 'empty' }, t('noBody'));
  }

  function renderText(t) {
    const pre = el('pre', { class: 'plain' });
    const re = /\bhttps?:\/\/[^\s<>"'（）「」『』、。]+/g;
    let last = 0;
    let m;
    while ((m = re.exec(t))) {
      let end = m[0].length;
      while (end > 0 && ').,;:!?'.includes(m[0][end - 1])) end--; // sentence punctuation is not part of the link
      const url = m[0].slice(0, end);
      pre.append(t.slice(last, m.index));
      pre.append(el('a', { href: '#', title: url, onclick: (ev) => { ev.preventDefault(); openLink(url); } }, url));
      last = m.index + url.length;
      re.lastIndex = last;
    }
    pre.append(t.slice(last));
    return pre;
  }

  // The doctype decides how markup parses (<p><table> closes the <p> only in no-quirks mode), so the cleaning
  // and the frame must both start with it. Without it, Chromium parses a srcdoc by the quirks rules even
  // though the document reports no-quirks mode, and a parser that follows the standard would not.
  const DOCTYPE = '<!doctype html>';

  // Removes what acts outside the frame's CSP: other <link> types (preconnect, prefetch...), <meta http-equiv>,
  // and nested frames, whose srcdoc holds markup that querySelectorAll cannot see. <template> goes too:
  // querySelectorAll cannot see inside it either, and the frame turns <template shadowrootmode> into live elements.
  // Elements like <img name="head"> can shadow the document's own members, so reach them through the prototype.
  function cleanHtml(html) {
    const doc = new DOMParser().parseFromString(DOCTYPE + html, 'text/html');
    Document.prototype.querySelectorAll.call(doc, 'link, meta[http-equiv], iframe, frame, object, embed, template').forEach((n) => {
      if (remoteImages && n.localName === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(n.getAttribute('rel') || '')) {
        n.setAttribute('rel', 'stylesheet');
      } else {
        n.remove();
      }
    });
    return Object.getOwnPropertyDescriptor(Document.prototype, 'documentElement').get.call(doc).outerHTML;
  }

  // Serialising and parsing again can turn text into elements (<math><style>...), so clean until nothing
  // changes. If that never happens, the markup cannot be trusted and is shown as text.
  function cleanUntilStable(html) {
    let current = html;
    for (let i = 0; i < 8; i++) {
      const next = cleanHtml(current);
      if (next === current) return current;
      current = next;
    }
    return '<pre>' + current.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
  }

  function buildSrcdoc(html) {
    const byCid = new Map();
    for (const a of model.attachments) if (a.contentId) byCid.set(a.contentId.toLowerCase(), a);
    const cache = new Map();
    html = html.replace(/cid:([^"'\s)>]+)/gi, (all, id) => {
      let key = id;
      try { key = decodeURIComponent(id); } catch (e) { /* keep */ }
      const a = byCid.get(key.toLowerCase());
      if (!a) return all;
      if (!cache.has(a)) {
        cache.set(a, 'data:' + (a.contentType || 'application/octet-stream') + ';base64,' + EmlMime.bytesToB64(a.bytes));
      }
      return cache.get(a);
    });

    const images = remoteImages ? ' https: http:' : '';
    const others = remoteImages ? ' https:' : '';
    const csp = "default-src 'none'; img-src data:" + images + "; style-src 'unsafe-inline'" + others +
      '; font-src data:' + others + '; media-src data:' + others;
    const jaFonts = /^ja\b/i.test(locale) ? '"Yu Gothic UI",Meiryo,' : '';

    // Prepended as text, so the policy is the first thing the parser sees and nothing in the mail can
    // move it. This matters because the page's outer CSP allows remote content.
    return DOCTYPE + '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
      '<meta http-equiv="x-dns-prefetch-control" content="off">' +
      '<style>html{background:#fff;color:#000}body{margin:16px;font-family:system-ui,"Segoe UI",' + jaFonts +
      'sans-serif;line-height:1.6}img{max-width:100%;height:auto}</style>' +
      cleanUntilStable(html);
  }

  function renderHtml(html) {
    // no allow-scripts: the mail's own scripts never run. allow-same-origin lets us catch link clicks.
    const frame = el('iframe', { class: 'mail-frame', sandbox: 'allow-same-origin', title: t('mailBody') });
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      // Through the prototypes: the mail can shadow these with <img name="addEventListener"> or <input name="closest">.
      EventTarget.prototype.addEventListener.call(doc, 'click', (ev) => {
        const a = Element.prototype.closest.call(ev.target, 'a[href]');
        if (!a) return;
        ev.preventDefault();
        const href = a.getAttribute('href') || '';
        if (href.startsWith('#')) {
          const id = href.slice(1);
          const target = Document.prototype.getElementById.call(doc, id) ||
            Document.prototype.getElementsByName.call(doc, id)[0];
          if (target) Element.prototype.scrollIntoView.call(target);
          return;
        }
        openLink(a.href);
      });
    });
    frame.srcdoc = buildSrcdoc(html);
    return frame;
  }
})();
