"""Generate tricky .eml test files.

Usage: python test/fixtures/make_fixtures.py test/fixtures
"""
import base64, os, quopri, sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def to_jis(text: str) -> bytes:
    """Encode via cp932 then convert to ISO-2022-JP (NEC extensions, half-width kana via ESC ( I)."""
    src = text.encode("cp932")
    res = bytearray()
    mode = "ascii"
    i = 0
    while i < len(src):
        b = src[i]
        if b < 0x80:
            if mode != "ascii":
                res += b"\x1b(B"
                mode = "ascii"
            res.append(b)
            i += 1
        elif 0xA1 <= b <= 0xDF:
            if mode != "kana":
                res += b"\x1b(I"
                mode = "kana"
            res.append(b - 0x80)
            i += 1
        else:
            s1, s2 = b, src[i + 1]
            if s1 >= 0xE0:
                s1 -= 0x40
            j1 = (s1 - 0x81) * 2 + 0x21
            if s2 >= 0x9F:
                j1 += 1
                j2 = s2 - 0x9F + 0x21
            else:
                j2 = s2 - 0x40 + 0x21 - (1 if s2 >= 0x80 else 0)
            if mode != "jis":
                res += b"\x1b$B"
                mode = "jis"
            res += bytes([j1, j2])
            i += 2
    if mode != "ascii":
        res += b"\x1b(B"
    return bytes(res)


def ew(text, charset="ISO-2022-JP"):
    raw = to_jis(text) if charset == "ISO-2022-JP" else text.encode(charset)
    return f"=?{charset}?B?{base64.b64encode(raw).decode()}?="


# All names, addresses and text below are made up. Never copy anything from a real mail here.

# 1: iso-2022-jp, alternative, NEC chars, half-width kana
body_txt = "こんにちは。\r\n①サンプルの本文です。\r\n㈱サンプル ﾊﾝｶｸｶﾅ も確認。\r\nhttps://example.com/form?id=1\r\n"
body_html = "<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=iso-2022-jp\"></head><body><p>こんにちは。</p><p><b>①サンプル</b>の本文です。㈱サンプル ﾊﾝｶｸ</p><p><a href=\"https://example.com/\">リンク</a></p><img src=\"https://tracker.example.com/p.gif\"></body></html>"
m1 = (
    b"From: " + ew("テスト送信者").encode() + b" <sender@example.jp>\r\n"
    b"To: " + ew("テスト受信者").encode() + b" <receiver@example.jp>\r\n"
    b"Subject: " + ew("【テスト】分割された").encode() + b"\r\n " + ew("サンプルの件名").encode() + b"\r\n"
    b"Date: Fri, 1 Jan 2021 09:30:00 +0900 (JST)\r\n"
    b"MIME-Version: 1.0\r\n"
    b"Content-Type: multipart/alternative;\r\n\tboundary=\"_000_SAMPLE_\"\r\n\r\n"
    b"--_000_SAMPLE_\r\nContent-Type: text/plain; charset=\"iso-2022-jp\"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n"
    + to_jis(body_txt) +
    b"\r\n--_000_SAMPLE_\r\nContent-Type: text/html; charset=\"iso-2022-jp\"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n"
    + to_jis(body_html) +
    b"\r\n--_000_SAMPLE_--\r\n"
)
open(f"{out}/1_iso2022jp.eml", "wb").write(m1)

# 2: mixed: utf-8 QP text + base64 html with cid image, several attachment-name encodings, nested eml
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
html2 = '<html><body><p>画像付きのメールです。</p><img src="cid:img1@example"></body></html>'.encode()
inner = (
    b"Subject: " + ew("転送元のメール", "UTF-8").encode() + b"\r\nFrom: a@example.com\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n\r\n" + "中のメール".encode() + b"\r\n"
)
long_name = "とても長い添付ファイルの名前_サンプル_テスト用データ.xlsx".encode()
pct = "".join(f"%{b:02X}" for b in long_name)
sender_qp = "".join(f"={b:02X}" for b in "送信者".encode())
single_pct = "".join(f"%{b:02X}" for b in "サンプル".encode())
m2 = b"".join([
    b"From: =?UTF-8?Q?" + sender_qp.encode() + b"?= <sender@example.com>\r\n",
    b"To: a@example.com, " + ew("受信者", "UTF-8").encode() + b" <b@example.com>\r\n",
    b"Subject: " + ew("添付テスト", "UTF-8").encode() + b"\r\n",
    b"Date: Sat, 02 Jan 2021 18:05:12 +0900\r\nMIME-Version: 1.0\r\n",
    b'Content-Type: multipart/mixed; boundary="MIX"\r\n\r\nThis is a multi-part message.\r\n',
    b'--MIX\r\nContent-Type: multipart/related; boundary="REL"\r\n\r\n',
    b'--REL\r\nContent-Type: multipart/alternative; boundary="ALT"\r\n\r\n',
    b"--ALT\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n",
    quopri.encodestring("画像付きのメールです。テキスト版。".encode()).replace(b"\n", b"\r\n"),
    b"\r\n--ALT\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
    base64.encodebytes(html2).replace(b"\n", b"\r\n"),
    b"--ALT--\r\n",
    b"--REL\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <img1@example>\r\nContent-Disposition: inline\r\n\r\n",
    base64.encodebytes(png).replace(b"\n", b"\r\n"),
    b"--REL--\r\n",
    # RFC 2231 single
    b"--MIX\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n"
    b"Content-Disposition: attachment; filename*=UTF-8''" + single_pct.encode() + b".pdf\r\n\r\n",
    base64.encodebytes(b"%PDF-1.4 dummy").replace(b"\n", b"\r\n"),
    # encoded-word filename in iso-2022-jp (Outlook / Japanese mailers)
    b'--MIX\r\nContent-Type: text/plain; name="' + ew("メモ.txt").encode() + b'"\r\n'
    b"Content-Transfer-Encoding: base64\r\n"
    b'Content-Disposition: attachment; filename="' + ew("メモ.txt").encode() + b'"\r\n\r\n',
    base64.encodebytes("メモの中身".encode("cp932")).replace(b"\n", b"\r\n"),
    # RFC 2231 continuation
    b"--MIX\r\nContent-Type: application/vnd.ms-excel\r\nContent-Transfer-Encoding: base64\r\n"
    b"Content-Disposition: attachment;\r\n filename*0*=UTF-8''" + pct[:60].encode() + b";\r\n filename*1*=" + pct[60:].encode() + b"\r\n\r\n",
    base64.encodebytes(b"xlsx").replace(b"\n", b"\r\n"),
    b"--MIX\r\nContent-Type: message/rfc822\r\n\r\n" + inner,
    b"--MIX--\r\n",
])
open(f"{out}/2_mixed_utf8.eml", "wb").write(m2)

