#!/usr/bin/env python3
import sys, json, base64, re, datetime, os
from pathlib import Path

try:
    import extract_msg
except Exception as e:
    print(json.dumps({"error": f"import extract_msg failed: {e}"}))
    sys.exit(1)

IMG_MARKER = "<!--IMG-MARKER-->"

def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")

def _mime_from_name(name: str) -> str:
    ext = (Path(name).suffix or "").lower().lstrip(".")
    return {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "bmp": "image/bmp",
        "tif": "image/tiff",
        "tiff": "image/tiff",
        "svg": "image/svg+xml",
        "emf": "image/emf",
        "wmf": "image/wmf",
        "ico": "image/x-icon",
        "pdf": "application/pdf",
    }.get(ext, "application/octet-stream")

def _cid_from_attachment(att) -> str:
    for k in ("cid", "contentId", "content_id"):
        if hasattr(att, k):
            v = getattr(att, k)
            if v:
                return v.strip("<>")
    return None

def default_json(obj):
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    return str(obj)

def main(path):
    msg = extract_msg.Message(path)
    msg_message_date = None
    try:
        msg_message_date = msg.date  # may already be str
    except Exception:
        pass

    html = ""
    try:
        html = msg.htmlBody or ""
    except Exception:
        html = ""

    text = ""
    try:
        text = msg.body or ""
    except Exception:
        text = ""

    # Build a map of inline attachments by content-id
    cid_map = {}
    pdf_attachments_b64 = []

    for att in getattr(msg, "attachments", []) or []:
        name = getattr(att, "longFilename", None) or getattr(att, "shortFilename", None) or "attachment"
        raw = getattr(att, "data", None)
        if raw is None:
            # Fallback for older extract_msg versions
            try:
                raw = att._data  # noqa
            except Exception:
                raw = b""
        mime = _mime_from_name(name)
        cid = _cid_from_attachment(att)

        if mime == "application/pdf" and cid is None:
            pdf_attachments_b64.append(_b64(raw))
            continue

        if cid:
            cid_map[cid] = {"mime": mime, "data": _b64(raw), "name": name}

    inline_seq = []

    # Replace each <img ... src="cid:..."> with a marker, and capture the image in order.
    def _img_repl(m):
        src = m.group("src") or ""
        src_low = src.lower()
        if src_low.startswith("cid:"):
            cid = src[4:].strip("<>")
            img = cid_map.get(cid)
            inline_seq.append(img if img else None)
            return IMG_MARKER
        else:
            # remote http(s) images -> keep a placeholder position; node will skip with a small note
            inline_seq.append(None)
            return IMG_MARKER

    html_out = re.sub(r'(?is)<img\b[^>]*src=["\'](?P<src>[^"\']+)["\'][^>]*>', _img_repl, html)

    out = {
        "source": "msg",
        "subject": msg.subject or "",
        "from": msg.sender or "",
        "to": msg.to or "",
        "cc": msg.cc or "",
        "date": msg_message_date,
        "html": html_out,
        "text": text,
        "inlineImages": inline_seq,     # list with possible nulls; order matches markers
        "pdfAttachments": pdf_attachments_b64
    }

    print(json.dumps(out, default=default_json))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: msg_to_json.py <file.msg>"}))
        sys.exit(2)
    main(sys.argv[1])
