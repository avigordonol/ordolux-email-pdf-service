#!/usr/bin/env python3
import sys, json, base64, datetime
import extract_msg

def b64(x: bytes) -> str:
    return base64.b64encode(x).decode('ascii')

def to_text(addr):
    # extract_msg may return str or list-like; normalize
    if not addr:
        return ""
    try:
        if isinstance(addr, (list, tuple)):
            return ", ".join([str(a) for a in addr if a])
        return str(addr)
    except Exception:
        return str(addr)

def to_iso(dt):
    if not dt:
        return ""
    if isinstance(dt, datetime.datetime):
        if dt.tzinfo is None:
            return dt.replace(tzinfo=datetime.timezone.utc).isoformat()
        return dt.isoformat()
    return str(dt)

def main():
    if len(sys.argv) != 2:
        print(json.dumps({ "error": "usage: msg_to_json.py /path/file.msg" }))
        sys.exit(1)

    path = sys.argv[1]
    msg = extract_msg.Message(path)

    # Body: both HTML and text if available
    body_html = msg.htmlBody or ""
    body_text = msg.body or ""

    atts = []
    # Some .msg embed inline images as Attachment objects
    for a in msg.attachments:
        data = None
        try:
            data = a.data if hasattr(a, "data") else a._file._getStream()
        except Exception:
            data = None
        entry = {
            "filename": getattr(a, "longFilename", None) or getattr(a, "shortFilename", None) or "file",
            "contentType": getattr(a, "mimetag", None) or "",
            "contentId": getattr(a, "cid", None) or None,
            "dataBase64": b64(data) if isinstance(data, (bytes, bytearray)) else None
        }
        atts.append(entry)

    out = {
        "meta": { "source": "msg", "has_html": bool(body_html), "attachment_count": len(atts) },
        "message": {
            "from": to_text(msg.sender),
            "to": to_text(msg.to),
            "cc": to_text(msg.cc),
            "subject": msg.subject or "",
            "date": to_iso(msg.date),
            "body_html": body_html,
            "body_text": body_text,
            "attachments": atts
        }
    }
    print(json.dumps(out))

if __name__ == "__main__":
    main()
