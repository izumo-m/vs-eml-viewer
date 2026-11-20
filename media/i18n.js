/*
 * UI strings. Shared by the extension host (Node) and the webview (browser).
 * To add a language, add a table here and a package.nls.<lang>.json next to package.json.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EmlI18n = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STRINGS = {
    en: {
      loading: 'Loading…',
      parseFailed: 'Could not parse the email: {0}',
      readFailed: 'Could not read the file: {0}',
      viewSource: 'View Source',
      viewSourceTitle: 'Open the original file in the text editor',
      tabText: 'Text',
      tabHeaders: 'Headers',
      noSubject: '(no subject)',
      noBody: 'This email has no body',
      mailBody: 'Email body',
      from: 'From',
      to: 'To',
      replyTo: 'Reply-To',
      date: 'Date',
      attachments: 'Attachments: {0}',
      clickToSave: 'Click to save',
      saveAll: 'Save All',
      showRemote: 'Show Remote Content',
      hideRemote: 'Hide Remote Content',
      remoteTitle: 'Remote content is not loaded by default because it can be used to track when an email is opened',
      attachmentNotFound: 'Attachment not found.',
      save: 'Save',
      saved: 'Saved: {0}',
      saveToFolder: 'Save to This Folder',
      savedCount: 'Saved {0} attachment(s).',
      savedPartly: 'Saved {0} attachment(s). Could not save {1}: {2}',
      saveAs: 'Save As…',
      saveAsTitle: 'Save this email as HTML or Markdown',
      pickFormat: 'Choose a format',
      formatHtml: 'Opens in a browser and prints as shown. Remote content is left out.',
      formatMarkdown: 'Remote images become links.',
      exportFailed: 'Could not create the file. Details are in the Webview Developer Tools console.',
      noMail: 'No email is shown.',
      attachmentList: 'Attachments',
      remoteLeftOut: '{0} remote item(s) were left out.',
      image: 'Image',
      imageNamed: 'Image: {0}',
    },
    ja: {
      loading: '読み込み中…',
      parseFailed: 'メールの解析に失敗しました: {0}',
      readFailed: 'ファイルを読めませんでした: {0}',
      viewSource: 'ソースを表示',
      viewSourceTitle: '元のファイルをテキストエディターで開く',
      tabText: 'テキスト',
      tabHeaders: 'ヘッダー',
      noSubject: '(件名なし)',
      noBody: '本文がありません',
      mailBody: 'メール本文',
      from: '差出人',
      to: '宛先',
      replyTo: '返信先',
      date: '日付',
      attachments: '添付 {0}',
      clickToSave: 'クリックして保存',
      saveAll: 'すべて保存',
      showRemote: '外部コンテンツを表示',
      hideRemote: '外部コンテンツを隠す',
      remoteTitle: '外部コンテンツは、開封の確認などに使われることがあるため、初期状態では読み込みません',
      attachmentNotFound: '添付ファイルが見つかりません。',
      save: '保存',
      saved: '保存しました: {0}',
      saveToFolder: 'このフォルダーに保存',
      savedCount: '{0} 個の添付ファイルを保存しました。',
      savedPartly: '{0} 個の添付ファイルを保存しました。{1} 個は保存できませんでした: {2}',
      saveAs: '名前を付けて保存…',
      saveAsTitle: 'このメールを HTML か Markdown で保存',
      pickFormat: '保存する形式を選んでください',
      formatHtml: 'ブラウザーで開いて、そのまま印刷できます。外部コンテンツは含めません',
      formatMarkdown: '外部の画像はリンクにします',
      exportFailed: 'ファイルを作れませんでした。詳しくは Webview Developer Tools のコンソールを見てください。',
      noMail: '表示中のメールがありません。',
      attachmentList: '添付',
      remoteLeftOut: '外部コンテンツ {0} 件を含めていません。',
      image: '画像',
      imageNamed: '画像: {0}',
    },
  };

  function forLocale(locale) {
    const lang = String(locale || '').toLowerCase().split('-')[0];
    const table = Object.prototype.hasOwnProperty.call(STRINGS, lang) ? STRINGS[lang] : STRINGS.en;
    return function t(key, ...args) {
      const s = table[key] !== undefined ? table[key] : STRINGS.en[key];
      return s === undefined ? key : s.replace(/\{(\d+)\}/g, (all, i) => (i < args.length ? String(args[i]) : all));
    };
  }

  return { STRINGS, forLocale };
});
