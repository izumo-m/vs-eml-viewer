/*
 * EML (RFC 5322 / MIME) parser. No dependencies.
 * Shared by the extension host (Node) and the webview (browser).
 * Charsets are decoded with TextDecoder, so every WHATWG encoding works when the mail labels it.
 * Unlabelled 8-bit text is guessed: UTF-8, then the legacy charsets of the UI language (see setLocale).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EmlMime = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- bytes

  // A loop, because a regular expression like /x+$/ takes quadratic time on crafted input.
  function trimChars(s, chars) {
    let start = 0;
    let end = s.length;
    while (start < end && chars.includes(s[start])) start++;
    while (end > start && chars.includes(s[end - 1])) end--;
    return s.slice(start, end);
  }

  // For strings that hold raw bytes. String.prototype.trim would also remove 0xA0 (a no-break space
  // to JavaScript), which is the last byte of many UTF-8 and Shift_JIS characters.
  function trimBin(s) {
    return trimChars(s, ' \t\r\n');
  }

  function bytesToBin(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
  }

  function binToBytes(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  function concatBytes(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_TABLE = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) B64_TABLE[B64_CHARS.charCodeAt(i)] = i;

  function b64ToBytes(s) {
    const out = new Uint8Array(Math.ceil((s.length * 3) / 4) + 3);
    let o = 0;
    let buf = 0;
    let bits = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 61) {
        // '=' padding: realign, so concatenated base64 chunks still decode
        buf = 0;
        bits = 0;
        continue;
      }
      const v = c < 256 ? B64_TABLE[c] : -1;
      if (v < 0) continue;
      buf = ((buf << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (buf >> bits) & 0xff;
      }
    }
    return out.subarray(0, o);
  }

  function bytesToB64(bytes) {
    if (typeof btoa === 'function') return btoa(bytesToBin(bytes));
    return Buffer.from(bytes).toString('base64');
  }

  function hexVal(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 65 && c <= 70) return c - 55;
    if (c >= 97 && c <= 102) return c - 87;
    return -1;
  }

  function qpToBytes(s) {
    const out = new Uint8Array(s.length);
    let o = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 61) {
        const n1 = s.charCodeAt(i + 1);
        const n2 = s.charCodeAt(i + 2);
        if (n1 === 13 && n2 === 10) { i += 2; continue; } // soft line break
        if (n1 === 10) { i += 1; continue; }
        const h1 = hexVal(n1);
        const h2 = hexVal(n2);
        if (h1 >= 0 && h2 >= 0) {
          out[o++] = (h1 << 4) | h2;
          i += 2;
          continue;
        }
        const soft = /^[ \t]*\r?\n/.exec(s.slice(i + 1, i + 80));
        if (soft) { i += soft[0].length; continue; }
        out[o++] = c;
        continue;
      }
      out[o++] = c & 0xff;
    }
    return out.subarray(0, o);
  }

  function pctToBytes(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 37) {
        const h1 = hexVal(s.charCodeAt(i + 1));
        const h2 = hexVal(s.charCodeAt(i + 2));
        if (h1 >= 0 && h2 >= 0) {
          out.push((h1 << 4) | h2);
          i += 2;
          continue;
        }
      }
      out.push(c & 0xff);
    }
    return new Uint8Array(out);
  }

  // ------------------------------------------------------------- charsets

  const CHARSET_ALIASES = {
    'cp932': 'shift_jis',
    'ms932': 'shift_jis',
    'windows-31j': 'shift_jis',
    'cswindows31j': 'shift_jis',
    'windows-932': 'shift_jis',
    'x-cp932': 'shift_jis',
    'sjis': 'shift_jis',
    'x-sjis': 'shift_jis',
    's_jis': 'shift_jis',
    'shift-jis': 'shift_jis',
    'shift_jisx0213': 'shift_jis',
    'shift_jis-2004': 'shift_jis',
    'iso-2022-jp-ms': 'iso-2022-jp',
    'iso-2022-jp-1': 'iso-2022-jp',
    'iso-2022-jp-2': 'iso-2022-jp',
    'iso-2022-jp-3': 'iso-2022-jp',
    'iso-2022-jp-2004': 'iso-2022-jp',
    'cp50220': 'iso-2022-jp',
    'cp50221': 'iso-2022-jp',
    'cp50222': 'iso-2022-jp',
    'eucjp': 'euc-jp',
    'euc_jp': 'euc-jp',
    'ujis': 'euc-jp',
    'x-eucjp': 'euc-jp',
    'x-euc-jp': 'euc-jp',
    'eucjp-ms': 'euc-jp',
    'euc-jis-2004': 'euc-jp',
    'euc-jisx0213': 'euc-jp',
    'utf8': 'utf-8',
    // names that TextDecoder does not know
    'euc-cn': 'gbk',
    'euccn': 'gbk',
    'x-euc-cn': 'gbk',
    'gb-2312': 'gbk',
    'cp936': 'gbk',
    'ms936': 'gbk',
    'windows-936': 'gbk',
    'x-cp936': 'gbk',
    'euckr': 'euc-kr',
    'euc_kr': 'euc-kr',
    'ks_c_5601': 'euc-kr',
    'cp949': 'euc-kr',
    'ms949': 'euc-kr',
    'windows-949': 'euc-kr',
    'x-windows-949': 'euc-kr',
    'uhc': 'euc-kr',
    'big-5': 'big5',
    'x-big5': 'big5',
    'big5hkscs': 'big5',
    'big5_hkscs': 'big5',
    'cp950': 'big5',
    'ms950': 'big5',
    'windows-950': 'big5',
    'x-windows-950': 'big5',
    // these labels are often wrong on mail with 8-bit text, so guess instead
    'us-ascii': '',
    'ascii': '',
    'x-unknown': '',
    'unknown-8bit': '',
    'default': '',
  };

  // A mail can switch charset on every encoded word, and creating a decoder is slow, above all for an
  // unknown label, which throws. So decoders are kept per mail, up to a limit no real mail comes near.
  const MAX_DECODERS = 256;
  const decoders = new Map();

  function makeDecoder(label, fatal) {
    const key = (fatal ? 'f:' : 'n:') + label;
    if (decoders.has(key)) return decoders.get(key);
    if (decoders.size >= MAX_DECODERS) return null;
    let decoder = null;
    try {
      decoder = new TextDecoder(label, { fatal: !!fatal });
    } catch (e) {
      /* not a charset */
    }
    decoders.set(key, decoder);
    return decoder;
  }

  // The WHATWG ISO-2022-JP decoder emits U+FFFD when two escape sequences are
  // adjacent (e.g. "ESC ( B ESC $ B" where two encoded words were joined).
  // Drop an escape that is immediately overridden by the next one.
  function normalizeJis(bytes) {
    if (bytes.indexOf(0x1b) === -1) return bytes;
    const bin = bytesToBin(bytes);
    const fixed = bin.replace(/\x1b(?:\([BJI]|\$[@B])(?=\x1b(?:\([BJI]|\$[@B]))/g, '');
    return fixed.length === bin.length ? bytes : binToBytes(fixed);
  }

  function decodeJis(bytes) {
    const d = makeDecoder('iso-2022-jp');
    return d ? d.decode(normalizeJis(bytes)) : null;
  }

  // Legacy charsets to try for unlabelled text, by UI language. Windows-1252 is the last resort.
  // EUC-JP goes before Shift_JIS: nearly all EUC-JP bytes also form valid Shift_JIS (half-width kana),
  // while Japanese text in Shift_JIS usually contains a lead byte that EUC-JP rejects.
  const LEGACY_CHARSETS = {
    'ja': ['euc-jp', 'shift_jis'],
    'zh': ['gb18030'],
    'zh-tw': ['big5'],
    'zh-hk': ['big5'],
    'zh-mo': ['big5'],
    'zh-hant': ['big5'],
    'ko': ['euc-kr'],
    'ru': ['windows-1251'],
    'uk': ['windows-1251'],
    'bg': ['windows-1251'],
  };

  let legacyCharsets = [];

  function setLocale(locale) {
    const tag = String(locale || '').toLowerCase();
    legacyCharsets = LEGACY_CHARSETS[tag] || LEGACY_CHARSETS[tag.split('-')[0]] || [];
  }

  // ISO-2022-JP is 7-bit and shifts into a Japanese set. "ESC ( B" alone only selects ASCII, and
  // terminal output contains it too (tput sgr0), so it says nothing about the charset.
  function looksLikeJis(bytes) {
    if (bytes.indexOf(0x1b) === -1) return false;
    const bin = bytesToBin(bytes);
    return /\x1b(?:\$[@B]|\([JI])/.test(bin) && !/[\x80-\xff]/.test(bin);
  }

  function guessDecode(bytes) {
    if (looksLikeJis(bytes)) {
      const s = decodeJis(bytes);
      if (s !== null) return s;
    }
    for (const label of ['utf-8', ...legacyCharsets]) {
      const d = makeDecoder(label, true);
      if (!d) continue;
      try {
        return d.decode(bytes);
      } catch (e) {
        /* try next */
      }
    }
    return new TextDecoder('windows-1252').decode(bytes);
  }

  function decodeBytes(bytes, charset) {
    let label = trimChars(String(charset || '').trim().toLowerCase(), '"\'');
    if (Object.prototype.hasOwnProperty.call(CHARSET_ALIASES, label)) label = CHARSET_ALIASES[label];
    if (!label) return guessDecode(bytes);
    if (label === 'iso-2022-jp' || label === 'csiso2022jp') {
      const s = decodeJis(bytes);
      if (s !== null) return s;
    }
    const d = makeDecoder(label);
    if (!d) return guessDecode(bytes);
    return d.decode(bytes);
  }

  function decodeRaw(str) {
    if (!/[\x1b\x80-\xff]/.test(str)) return str;
    return guessDecode(binToBytes(str));
  }

  // --------------------------------------------------------------- headers

  function decodeHeaderValue(raw) {
    if (raw == null) return '';
    const re = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
    let out = '';
    let last = 0;
    let pend = null;
    const flush = () => {
      if (pend) {
        out += decodeBytes(concatBytes(pend.chunks), pend.charset);
        pend = null;
      }
    };
    let m;
    while ((m = re.exec(raw))) {
      const between = raw.slice(last, m.index);
      const wsOnly = pend && /^[ \t\r\n]*$/.test(between);
      if (!wsOnly) {
        flush();
        out += decodeRaw(between);
      }
      const charset = m[1].split('*')[0];
      const bytes = m[2].toUpperCase() === 'B'
        ? b64ToBytes(m[3])
        : qpToBytes(m[3].replace(/_/g, ' '));
      if (pend && pend.charset.toLowerCase() === charset.toLowerCase()) {
        pend.chunks.push(bytes);
      } else {
        flush();
        pend = { charset, chunks: [bytes] };
      }
      last = re.lastIndex;
    }
    flush();
    out += decodeRaw(raw.slice(last));
    return out.replace(/[\r\n]+/g, ' ').trim();
  }

  function parseHeaderLines(bin) {
    const headers = [];
    const lines = bin.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0 && line.startsWith('From ')) continue; // mbox separator
      if (/^[ \t]/.test(line) && headers.length) {
        headers[headers.length - 1].raw += line;
        continue;
      }
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      headers.push({ name: line.slice(0, colon).trim(), raw: trimBin(line.slice(colon + 1)) });
    }
    return headers;
  }

  function splitParams(s) {
    const parts = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '\\' && i + 1 < s.length) {
          cur += ch + s[++i];
          continue;
        }
        if (ch === '"') quoted = false;
        cur += ch;
      } else {
        if (ch === '"') quoted = true;
        if (ch === ';') {
          parts.push(cur);
          cur = '';
          continue;
        }
        cur += ch;
      }
    }
    parts.push(cur);
    return parts;
  }

  function unquote(v) {
    v = trimBin(v);
    if (v.startsWith('"')) {
      v = v.slice(1);
      if (v.endsWith('"')) v = v.slice(0, -1);
      v = v.replace(/\\(.)/g, '$1');
    }
    return v;
  }

  // Parses "value; a=b; c*=utf-8''x; d*0*=...; d*1*=..." (RFC 2045 / RFC 2231)
  function parseStructured(raw) {
    const parts = splitParams(raw || '');
    const value = (parts.shift() || '').trim().toLowerCase();
    // No prototype: parameter names come from the mail ("constructor", "__proto__")
    const groups = Object.create(null);
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq < 0) continue;
      const name = p.slice(0, eq).trim().toLowerCase();
      const val = unquote(p.slice(eq + 1));
      const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(name);
      if (!m) continue;
      const key = m[1];
      const idx = m[2] ? parseInt(m[2], 10) : 0;
      (groups[key] = groups[key] || []).push({ idx, val, ext: !!m[3], numbered: !!m[2] });
    }
    const params = Object.create(null);
    for (const key of Object.keys(groups)) {
      // when both "name" and "name*" exist, the RFC 2231 form wins
      const byIdx = new Map();
      for (const it of groups[key]) {
        const prev = byIdx.get(it.idx);
        if (!prev || (it.ext && !prev.ext) || (it.numbered && !prev.numbered)) byIdx.set(it.idx, it);
      }
      const list = Array.from(byIdx.values()).sort((a, b) => a.idx - b.idx);
      if (list.length === 1 && !list[0].ext) {
        params[key] = decodeHeaderValue(list[0].val);
        continue;
      }
      let charset = '';
      const chunks = [];
      list.forEach((it, i) => {
        let v = it.val;
        if (it.ext) {
          if (i === 0) {
            const m2 = /^([^']*)'[^']*'([\s\S]*)$/.exec(v);
            if (m2) {
              charset = m2[1];
              v = m2[2];
            }
          }
          chunks.push(pctToBytes(v));
        } else {
          chunks.push(binToBytes(v));
        }
      });
      const joined = concatBytes(chunks);
      const text = decodeBytes(joined, charset);
      params[key] = /=\?/.test(text) ? decodeHeaderValue(text) : text;
    }
    return { value, params };
  }

  // ---------------------------------------------------------------- entities

  function splitHeaderBody(bin) {
    const lead = /^\r?\n/.exec(bin);
    if (lead) return { headerBin: '', bodyBin: bin.slice(lead[0].length) };
    const m = /\r?\n\r?\n/.exec(bin);
    if (!m) return { headerBin: bin, bodyBin: '' };
    return { headerBin: bin.slice(0, m.index), bodyBin: bin.slice(m.index + m[0].length) };
  }

  // Only spaces and tabs may follow a boundary on its line. Called once per line, so the total stays linear.
  function restOfLineIsBlank(s, from) {
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (c === '\n' || c === '\r') return true;
      if (c !== ' ' && c !== '\t') return false;
    }
    return true;
  }

  function splitMultipart(body, boundary) {
    const delim = '--' + boundary;
    const parts = [];
    let start = -1;
    let idx = body.indexOf(delim);
    while (idx !== -1) {
      const atLineStart = idx === 0 || body[idx - 1] === '\n';
      const tail = idx + delim.length;
      const isClose = atLineStart && body.startsWith('--', tail) && restOfLineIsBlank(body, tail + 2);
      if (atLineStart && (isClose || restOfLineIsBlank(body, tail))) {
        if (start >= 0) {
          let end = idx;
          if (body[end - 1] === '\n') end--;
          if (body[end - 1] === '\r') end--;
          parts.push(body.slice(start, Math.max(start, end)));
        }
        if (isClose) {
          start = -1;
          break;
        }
        const nl = body.indexOf('\n', idx);
        if (nl === -1) {
          start = -1;
          break;
        }
        start = nl + 1;
      }
      idx = body.indexOf(delim, idx + delim.length);
    }
    if (start >= 0) parts.push(body.slice(start)); // missing closing boundary
    return parts;
  }

  function parseEntity(bin, depth) {
    const { headerBin, bodyBin } = splitHeaderBody(bin);
    const headers = parseHeaderLines(headerBin);
    const get = (n) => {
      const h = headers.find((x) => x.name.toLowerCase() === n);
      return h ? h.raw : '';
    };
    const ct = parseStructured(get('content-type'));
    const cd = parseStructured(get('content-disposition'));
    const entity = {
      headers,
      contentType: /^[\w.+-]+\/[\w.+-]+$/.test(ct.value) ? ct.value : 'text/plain',
      ctParams: ct.params,
      disposition: cd.value,
      dispParams: cd.params,
      cte: get('content-transfer-encoding').trim().toLowerCase(),
      contentId: get('content-id').trim().replace(/^<|>$/g, ''),
      bodyBin,
      children: null,
    };
    if (entity.contentType.startsWith('multipart/') && ct.params.boundary && depth < 40) {
      entity.children = splitMultipart(bodyBin, ct.params.boundary).map((p) => parseEntity(p, depth + 1));
    }
    return entity;
  }

  function decodeTransfer(e) {
    if (e.cte === 'base64') return b64ToBytes(e.bodyBin);
    if (e.cte === 'quoted-printable') return qpToBytes(e.bodyBin);
    return binToBytes(e.bodyBin);
  }

  function sniffHtmlCharset(bytes) {
    const head = bytesToBin(bytes.subarray(0, 4096));
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)/i.exec(head);
    return m ? m[1] : '';
  }

  const EXT = {
    'text/plain': '.txt',
    'text/html': '.html',
    'text/calendar': '.ics',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'message/rfc822': '.eml',
    'application/zip': '.zip',
  };

  function defaultName(ct, n) {
    if (ct === 'message/rfc822') return 'message-' + n + '.eml';
    return 'attachment-' + n + (EXT[ct] || '.bin');
  }

  // Format characters (invisible and bidirectional controls) can disguise a file name: with U+202E,
  // "a<RLO>gnp.exe" reads as "aexe.png". The zero width joiner stays because emoji need it.
  function stripInvisible(s) {
    return s.replace(/(?!\u200d)\p{Cf}/gu, '');
  }

  function collect(e, result) {
    if (e.children) {
      for (const c of e.children) collect(c, result);
      return;
    }
    const ct = e.contentType;
    const filename = stripInvisible(e.dispParams.filename || e.ctParams.name || '');
    if (e.disposition !== 'attachment' && !filename && (ct === 'text/plain' || ct === 'text/html')) {
      const bytes = decodeTransfer(e);
      let charset = e.ctParams.charset || '';
      if (ct === 'text/html') {
        if (result.html === null) {
          if (!charset) charset = sniffHtmlCharset(bytes);
          result.html = decodeBytes(bytes, charset);
          return;
        }
      } else {
        const t = decodeBytes(bytes, charset);
        result.text = result.text === null ? t : result.text + '\n\n' + t;
        return;
      }
    }
    const data = decodeTransfer(e);
    const n = result.attachments.length + 1;
    result.attachments.push({
      index: result.attachments.length,
      filename: filename || defaultName(ct, n),
      contentType: ct,
      size: data.length,
      contentId: e.contentId,
      disposition: e.disposition,
      referenced: false,
      bytes: data,
    });
  }

  function stripComments(html) {
    let out = '';
    let pos = 0;
    for (;;) {
      const start = html.indexOf('<!--', pos);
      if (start === -1) return out + html.slice(pos);
      out += html.slice(pos, start);
      const end = html.indexOf('-->', start + 4);
      if (end === -1) return out;
      pos = end + 3;
    }
  }

  // Content-IDs the HTML loads. A "cid:" in a comment or plain text does not count.
  function findCidRefs(html) {
    const refs = new Set();
    const re = /(?:[\s"'/](?:src|srcset|background|poster)\s*=[\s"']*|url\([\s"']*)cid:([^"'\s)>]+)/gi;
    const visible = stripComments(html);
    let m;
    while ((m = re.exec(visible))) {
      let id = m[1];
      try { id = decodeURIComponent(id); } catch (e) { /* keep */ }
      refs.add(id.toLowerCase());
    }
    return refs;
  }

  // Whether the "show remote content" button is worth offering. A wrong answer only affects the
  // button: blocking is done by the CSP. Mind the running time when changing this: two adjacent
  // repeats that can match the same text ("\s*["']?\s*") or "[^>]*" after "<link" take quadratic time.
  function hasRemoteContent(html) {
    return /[\s"'/](?:src|srcset|background|poster)\s*=[\s"']*https?:|url\([\s"']*https?:|@import\s+["']\s*https?:|<(?:link|image)\b[^<>]*\bhref\s*=[\s"']*https?:/i.test(html);
  }

  function parseEmail(input) {
    decoders.clear();
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let bin = bytesToBin(bytes);
    if (bin.charCodeAt(0) === 0xef && bin.charCodeAt(1) === 0xbb && bin.charCodeAt(2) === 0xbf) bin = bin.slice(3);
    const root = parseEntity(bin, 0);
    const result = {
      headers: root.headers.map((h) => ({ name: h.name, value: decodeHeaderValue(h.raw) })),
      text: null,
      html: null,
      attachments: [],
    };
    const get = (n) => {
      const h = result.headers.find((x) => x.name.toLowerCase() === n);
      return h ? h.value : '';
    };
    result.subject = get('subject');
    result.from = get('from');
    result.to = get('to');
    result.cc = get('cc');
    result.bcc = get('bcc');
    result.replyTo = get('reply-to');
    result.date = get('date');
    collect(root, result);

    if (result.html !== null) {
      // Only images shown in the body leave the attachment list. A mail can still hide an image this
      // way (display:none), but not a file that says it is an attachment or not an image.
      const refs = findCidRefs(result.html);
      for (const a of result.attachments) {
        if (a.contentId && a.contentType.startsWith('image/') && a.disposition !== 'attachment' &&
            refs.has(a.contentId.toLowerCase())) {
          a.referenced = true;
        }
      }
    }
    return result;
  }

  return {
    setLocale,
    parseEmail,
    hasRemoteContent,
    stripInvisible,
    decodeHeaderValue,
    decodeBytes,
    b64ToBytes,
    bytesToB64,
    bytesToBin,
  };
});
