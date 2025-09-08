#!/usr/bin/env python3
import sys, json, base64, datetime

def b64(x: bytes) -> str:
    return base64.b64encode(x).decode('ascii')

def to_iso(dt):
    if isinstance(dt, datetime.datetime):
        if dt.tzinfo is None:
            return dt.isoformat() + "Z"
        return dt.isoformat()
    return None

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: msg_to_json.py PATH.msg"}))
        return

    path = sys.argv[1]

    try:
        import extract_msg
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"extract_msg import failed: {e}"}))
        return

    try:
        msg = extract_msg.Message(path)
        msg_sender = (msg.sender or "").replace("\t", " ")
        msg_to = (msg.to or "").replace("\t", " ")
        msg_cc = (getattr(msg, 'cc', '') or "").replace("\t", " ")
        subject = (msg.subject or "").replace("\t", " ")
        date_iso = to_iso(getattr(msg, 'date', None))

        body_html = getattr(msg, 'htmlBody', None)
        body_text = getattr(msg, 'body', None)

        atts = []
        for a in msg.attachments:
            # Try a bunch of common fields for CID & name/type
            cid = None
            for cand in ('cid', 'content_id', 'contentId', 'pidContentId', 'pid_content_id'):
                cid = cid or getattr(a, cand, None)
            filename = getattr(a, 'longFilename', None) or getattr(a, 'shortFilename', None) or getattr(a, 'filename', None)
            content_type = getattr(a, 'mimetype', None) or getattr(a, 'mimeType', None) or "application/octet-stream"
            data = a.data if hasattr(a, 'data') else None
            if data is None:
                # Some versions expose ._data
                data = getattr(a, '_data', None)
            if data is None:
                continue

            atts.append({
                "filename": filename or "attachment",
                "contentType": content_type,
                "contentId": (cid or "").strip().strip("<>"),
                "isInline": bool(cid),
                "dataB64": b64(data),
            })

        out = {
            "ok": True,
            "meta": {
                "source": "msg",
                "has_html": bool(body_html),
                "attachment_count": len(atts),
            },
            "message": {
                "from": msg_sender,
                "to": msg_to,
                "cc": msg_cc,
                "subject": subject,
                "date": date_iso,
                "body_html": body_html,
                "body_text": body_text,
                "attachments": atts
            }
        }
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    main()
