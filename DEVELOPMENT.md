# 開発メモ

## 必要なもの

- Node.js 18 以降（公式版。各国語の文字コードを扱う機能が入っています）
- VS Code
- Python 3（テスト用メールを作り直すときだけ）

npm パッケージは使っていないので、`npm install` は不要です。

## よく使うコマンド

| コマンド | 内容 |
| --- | --- |
| `npm test` | テストを実行（`vscode` はテスト内のスタブに置き換えます） |
| `npm run package` | `dist/` に .vsix を作成 |
| `npm run build` | テストしてから .vsix を作成 |

## VS Code で動かして確かめる

このフォルダーを VS Code で開き、F5 を押します。
拡張機能を読み込んだ別ウィンドウが開き、`test/fixtures` のテスト用メールを開いて確認できます。
コードを直したら、そのウィンドウで「Developer: Reload Window」を実行すると反映されます。

画面側（`media/viewer.js`）の不具合は、その別ウィンドウで「Developer: Open Webview Developer Tools」を開くと調べられます。

## ファイル構成

| パス | 役割 |
| --- | --- |
| `extension.js` | 拡張本体。.eml を開く画面の登録、添付の保存、リンクを開く処理 |
| `media/mime.js` | メールの解析（文字コード、MIME、添付）。拡張本体と画面の両方で使う |
| `media/i18n.js` | 画面とメッセージの文言。拡張本体と画面の両方で使う |
| `media/viewer.js` / `viewer.css` | 画面の表示 |
| `package.nls.json` / `package.nls.ja.json` | コマンド名など、`package.json` の文言 |
| `scripts/package.js` | .vsix を作るスクリプト（外部ツール不要） |
| `test/` | テストとテスト用メール |

テスト用メールは `python3 test/fixtures/make_fixtures.py test/fixtures` で作り直せます。
内容はすべて架空のものにしてください。実際のメールの文面、名前、アドレス、ヘッダーの値はコピーしないでください。

## 安全面を手で確かめる

メール本文を組み立てる処理（`media/viewer.js` の `buildSrcdoc`）は DOM が必要なので、`npm test` では動かしません。
ここを変えたら、VS Code で `test/fixtures/5_safety_check.eml` を開き、次を確かめてください。

1. Webview Developer Tools のコンソールに、`remote.example.invalid` の読み込みが CSP で止められたと出ること。Network に `remote.example.invalid` への通信がないこと。Elements で本文の iframe を開き、`#shadow-root`、`template`、`link`、入れ子の `iframe` がないこと（preconnect は Network に出ないので、ここで確かめます）。「link in a shadow root」は表示されません。
2. 「外部コンテンツを表示」を押すと、画像（`1.png`〜`3.png`）と CSS（`a.css`）の読み込みを試すこと（名前解決に失敗して読み込めないのが正常です）。これ以外の `remote.example.invalid` への通信が Network に出ないこと。
3. 「encoded link」を押すと、`%2F` や `%26` が変わらずにブラウザーで開くこと（example.com の 404 ページなどで問題ありません）。
4. 「link in a form」と「in-page link」を押して、前者はブラウザーで開き、後者は画面内の移動だけになること。
5. 添付が 4 個表示され、「すべて保存」で 4 個とも保存できること。名前は `hidden.pdf`、`_CON.txt`、`invoicegnp.exe`、200 バイトに切り詰めた `aaa….txt` になります。

## 言語を追加するとき

1. `media/i18n.js` の `STRINGS` に表を追加します。
2. `package.nls.<言語>.json` を追加し、`scripts/package.js` の `INCLUDE` にも加えます。
3. 文字コードの指定がないメールを読むときの候補を、`media/mime.js` の `LEGACY_CHARSETS` に追加します（必要な場合）。

## バージョンを上げるとき

`package.json` の `version` を上げてから `npm run build` を実行します。
.vsix から入れた拡張は自動更新されないので、「Extensions: Install from VSIX...」で新しい .vsix を入れ直してください。
