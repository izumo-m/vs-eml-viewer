# EML Viewer

Read email files (.eml) in VS Code. [日本語](README.ja.md)

## Features

- Opens .eml files as a formatted email automatically.
- Decodes the charsets a browser supports, including UTF-8, ISO-8859-*, Windows-125x, KOI8-R, GBK, GB18030, Big5, EUC-KR, ISO-2022-JP, Shift_JIS and EUC-JP.
- Decodes encoded subjects, senders and attachment names (`=?ISO-2022-JP?B?...?=`, RFC 2231).
- Switches between the HTML body, the text body and the full header list.
- Saves an attachment when you click it. Images embedded in the body are shown in place.
- Shows its interface in English or Japanese, following the VS Code display language.

## Text with no charset label

Text that does not say which charset it uses is tried as UTF-8 first, then as the legacy charsets of your VS Code display language (for example EUC-JP and Shift_JIS for Japanese, GB18030 for Simplified Chinese), and finally as Windows-1252. Such a mail written in another language can show up garbled.

## Safety

- Scripts in an email do not run.
- Remote content is not loaded by default, because it can be used to track when an email is opened. Press "Show Remote Content" when you need it.
- Links open in the browser only for http, https and mailto.

## Install

The extension is not on the Marketplace. Build the package, then install it:

1. Run `npm run package`. Node.js 18 or later is required, and there is nothing else to install.
2. In VS Code, run "Extensions: Install from VSIX..." and choose the .vsix file in `dist/`.

## Seeing the original text

Press "View Source" at the top right to open the file in the normal text editor.
To come back, press "Open in EML Viewer" at the top right of the editor.

## Known limitations

VS Code keyboard shortcuts such as Ctrl+P do not work while the focus is in the HTML body, because it is kept in a separate frame for safety. Click the subject or another part of the header first.

## License

[MIT](LICENSE.txt)