# 3: raw (unencoded) JIS in headers + Shift_JIS body labelled x-sjis, no MIME-Version
m3 = (
    b"From: " + to_jis("古いメーラー") + b" <old@example.jp>\r\n"
    b"Subject: " + to_jis("生のJISの件名") + b"\r\n"
    b"Date: Mon, 1 Jan 2001 00:00:00 +0900\r\n"
    b"Content-Type: text/plain; charset=x-sjis\r\n\r\n" + "シフトJISの本文です。①②③".encode("cp932") + b"\r\n"
)
open(f"{out}/3_raw_jis_sjis.eml", "wb").write(m3)

# 4: raw UTF-8 8bit header, EUC-JP html body, no charset param (meta only)
m4 = (
    "Subject: 生のUTF-8件名\r\nFrom: x@example.com\r\nContent-Type: text/html\r\n\r\n".encode()
    + '<html><head><meta charset="euc-jp"></head><body>EUC-JPの本文</body></html>'.encode("euc_jp")
)
open(f"{out}/4_utf8hdr_eucjp.eml", "wb").write(m4)

# 5: a hostile mail, for checking the safety of the viewer by hand (see DEVELOPMENT.md).
#    .invalid never resolves, so nothing is ever contacted.
html5 = (
    '<html><head>'
    '<link rel="stylesheet preconnect" href="https://remote.example.invalid/a.css">'
    '<link rel="dns-prefetch" href="https://remote.example.invalid/">'
    '<meta http-equiv="refresh" content="0;url=https://remote.example.invalid/">'
    '</head><body>'
    '<img name="head" alt="remote 1" src="https://remote.example.invalid/1.png">'
    '<img name="documentElement" alt="remote 2" src="https://remote.example.invalid/2.png">'
    '<img name="addEventListener" alt="remote 3" src="https://remote.example.invalid/3.png">'
    '<!-- cid:hidden@example -->'
    '<iframe srcdoc="&lt;link rel=preconnect href=https://remote.example.invalid/nested&gt;"></iframe>'
    '<form><math><mtext></form><form><mglyph><style></math><link rel=preconnect href=https://remote.example.invalid/mutated>'
    # differs between the quirks and no-quirks parsing rules
    '<math><mtext><p><table></table><mglyph><style><div><link rel=preconnect href=https://remote.example.invalid/quirks></div></style></mglyph></mtext></math>'
    # a declarative shadow root: live in the frame, but invisible to the cleaning unless <template> is removed
    '<div><template shadowrootmode="open">'
    '<iframe srcdoc="&lt;link rel=preconnect href=https://remote.example.invalid/shadow&gt;"></iframe>'
    '<a href="https://remote.example.invalid/shadow-link">link in a shadow root</a>'
    '</template></div>'
    '<p><a href="https://example.com/r?u=https%3A%2F%2Fy.example%2Fp%3Fa%3D1%26b%3D2">encoded link</a></p>'
    '<p><a href="https://example.com/q?a=b%2Bc%23d">encoded query</a></p>'
    '<form><input name="closest"><a href="https://example.com/in-form">link in a form</a></form>'
    '<p id="top"><a href="#top">in-page link</a></p>'
    '</body></html>'
)
rlo = "".join(f"%{b:02X}" for b in "invoice\u202egnp.exe".encode())
m5 = b"".join([
    b"From: sender@example.com\r\nSubject: Safety check\r\nMIME-Version: 1.0\r\n",
    b'Content-Type: multipart/mixed; boundary="B5"\r\n\r\n',
    b"--B5\r\nContent-Type: text/html; charset=utf-8\r\n\r\n", html5.encode(), b"\r\n",
    b"--B5\r\nContent-Type: application/pdf\r\nContent-ID: <hidden@example>\r\n"
    b'Content-Disposition: attachment; filename="hidden.pdf"\r\n\r\ndummy\r\n',
    b'--B5\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="CON.txt"\r\n\r\ndummy\r\n',
    b"--B5\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename*=UTF-8''" + rlo.encode() + b"\r\n\r\ndummy\r\n",
    b'--B5\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="' + b"a" * 300 + b'.txt"\r\n\r\ndummy\r\n',
    b"--B5--\r\n",
])
open(f"{out}/5_safety_check.eml", "wb").write(m5)
print("ok")
