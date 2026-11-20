/* global acquireVsCodeApi, EmlMime, EmlI18n, EmlExport */
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
    } else if (msg.type === 'export' && (msg.format === 'html' || msg.format === 'md')) {
      try {
        if (!model) throw new Error(t('noMail'));
        const content = msg.format === 'md' ? exportMarkdown() : exportHtml();
        vscode.postMessage({ type: 'exported', format: msg.format, content });
      } catch (e) {
        // The message stays here: it can quote the mail (an attribute name), and a notification renders links.
        console.error(e);
        vscode.postMessage({ type: 'exportFailed' });
      }
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
            title: t('saveAsTitle'),
            onclick: () => vscode.postMessage({ type: 'saveAs' }),
          }, t('saveAs')),
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

  function renderText(text) {
    const pre = el('pre', { class: 'plain' });
    for (const p of EmlExport.splitLinks(text)) {
      if (p.url === undefined) {
        pre.append(p.text);
      } else {
        const url = p.url;
        pre.append(el('a', { href: '#', title: url, onclick: (ev) => { ev.preventDefault(); openLink(url); } }, url));
      }
    }
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
  // extra(doc), if given, cleans further before the document is serialised.
  function cleanHtml(html, allowRemote, extra) {
    const doc = new DOMParser().parseFromString(DOCTYPE + html, 'text/html');
    Document.prototype.querySelectorAll.call(doc, 'link, meta[http-equiv], iframe, frame, object, embed, template').forEach((n) => {
      if (allowRemote && n.localName === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(n.getAttribute('rel') || '')) {
        n.setAttribute('rel', 'stylesheet');
      } else {
        n.remove();
      }
    });
    if (extra) extra(doc);
    return rootOf(doc).outerHTML;
  }

  // Serialising and parsing again can turn text into elements (<math><style>...), so clean until nothing
  // changes. If that never happens, the markup cannot be trusted and is shown as text.
  function cleanUntilStable(html, allowRemote, extra) {
    let current = html;
    for (let i = 0; i < 8; i++) {
      const next = cleanHtml(current, allowRemote, extra);
      if (next === current) return current;
      current = next;
    }
    return '<pre>' + current.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
  }

  // Looks up "cid:<id>" references. When two parts share an ID, the later one wins.
  function cidLookup() {
    const byCid = new Map();
    for (const a of model.attachments) if (a.contentId) byCid.set(a.contentId.toLowerCase(), a);
    return (id) => {
      let key = id;
      try { key = decodeURIComponent(id); } catch (e) { /* keep */ }
      return byCid.get(key.toLowerCase()) || null;
    };
  }

  // Some mailers send embedded images as application/octet-stream.
  const isImage = (a) => a.contentType.startsWith('image/') ||
    (a.contentType === 'application/octet-stream' && /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(a.filename));

  // Embedded images become data: URLs. imagesOnly keeps other attachments out of a saved file.
  function inlineCid(html, imagesOnly) {
    const find = cidLookup();
    const cache = new Map();
    return html.replace(/cid:([^"'\s)>]+)/gi, (all, id) => {
      const a = find(id);
      if (!a || (imagesOnly && !isImage(a))) return all;
      if (!cache.has(a)) {
        cache.set(a, 'data:' + (a.contentType || 'application/octet-stream') + ';base64,' + EmlMime.bytesToB64(a.bytes));
      }
      return cache.get(a);
    });
  }

  function buildSrcdoc(html) {
    html = inlineCid(html);

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
      cleanUntilStable(html, remoteImages);
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

  // ------------------------------------------------------------- export

  // The DOM, reached through the prototypes: the mail can shadow members, with <img name="body"> on the
  // document or <input name="attributes"> inside a <form>.
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const rootOf = (doc) => getter(Document.prototype, 'documentElement').call(doc);
  const bodyOf = (doc) => getter(Document.prototype, 'body').call(doc);
  const childNodesOf = getter(Node.prototype, 'childNodes');
  const nodeTypeOf = getter(Node.prototype, 'nodeType');
  const nodeValueOf = getter(Node.prototype, 'nodeValue');
  const setNodeValue = Object.getOwnPropertyDescriptor(Node.prototype, 'nodeValue').set;
  const parentOf = getter(Node.prototype, 'parentNode');
  const localNameOf = getter(Element.prototype, 'localName');
  const DOM = {
    children: (n) => Array.from(childNodesOf.call(n)),
    isElement: (n) => nodeTypeOf.call(n) === Node.ELEMENT_NODE,
    isText: (n) => nodeTypeOf.call(n) === Node.TEXT_NODE,
    text: (n) => nodeValueOf.call(n),
    tag: (n) => localNameOf.call(n).toLowerCase(),
    attrNames: (n) => Element.prototype.getAttributeNames.call(n),
    getAttr: (n, name) => Element.prototype.getAttribute.call(n, name),
    setAttr: (n, name, value) => Element.prototype.setAttribute.call(n, name, value),
    removeAttr: (n, name) => Element.prototype.removeAttribute.call(n, name),
    setText: (n, value) => setNodeValue.call(n, value),
    remove: (n) => Node.prototype.removeChild.call(parentOf.call(n), n),
  };

  function parseMail(html) {
    return new DOMParser().parseFromString(DOCTYPE + html, 'text/html');
  }

  function baseOf(doc) {
    const b = Document.prototype.querySelector.call(doc, 'base[href]');
    return b ? EmlExport.baseUrl(Element.prototype.getAttribute.call(b, 'href')) : null;
  }

  // The body written out follows the tab on screen. The headers tab writes the HTML body, or the text one.
  function exportKind() {
    if (tab === 'text' && model.text !== null) return 'text';
    if (model.html !== null) return 'html';
    return model.text !== null ? 'text' : null;
  }

  function exportSummary(kind) {
    const m = model;
    const rows = [];
    const add = (label, value) => { if (value) rows.push([label, value]); };
    add(t('from'), m.from);
    add(t('to'), m.to);
    add('CC', m.cc);
    add('BCC', m.bcc);
    add(t('replyTo'), m.replyTo);
    if (m.date) {
      const shown = formatDate(m.date);
      add(t('date'), shown === m.date ? shown : shown + ' (' + m.date + ')');
    }
    const atts = m.attachments.filter((a) => !a.referenced);
    if (atts.length) add(t('attachmentList'), atts.map((a) => a.filename + ' (' + formatSize(a.size) + ')').join(', '));
    return { subject: m.subject || t('noSubject'), rows, notes: kind ? [] : [t('noBody')] };
  }

  // Remote content is always left out, whatever the button says: the file would fetch it every time it
  // is opened, by whoever opens it.
  function exportHtml() {
    const kind = exportKind();
    const summary = exportSummary(kind);
    if (kind !== 'html') return EmlExport.textDocument(summary, kind === 'text' ? model.text : '', locale);

    const doc = parseMail(inlineCid(model.html, true));
    const base = baseOf(doc);
    const removed = EmlExport.sanitize(rootOf(doc), DOM, base);
    if (removed) summary.notes.push(t('remoteLeftOut', removed));
    let body = bodyOf(doc);
    if (!body) {
      body = Document.prototype.createElement.call(doc, 'body');
      Node.prototype.appendChild.call(rootOf(doc), body);
    }
    Element.prototype.insertAdjacentHTML.call(body, 'afterbegin', EmlExport.headerHtml(summary));
    const html = rootOf(doc).outerHTML;
    return EmlExport.htmlHead(summary.subject, locale) +
      cleanUntilStable(html, false, (d) => EmlExport.sanitize(rootOf(d), DOM, base));
  }

  function exportMarkdown() {
    const kind = exportKind();
    const summary = exportSummary(kind);
    let body = '';
    if (kind === 'html') {
      const doc = parseMail(model.html);
      const find = cidLookup();
      body = EmlExport.htmlToMarkdown(bodyOf(doc) || rootOf(doc), DOM, {
        t,
        base: baseOf(doc),
        cidName: (id) => {
          const a = find(id);
          return a ? a.filename : null;
        },
      });
    } else if (kind === 'text') {
      body = EmlExport.textToMarkdown(model.text);
    }
    return EmlExport.markdownDocument(summary, body);
  }
})();
