/*
 * Turns the email on screen into a standalone HTML or Markdown file. No dependencies.
 * Used by the webview. The DOM is reached through a small bridge object (see viewer.js), so the
 * decisions about what to keep can be tested under Node on a fake tree.
 *
 * The bridge: children(n) -> array, isElement(n), isText(n), text(n), tag(n) -> lower case,
 * attrNames(el), getAttr(el, name) -> string or null, setAttr(el, name, value) (may throw), removeAttr(el, name),
 * setText(textNode, value), remove(n).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EmlExport = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- links

  const LINK_SCHEMES = ['http:', 'https:', 'mailto:'];

  function parseUrl(raw, base) {
    try {
      return base ? new URL(raw, base) : new URL(raw);
    } catch (e) {
      return null;
    }
  }

  // A <base href> is only used when it is http or https. Anything else would let the mail decide
  // what its relative links point at.
  function baseUrl(raw) {
    if (typeof raw !== 'string') return null;
    const url = parseUrl(raw);
    return url && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  }

  // The same schemes the viewer opens. The result is the URL as the browser will read it.
  function safeLink(raw, base) {
    if (typeof raw !== 'string') return null;
    const url = parseUrl(raw, base);
    return url && LINK_SCHEMES.includes(url.protocol) ? url.href : null;
  }

  // Splits plain text into text and http(s) URLs.
  function splitLinks(text) {
    const parts = [];
    // No control characters: a Markdown autolink cannot hold them.
    const re = /\bhttps?:\/\/[^\s\x00-\x1f\x7f<>"'（）「」『』、。]+/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      let end = m[0].length;
      while (end > 0 && ').,;:!?'.includes(m[0][end - 1])) end--; // sentence punctuation is not part of the link
      const url = m[0].slice(0, end);
      if (m.index > last) parts.push({ text: text.slice(last, m.index) });
      parts.push({ url });
      last = m.index + url.length;
      re.lastIndex = last;
    }
    if (last < text.length) parts.push({ text: text.slice(last) });
    return parts;
  }

  // The URL parser ignores leading and trailing spaces and control characters. A loop, because a
  // regular expression like /\s+$/ takes quadratic time on crafted input.
  function trimUrl(s) {
    let start = 0;
    let end = s.length;
    while (start < end && s.charCodeAt(start) <= 0x20) start++;
    while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
    return s.slice(start, end);
  }

  // ----------------------------------------------------------------- HTML

  // The file is opened straight from disk, without the viewer's sandboxed frame, so this policy is what
  // stops scripts, form posts and every fetch. Only data: (the embedded images) loads.
  const EXPORT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
    "media-src data:; form-action 'none'; base-uri 'none'";

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  // Elements that load or run something, or whose text the parser reads as markup in some browsers
  // (noscript once scripts are on, the raw text ones under older or newer parsing rules).
  const DROP_ELEMENTS = new Set([
    'script', 'noscript', 'template', 'base', 'meta', 'link', 'title', 'xmp', 'noembed', 'noframes', 'plaintext',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'portal', 'fencedframe',
    // SVG animation can set href and src at run time
    'animate', 'animatecolor', 'animatemotion', 'animatetransform', 'set', 'discard',
  ]);

  // Removed elements that pointed at content outside the mail, for the count shown in the file.
  const REMOTE_ELEMENTS = new Set(['link', 'iframe', 'frame', 'object', 'embed', 'applet', 'portal', 'fencedframe', 'script']);

  // Attributes that load a file. Only data: survives; the cid: images are data: by then.
  const RESOURCE_ATTRS = new Set([
    'src', 'lowsrc', 'dynsrc', 'poster', 'background', 'data', 'manifest', 'codebase', 'archive',
    'classid', 'longdesc', 'profile', 'icon', 'href',
  ]);

  const DROP_ATTRS = new Set(['srcset', 'imagesrcset', 'action', 'formaction', 'ping', 'srcdoc', 'attributionsrc', 'base']);
  const REMOTE_ATTRS = new Set(['srcset', 'imagesrcset']);

  const KEEP = null;

  // What to do with one attribute: KEEP, { drop: true, remote } or { set: value }.
  // remote says it referred to content outside the mail, for the count shown in the file.
  function attrAction(tag, name, value, base) {
    const lower = String(name).toLowerCase();
    const local = lower.slice(lower.lastIndexOf(':') + 1); // xlink:href is a link too
    const v = trimUrl(String(value == null ? '' : value));
    if (lower.startsWith('on') || local.startsWith('on')) return { drop: true, remote: false };
    if (DROP_ATTRS.has(local)) return { drop: true, remote: REMOTE_ATTRS.has(local) && v !== '' && !/^(?:cid|data):/i.test(v) };
    if (local === 'href' && (tag === 'a' || tag === 'area')) {
      if (v.startsWith('#')) return KEEP;
      const safe = safeLink(value, base);
      if (safe === null) return { drop: true, remote: false };
      return safe === value ? KEEP : { set: safe };
    }
    if (RESOURCE_ATTRS.has(local)) {
      if (/^data:/i.test(v)) return KEEP;
      if (local === 'href' && v.startsWith('#')) return KEEP;
      return { drop: true, remote: v !== '' && !/^cid:/i.test(v) };
    }
    return KEEP;
  }

  // Removes what could run or load something, so the file stays quiet even in a program that ignores
  // the CSP. CSS (style attributes, <style>) is left to the CSP: rewriting it is easy to get wrong.
  // Comments go too: Word and Outlook read the markup inside <!--[if mso]> ... <![endif]-->.
  // Returns the number of references to remote content it removed.
  function sanitize(root, dom, base) {
    let removed = 0;
    const visit = (el) => {
      const tag = dom.tag(el);
      for (const name of dom.attrNames(el)) {
        const action = attrAction(tag, name, dom.getAttr(el, name), base);
        if (action === KEEP) continue;
        if (action.set !== undefined) {
          // The parser accepts names that setAttribute rejects ("=x:href"). The error would carry the name.
          try {
            dom.setAttr(el, name, action.set);
            continue;
          } catch (e) { /* removed below */ }
        }
        dom.removeAttr(el, name);
        if (action.remote) removed++;
      }
      // A <style> is written out as raw text, which parsers of other ages can read as markup
      // (<select><style></select><meta http-equiv=refresh>). "\3c " is "<" to CSS.
      if (tag === 'style') {
        for (const c of dom.children(el)) {
          if (dom.isText(c) && dom.text(c).includes('<')) dom.setText(c, dom.text(c).replace(/</g, '\\3c '));
        }
      }
    };
    if (dom.isElement(root)) visit(root);
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      for (const child of dom.children(node)) {
        if (!dom.isElement(child)) {
          if (!dom.isText(child)) dom.remove(child);
          continue;
        }
        const tag = dom.tag(child);
        if (DROP_ELEMENTS.has(tag)) {
          if (REMOTE_ELEMENTS.has(tag) && ['src', 'href', 'data'].some((a) => trimUrl(dom.getAttr(child, a) || '') !== '')) removed++;
          dom.remove(child);
          continue;
        }
        visit(child);
        stack.push(child);
      }
    }
    return removed;
  }

  function htmlHead(title, locale) {
    const jaFonts = /^ja\b/i.test(locale || '') ? '"Yu Gothic UI",Meiryo,' : '';
    const sans = 'system-ui,"Segoe UI",' + jaFonts + 'sans-serif';
    // Prepended as text, so the policy is the first thing the parser sees and nothing in the mail can move it.
    return '<!doctype html><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' + EXPORT_CSP + '">' +
      '<meta http-equiv="x-dns-prefetch-control" content="off">' +
      '<meta name="referrer" content="no-referrer">' +
      '<title>' + escapeHtml(title) + '</title>' +
      '<style>html{background:#fff;color:#000}body{margin:16px;font-family:' + sans + ';line-height:1.6}' +
      'img{max-width:100%;height:auto}' +
      '.eml-export-header{margin:0 0 16px;padding:0 0 12px;border-bottom:1px solid #ccc;background:#fff;color:#000;' +
      'font-family:' + sans + ';line-height:1.5}' +
      '.eml-export-header h1{margin:0 0 8px;font-size:1.4em;line-height:1.35}' +
      '.eml-export-header table{border-collapse:collapse}' +
      '.eml-export-header th{padding:2px 16px 2px 0;color:#555;font-weight:normal;text-align:left;vertical-align:top;white-space:nowrap}' +
      '.eml-export-header td{padding:2px 0;word-break:break-all}' +
      '.eml-export-note{margin:8px 0 0;color:#a00}' +
      '.eml-export-text{margin:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace}' +
      '</style>';
  }

  // summary: { subject, rows: [[label, value]], notes: [text] }. Everything is text.
  function headerHtml(summary) {
    const rows = summary.rows.map(([k, v]) => '<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(v) + '</td></tr>').join('');
    const notes = (summary.notes || []).map((n) => '<p class="eml-export-note">' + escapeHtml(n) + '</p>').join('');
    return '<div class="eml-export-header"><h1>' + escapeHtml(summary.subject) + '</h1>' +
      (rows ? '<table><tbody>' + rows + '</tbody></table>' : '') + notes + '</div>';
  }

  // A mail without HTML. Nothing in it comes from the mail as markup.
  function textDocument(summary, text, locale) {
    let body = '';
    for (const p of splitLinks(text || '')) {
      if (p.url === undefined) {
        body += escapeHtml(p.text);
        continue;
      }
      const href = safeLink(p.url);
      body += href ? '<a href="' + escapeHtml(href) + '">' + escapeHtml(p.url) + '</a>' : escapeHtml(p.url);
    }
    // The parser drops a newline right after <pre>, so one is added to keep the mail's own.
    return htmlHead(summary.subject, locale) + '<body>' + headerHtml(summary) +
      (text ? '<pre class="eml-export-text">\n' + body + '</pre>' : '') + '</body>';
  }

  // ------------------------------------------------------------- Markdown

  // Placeholders for emphasis, resolved once the characters around them are known (resolveEmphasis).
  // They are noncharacters, removed from the mail's own text.
  const EM = { b: ['﷐', '﷑'], i: ['﷒', '﷓'] };
  const EM_CHARS = /[﷐-﷓]/g;
  const isMark = (c) => c >= '﷐' && c <= '﷓';

  function clean(s) {
    return String(s).replace(EM_CHARS, '');
  }

  // Text from the mail must never become markup: no HTML (<), no links ([), no images (! before a link
  // that follows), no entities (&), no math ($, which VS Code's preview renders).
  function mdEscape(s) {
    return clean(s).replace(/[\\`*_[\]<>&~|$!]/g, '\\$&');
  }

  // As mdEscape, with the URLs as autolinks. A preview that links bare URLs (linkify) reads the text before
  // the escapes are removed, so an escaped URL would keep its backslashes.
  function mdText(s) {
    let out = '';
    for (const p of splitLinks(clean(s))) out += p.url === undefined ? mdEscape(p.text) : '<' + p.url + '>';
    return out;
  }

  // Characters that only mean something at the start of a line (headings, lists, setext underlines, fences).
  function escapeLineStart(line) {
    if (/^[#+=~-]/.test(line)) return '\\' + line;
    const m = /^(\d{1,9})([.)])/.exec(line);
    return m ? m[1] + '\\' + line.slice(m[1].length) : line;
  }

  // A destination in angle brackets may hold spaces and parentheses. Escapes and entities still work there.
  function mdUrl(href) {
    return '<' + clean(href).replace(/[\\<>&]/g, '\\$&') + '>';
  }

  function oneLine(s) {
    return String(s).replace(/[\r\n]+/g, ' ');
  }

  function longestRun(s, ch) {
    let best = 0;
    let run = 0;
    for (let i = 0; i < s.length; i++) {
      run = s[i] === ch ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best;
  }

  // Loops, because regular expressions like /#+$/ take quadratic time on crafted input.
  function trimSpaces(s) {
    let start = 0;
    let end = s.length;
    while (start < end && (s[start] === ' ' || s[start] === '\t')) start++;
    while (end > start && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
    return s.slice(start, end);
  }

  // A closing run of # would be read as the end of the heading.
  function headingText(text) {
    text = trimSpaces(text);
    let k = text.length;
    while (k > 0 && text[k - 1] === '#') k--;
    return k < text.length ? text.slice(0, k) + '\\' + text.slice(k) : text;
  }

  function collapseWs(s) {
    return String(s).replace(/[ \t\n\r\f]+/g, ' ');
  }

  // CommonMark's classes. Unicode punctuation is P and S; a renderer on an older spec sees fewer, which
  // only makes it accept emphasis that this drops.
  const WS = /[\t\n\f\r\p{Zs}]/u;
  const PUNCT = /[\p{P}\p{S}]/u;

  // Turns the placeholders into ** and *, keeping only pairs that CommonMark will read as emphasis.
  // Otherwise the stars show as text: "**【重要】**です", "x**a**", "**a****b**".
  function resolveEmphasis(line) {
    if (!/[﷐-﷓]/.test(line)) return line;
    // a close right before an open of the same kind joins the two
    for (let prev = ''; prev !== line;) {
      prev = line;
      line = line.split('﷑﷐').join('').split('﷓﷒').join('');
    }
    const chars = Array.from(line);
    const partner = new Map();
    const stack = [];
    chars.forEach((c, i) => {
      if (c === '﷐' || c === '﷒') {
        stack.push(i);
      } else if (c === '﷑' || c === '﷓') {
        const j = stack.pop();
        if (j !== undefined) {
          partner.set(i, j);
          partner.set(j, i);
        }
      }
    });
    const alive = chars.map((c, i) => partner.has(i));
    const weight = (c) => (c === '﷐' || c === '﷑' ? 2 : 1);
    for (let changed = true; changed;) {
      changed = false;
      // A run of markers is one delimiter run; the line's ends count as whitespace.
      const run = new Map();
      for (let i = 0; i < chars.length; i++) {
        if (!isMark(chars[i])) continue;
        let j = i;
        let len = 0;
        for (; j < chars.length && isMark(chars[j]); j++) if (alive[j]) len += weight(chars[j]);
        const before = i > 0 ? chars[i - 1] : ' ';
        const after = j < chars.length ? chars[j] : ' ';
        const left = !WS.test(after) && (!PUNCT.test(after) || WS.test(before) || PUNCT.test(before));
        const right = !WS.test(before) && (!PUNCT.test(before) || WS.test(after) || PUNCT.test(after));
        for (let k = i; k < j; k++) run.set(k, { len, left, right });
        i = j - 1;
      }
      for (let i = 0; i < chars.length; i++) {
        if (!alive[i] || !(chars[i] === '﷐' || chars[i] === '﷒')) continue;
        const j = partner.get(i);
        const a = run.get(i);
        const b = run.get(j);
        let ok = a.left && b.right && chars.slice(i + 1, j).some((c) => !isMark(c)); // not empty
        // the "multiple of 3" rule, for runs that can both open and close
        if (ok && ((a.left && a.right) || (b.left && b.right)) && (a.len + b.len) % 3 === 0 &&
            !(a.len % 3 === 0 && b.len % 3 === 0)) ok = false;
        if (!ok) {
          alive[i] = alive[j] = false;
          changed = true;
        }
      }
    }
    return chars.map((c, i) => (!isMark(c) ? c : !alive[i] ? '' : weight(c) === 2 ? '**' : '*')).join('');
  }

  function textToMarkdown(text) {
    const out = [];
    let prev = null; // { level, blank }
    for (const raw of String(text || '').split(/\r\n|\r|\n/)) {
      const line = raw.trimEnd();
      let i = 0;
      let level = 0;
      while (i < line.length && line[i] === '>') {
        level++;
        i++;
        if (line[i] === ' ' || line[i] === '\t') i++;
      }
      let content = line.slice(i);
      const prefix = '> '.repeat(level);
      if (!content) {
        out.push(prefix.trimEnd());
        prev = { level, blank: true };
        continue;
      }
      // Leading spaces would make a code block, so they become no-break spaces.
      let lead = '';
      let j = 0;
      for (; j < content.length && (content[j] === ' ' || content[j] === '\t'); j++) lead += content[j] === '\t' ? ' '.repeat(4) : ' ';
      content = content.slice(j);
      const md = lead ? lead + mdText(content) : escapeLineStart(mdText(content));
      if (prev && !prev.blank) {
        // A line at another level would join the previous paragraph (lazy continuation), so a blank line separates them.
        if (prev.level === level) out[out.length - 1] += '  ';
        else out.push('');
      }
      out.push(prefix + md);
      prev = { level, blank: false };
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    while (out.length && out[0] === '') out.shift();
    return out.join('\n');
  }

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog',
    'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
    'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre',
    'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ]);
  const LIST_TAGS = new Set(['ul', 'ol', 'menu', 'dir']);
  // The text inside <svg> and <math> stays: a crafted mail can move the whole body into them.
  const SKIP_TAGS = new Set([
    'head', 'script', 'style', 'template', 'noscript', 'noembed', 'noframes', 'title', 'meta', 'link', 'base',
    'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'canvas', 'audio', 'video', 'select',
    'option', 'datalist', 'textarea', 'input', 'button', 'map',
  ]);
  // Strikethrough is left out: "~~" fails next to punctuation as "**" does, and is rare in mail.
  const FORMAT = { b: 'b', strong: 'b', i: 'i', em: 'i' };
  const CODE_TAGS = new Set(['code', 'tt', 'kbd', 'samp']);
  const HIDDEN_STYLE = /(?:^|[;\s])(?:display\s*:\s*none|mso-hide\s*:\s*all)/i;
  const MAX_DEPTH = 400;
  // Quotes and lists deeper than this lose their markers. Each level repeats its prefix on every line inside.
  const MAX_NEST = 16;
  const BR = {};

  // root: the <body> of the mail as parsed. opts: { t, base, cidName(id) -> file name or null }.
  // Remote images become ordinary links, so nothing loads when the file is previewed.
  function htmlToMarkdown(root, dom, opts) {
    const o = opts || {};
    const t = o.t || ((key, arg) => (arg ? 'Image: ' + arg : 'Image'));
    const base = o.base || null;
    let nesting = 0;

    const isHidden = (el) => {
      if (dom.getAttr(el, 'hidden') !== null) return true;
      const style = dom.getAttr(el, 'style');
      return !!style && HIDDEN_STYLE.test(style);
    };
    const skip = (el) => SKIP_TAGS.has(dom.tag(el)) || isHidden(el);

    // Elements with a block or a line break inside. Formatting around them is dropped, so the lines stay.
    const blocky = new Set();
    const order = [];
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      order.push(n);
      for (const c of dom.children(n)) if (dom.isElement(c)) stack.push(c);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const n = order[i];
      for (const c of dom.children(n)) {
        if (!dom.isElement(c)) continue;
        const tag = dom.tag(c);
        if (BLOCK_TAGS.has(tag) || tag === 'br' || blocky.has(c)) {
          blocky.add(n);
          break;
        }
      }
    }

    function textAll(node) {
      let s = '';
      const st = [node];
      while (st.length) {
        const n = st.pop();
        if (dom.isText(n)) {
          s += dom.text(n);
          continue;
        }
        if (!dom.isElement(n)) continue;
        if (n !== node) {
          if (skip(n)) continue;
          if (dom.tag(n) === 'br') {
            s += '\n';
            continue;
          }
        }
        const kids = dom.children(n);
        for (let i = kids.length - 1; i >= 0; i--) st.push(kids[i]);
      }
      return clean(s);
    }

    function linkHref(el) {
      const raw = dom.getAttr(el, 'href');
      if (raw === null || trimUrl(raw).startsWith('#')) return null;
      return safeLink(raw, base);
    }

    const imageLabel = (name) => (name ? t('imageNamed', name) : t('image'));

    function imageMd(el, inLink) {
      const alt = trimSpaces(collapseWs(dom.getAttr(el, 'alt') || ''));
      if (inLink) return mdEscape(alt);
      const src = trimUrl(dom.getAttr(el, 'src') || '');
      if (/^cid:/i.test(src)) {
        const name = o.cidName ? o.cidName(src.slice(4)) : null;
        return mdEscape('[' + imageLabel(name || alt) + ']');
      }
      const href = src ? safeLink(src, base) : null;
      if (href && /^https?:/i.test(href)) {
        const tiny = ['width', 'height'].some((a) => {
          const n = parseInt(dom.getAttr(el, a), 10);
          return n >= 0 && n <= 2;
        });
        if (tiny) return ''; // a tracking pixel
        return '[' + mdEscape(imageLabel(alt)) + '](' + mdUrl(href) + ')';
      }
      return src || alt ? mdEscape('[' + imageLabel(alt) + ']') : '';
    }

    function codeSpan(text) {
      const s = trimSpaces(collapseWs(text));
      if (!s) return '';
      const fence = '`'.repeat(longestRun(s, '`') + 1);
      const pad = s[0] === '`' || s[s.length - 1] === '`' ? ' ' : '';
      return fence + pad + s + pad + fence;
    }

    // Spaces at either end go outside the markers, which do not work next to a space.
    const isZs = (c) => /\p{Zs}/u.test(c);
    function wrap(kind, inner) {
      let a = 0;
      let b = inner.length;
      while (a < b && isZs(inner[a])) a++;
      while (b > a && isZs(inner[b - 1])) b--;
      if (a === b) return inner;
      return inner.slice(0, a) + EM[kind][0] + inner.slice(a, b) + EM[kind][1] + inner.slice(b);
    }

    // Everything under el on one line. active: the kinds of emphasis already open around it.
    function inlineChildren(el, depth, inLink, active) {
      if (depth > MAX_DEPTH) return mdEscape(collapseWs(textAll(el)));
      let s = '';
      for (const c of dom.children(el)) {
        if (dom.isText(c)) {
          s += inLink ? mdEscape(collapseWs(dom.text(c))) : mdText(collapseWs(dom.text(c)));
          continue;
        }
        if (!dom.isElement(c) || skip(c)) continue;
        const tag = dom.tag(c);
        if (tag === 'br') {
          s += ' ';
          continue;
        }
        if (tag === 'img') {
          s += imageMd(c, inLink);
          continue;
        }
        if (tag === 'a' && !inLink) {
          const href = linkHref(c);
          if (href) {
            s += linkMd(c, href, depth + 1, active);
            continue;
          }
        }
        const inner = inlineOf(c, depth + 1, inLink, active);
        s += BLOCK_TAGS.has(tag) ? ' ' + inner + ' ' : inner;
      }
      return s;
    }

    function inlineOf(el, depth, inLink, active) {
      const tag = dom.tag(el);
      if (CODE_TAGS.has(tag)) return codeSpan(textAll(el));
      const kind = FORMAT[tag] && !active.includes(FORMAT[tag]) ? FORMAT[tag] : '';
      const inner = inlineChildren(el, depth, inLink, active + kind);
      return kind ? wrap(kind, inner) : inner;
    }

    function linkMd(el, href, depth, active) {
      const text = trimSpaces(inlineChildren(el, depth, true, active).replace(/ {2,}/g, ' '));
      return '[' + (text || mdEscape(href)) + '](' + mdUrl(href) + ')';
    }

    const newAcc = () => ({ blocks: [], para: [], lastList: null });

    function push(acc, block, list) {
      if (!block) return;
      acc.blocks.push(block);
      acc.lastList = list || null;
    }

    function flush(acc) {
      if (!acc.para.length) return;
      const lines = [''];
      for (const it of acc.para) {
        if (it === BR) lines.push('');
        else if (it.md !== undefined) lines[lines.length - 1] += it.md;
        else lines[lines.length - 1] += mdText(collapseWs(it.text));
      }
      acc.para = [];
      // Inline markup starts with * ` [ < or \, never with a character escapeLineStart looks at.
      const done = lines.map((l) => escapeLineStart(trimSpaces(resolveEmphasis(l).replace(/ {2,}/g, ' '))));
      const out = [];
      for (const l of done) {
        if (!l) {
          if (out.length && out[out.length - 1] !== '') out.push('');
          continue;
        }
        if (out.length && out[out.length - 1] !== '') out[out.length - 1] += '  '; // a hard line break
        out.push(l);
      }
      while (out.length && out[out.length - 1] === '') out.pop();
      if (out.length) push(acc, out.join('\n'));
    }

    function blocksOf(node, depth) {
      const acc = newAcc();
      walk(node, acc, depth);
      flush(acc);
      return acc.blocks;
    }

    function walk(node, acc, depth) {
      if (depth > MAX_DEPTH) {
        acc.para.push({ text: textAll(node) });
        return;
      }
      for (const child of dom.children(node)) walkChild(child, acc, depth);
    }

    function walkChild(child, acc, depth) {
      if (dom.isText(child)) {
        acc.para.push({ text: dom.text(child) });
        return;
      }
      if (!dom.isElement(child) || skip(child)) return;
      const tag = dom.tag(child);
      if (tag === 'br') {
        acc.para.push(BR);
        return;
      }
      if (tag === 'img') {
        const md = imageMd(child, false);
        if (md) acc.para.push({ md });
        return;
      }
      if (tag === 'a') {
        const href = linkHref(child);
        if (href) {
          acc.para.push({ md: linkMd(child, href, depth + 1, '') });
          return;
        }
      }
      if (!BLOCK_TAGS.has(tag)) {
        if (blocky.has(child)) walk(child, acc, depth + 1);
        else acc.para.push({ md: inlineOf(child, depth + 1, false, '') });
        return;
      }
      flush(acc);
      blockMd(child, tag, depth + 1, acc);
    }

    function blockMd(el, tag, depth, acc) {
      if (/^h[1-6]$/.test(tag)) {
        const text = headingText(resolveEmphasis(inlineChildren(el, depth, false, '')).replace(/ {2,}/g, ' '));
        push(acc, text ? '#'.repeat(Number(tag[1])) + ' ' + text : '');
        return;
      }
      if (tag === 'hr') {
        push(acc, '___'); // "- ---" in a list item would be a rule instead of the item
        return;
      }
      if (tag === 'pre') {
        push(acc, codeBlock(textAll(el)));
        return;
      }
      const nested = LIST_TAGS.has(tag) || tag === 'blockquote';
      if (!nested || nesting >= MAX_NEST) {
        walk(el, acc, depth);
        flush(acc);
        return;
      }
      nesting++;
      try {
        if (tag === 'blockquote') {
          const inner = blocksOf(el, depth).join('\n\n');
          push(acc, inner ? inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n') : '');
          return;
        }
        // A list right after a list of the same type would continue it, so the markers alternate.
        const ordered = tag === 'ol';
        const alt = !!(acc.lastList && acc.lastList.ordered === ordered && !acc.lastList.alt);
        const blocks = listMd(el, ordered, alt, depth);
        blocks.forEach((b, i) => push(acc, b, i === blocks.length - 1 ? { ordered, alt } : null));
      } finally {
        nesting--;
      }
    }

    function codeBlock(text) {
      let body = text.replace(/\r\n?/g, '\n');
      let end = body.length;
      while (end > 0 && body[end - 1] === '\n') end--;
      body = body.slice(0, end);
      if (!body.trim()) return '';
      const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1));
      return fence + '\n' + body + '\n' + fence;
    }

    const indent = (text, width) => text.split('\n').map((l, i) => (i === 0 || !l ? l : ' '.repeat(width) + l)).join('\n');

    function listMd(el, ordered, alt, depth) {
      let n = 1;
      if (ordered) {
        const start = parseInt(dom.getAttr(el, 'start'), 10);
        if (start >= 0 && start <= 999999999) n = start;
      }
      const before = [];
      const items = [];
      let width = 0;
      for (const c of dom.children(el)) {
        if (dom.isElement(c) && dom.tag(c) === 'li') {
          if (skip(c)) continue;
          // Numbers past nine digits are not list markers.
          const marker = ordered && n <= 999999999 ? n + (alt ? ') ' : '. ') : alt ? '* ' : '- ';
          n++;
          const content = blocksOf(c, depth + 1).join('\n\n');
          if (!content) continue;
          width = marker.length;
          items.push(marker + indent(content, width));
          continue;
        }
        // Text, or a list nested straight inside a list: it belongs to the item before, as a block of its own.
        const acc = newAcc();
        walkChild(c, acc, depth + 1);
        flush(acc);
        const content = acc.blocks.join('\n\n');
        if (!content) continue;
        if (items.length) items[items.length - 1] += '\n\n' + ' '.repeat(width) + indent(content, width);
        else before.push(content);
      }
      return items.length ? before.concat(items.join('\n')) : before;
    }

    return blocksOf(root, 0).join('\n\n');
  }

  function markdownDocument(summary, body) {
    const out = ['# ' + headingText(mdText(oneLine(summary.subject)))];
    const rows = summary.rows.map(([k, v]) => '- **' + mdEscape(oneLine(k)) + ':** ' + mdText(oneLine(v)));
    if (rows.length) out.push(rows.join('\n'));
    for (const n of summary.notes || []) out.push(escapeLineStart(mdText(oneLine(n))));
    out.push('---');
    if (body) out.push(body);
    return out.join('\n\n') + '\n';
  }

  return {
    EXPORT_CSP,
    baseUrl,
    safeLink,
    splitLinks,
    escapeHtml,
    attrAction,
    sanitize,
    htmlHead,
    headerHtml,
    textDocument,
    mdEscape,
    mdText,
    escapeLineStart,
    resolveEmphasis,
    textToMarkdown,
    htmlToMarkdown,
    markdownDocument,
  };
});
