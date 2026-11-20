'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const EmlMime = require('./media/mime.js');
const EmlI18n = require('./media/i18n.js');

const VIEW_TYPE = 'emlViewer.preview';
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(vscode.env.language) ? vscode.env.language : 'en';
const t = EmlI18n.forLocale(LOCALE);
EmlMime.setLocale(LOCALE);

const EXPORT_FORMATS = {
  html: { label: 'HTML', ext: 'html', describe: 'formatHtml' },
  md: { label: 'Markdown', ext: 'md', describe: 'formatMarkdown' },
};

const MAX_NAME_BYTES = 200; // file systems allow 255; leaves room for " (123)" and temporary suffixes
const MAX_EXT_BYTES = 20;

// A loop, because a regular expression like /[\s.]+$/ takes quadratic time on a crafted name.
function trimName(name) {
  const isEdge = (c) => c === '.' || /\s/.test(c);
  let start = 0;
  let end = name.length;
  while (start < end && isEdge(name[start])) start++;
  while (end > start && isEdge(name[end - 1])) end--;
  return name.slice(start, end);
}

function truncateBytes(text, max) {
  let out = '';
  let used = 0;
  for (const ch of text) {
    used += Buffer.byteLength(ch);
    if (used > max) break;
    out += ch;
  }
  return out;
}

// Attachment names come from the mail, so they can be crafted.
function sanitizeFileName(name) {
  let cleaned = trimName(EmlMime.stripInvisible(String(name || ''))
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f-\x9f]/g, '_'));

  if (Buffer.byteLength(cleaned) > MAX_NAME_BYTES) {
    const ext = path.extname(cleaned);
    const keepExt = Buffer.byteLength(ext) <= MAX_EXT_BYTES ? ext : '';
    const stem = cleaned.slice(0, cleaned.length - keepExt.length);
    cleaned = trimName(truncateBytes(stem, MAX_NAME_BYTES - Buffer.byteLength(keepExt))) + keepExt;
  }

  // Windows reserves these device names, with or without an extension
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])\s*(?:\.|$)/i.test(cleaned)) cleaned = '_' + cleaned;
  return cleaned || 'attachment';
}

function dirOf(uri) {
  return vscode.Uri.joinPath(uri, '..');
}

async function exists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (e) {
    return false;
  }
}

async function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let target = vscode.Uri.joinPath(dir, name);
  for (let i = 1; i <= 1000; i++) {
    if (!(await exists(target))) return target;
    target = vscode.Uri.joinPath(dir, `${base} (${i})${ext}`);
  }
  throw new Error(`No free name for ${name}`); // never overwrite
}

class EmlEditorProvider {
  constructor(context) {
    this.context = context;
  }

  openCustomDocument(uri) {
    return { uri, dispose() {} };
  }

  async resolveCustomEditor(document, panel) {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.getHtml(panel.webview, mediaRoot);

    const disposables = [];
    // What the webview was last given. The index and name in a save request describe this, not the file
    // on disk, which may have changed since.
    let shown = null;
    const send = async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(document.uri);
        shown = bytes;
        await panel.webview.postMessage({
          type: 'load',
          data: Buffer.from(bytes).toString('base64'),
          name: path.posix.basename(document.uri.path),
        });
      } catch (e) {
        panel.webview.postMessage({ type: 'error', message: t('readFailed', e && e.message ? e.message : e) });
      }
    };

    // Reload when the file changes on disk. Replacing it (mv, or a save by rename) can report as a create.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dirOf(document.uri), path.posix.basename(document.uri.path))
    );
    watcher.onDidChange(send, null, disposables);
    watcher.onDidCreate(send, null, disposables);
    disposables.push(watcher);

    // The format the user picked, until the webview answers. A file is only written in reply to that.
    let pendingExport = null;
    let disposed = false;

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg && msg.type) {
          case 'ready':
            await send();
            break;
          case 'openLink':
            await this.openLink(msg.href);
            break;
          case 'openAsText':
            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            break;
          case 'saveAttachment':
            await this.saveAttachment(document.uri, shown, msg.index, msg.filename);
            break;
          case 'saveAll':
            await this.saveAll(document.uri, shown, msg.items || []);
            break;
          case 'saveAs': {
            const format = await this.pickFormat();
            if (!format || disposed) break;
            pendingExport = format;
            await panel.webview.postMessage({ type: 'export', format });
            break;
          }
          case 'exported': {
            if (!pendingExport || msg.format !== pendingExport || typeof msg.content !== 'string') break;
            pendingExport = null;
            await this.saveExport(document.uri, msg.format, msg.content);
            break;
          }
          case 'exportFailed':
            if (!pendingExport) break;
            pendingExport = null;
            vscode.window.showErrorMessage(`EML Viewer: ${t('exportFailed')}`);
            break;
        }
      } catch (e) {
        vscode.window.showErrorMessage(`EML Viewer: ${e && e.message ? e.message : e}`);
      }
    }, null, disposables);

    panel.onDidDispose(() => {
      disposed = true;
      disposables.forEach((d) => d.dispose());
    });
  }

  async openLink(href) {
    if (typeof href !== 'string') return;
    let url;
    try {
      url = new URL(href);
    } catch (e) {
      return;
    }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return;
    // A Uri decodes and re-encodes its parts, which turns "?u=a%26b" into "?u=a&b" and sends the
    // click to a different address. VS Code opens a string as is, although the API is typed for Uri.
    try {
      await vscode.env.openExternal(url.href);
    } catch (e) {
      await vscode.env.openExternal(vscode.Uri.parse(url.href, true));
    }
  }

  async saveAttachment(emlUri, bytes, index, filename) {
    const atts = bytes ? EmlMime.parseEmail(bytes).attachments : [];
    const att = atts[index];
    if (!att) throw new Error(t('attachmentNotFound'));
    const name = sanitizeFileName(filename || att.filename);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(dirOf(emlUri), name),
      saveLabel: t('save'),
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, att.bytes);
    vscode.window.showInformationMessage(t('saved', path.posix.basename(target.path)));
  }

  async saveAll(emlUri, bytes, items) {
    const atts = bytes ? EmlMime.parseEmail(bytes).attachments : [];
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: dirOf(emlUri),
      openLabel: t('saveToFolder'),
    });
    if (!picked || !picked[0]) return;
    let count = 0;
    const failed = [];
    for (const it of items) {
      const att = atts[it.index];
      if (!att) {
        failed.push(sanitizeFileName(it.filename));
        continue;
      }
      const name = sanitizeFileName(it.filename || att.filename);
      try {
        const target = await uniqueTarget(picked[0], name);
        await vscode.workspace.fs.writeFile(target, att.bytes);
        count++;
      } catch (e) {
        failed.push(name);
      }
    }
    if (failed.length) {
      vscode.window.showErrorMessage(t('savedPartly', count, failed.length, failed.join(', ')));
    } else {
      vscode.window.showInformationMessage(t('savedCount', count));
    }
  }

  async pickFormat() {
    const pick = await vscode.window.showQuickPick(
      Object.keys(EXPORT_FORMATS).map((format) => ({
        label: EXPORT_FORMATS[format].label,
        description: t(EXPORT_FORMATS[format].describe),
        format,
      })),
      { placeHolder: t('pickFormat') }
    );
    return pick ? pick.format : null;
  }

  async saveExport(emlUri, format, content) {
    const f = EXPORT_FORMATS[format];
    const base = path.posix.basename(emlUri.path);
    const stem = base.slice(0, base.length - path.posix.extname(base).length);
    const name = sanitizeFileName((trimName(stem) || 'mail') + '.' + f.ext);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(dirOf(emlUri), name),
      filters: { [f.label]: [f.ext] },
      saveLabel: t('save'),
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    vscode.window.showInformationMessage(t('saved', path.posix.basename(target.path)));
  }

  getHtml(webview, mediaRoot) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (f) => webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, f));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: https: http:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https:`,
      'font-src data: https:',
      'media-src data: https:',
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${LOCALE}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('viewer.css')}">
<title>EML Viewer</title>
</head>
<body>
<div id="app"><div class="loading">${t('loading')}</div></div>
<script nonce="${nonce}" src="${asset('mime.js')}"></script>
<script nonce="${nonce}" src="${asset('i18n.js')}"></script>
<script nonce="${nonce}" src="${asset('export.js')}"></script>
<script nonce="${nonce}" src="${asset('viewer.js')}"></script>
</body>
</html>`;
  }
}

function activate(context) {
  const provider = new EmlEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand('emlViewer.openPreview', (uri) => {
      const target = uri instanceof vscode.Uri
        ? uri
        : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) return;
      return vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
