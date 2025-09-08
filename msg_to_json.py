#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys, os, json, base64
from datetime import datetime, date
try:
    import extract_msg
except Exception as e:
    print(json.dumps({"ok": False, "error": f"extract_msg import failed: {e}"}))
    sys.exit(1)

def _to_jsonable(x):
    """Convert values so json.dumps won't choke (datetime, bytes, etc.)."""
    if isinstance(x, (datetime, date)):
        try:
            return x.isoformat()
        except Exception:
            return str(x)
    if isinstance(x, bytes):
        try:
            return x.decode("utf-8", "replace")
        except Exception:
            return base64.b64encode(x).decode("ascii")
    return x

def _normalize(obj):
    if isinstance(obj, dict):
        return {str(k): _normalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize(v) for v in obj]
    return _to_jsonable(obj)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: msg_to_json.py <file.msg>"}))
        return 1

    path = sys.argv[1]
    if not os.path.exists(path):
        print(json.dumps({"ok": False, "error": f"file not found: {path}"}))
        return 1

    try:
        msg = extract_msg.Message(path)
        msg_message_id = getattr(msg, "message_id", None)
        # Bodies
        text_body = getattr(msg, "body", None) or ""
        html_body = getattr(msg, "htmlBody", None) or ""

        # Headers
        headers = {
            "from":   getattr(msg, "sender", None) or getattr(msg, "sender_email", None) or "",
            "to":     getattr(msg, "to", None) or "",
            "cc":     getattr(msg, "cc", None) or "",
            "bcc":    getattr(msg, "bcc", None) or "",
            "subject":getattr(msg, "subject", None) or "",
            "date":   getattr(msg, "date", None),          # may be datetime; _normalize() will fix
            "message_id": msg_message_id,
        }

        # Attachments (include minimal safe info + base64 data for merge)
        atts = []
        for a in getattr(msg, "attachments", []):
            try:
                fname = getattr(a, "longFilename", None) or getattr(a, "shortFilename", None) or "attachment"
            except Exception:
                fname = "attachment"
            try:
                data = getattr(a, "data", None)
            except Exception:
                data = None
            size = len(data) if isinstance(data, (bytes, bytearray)) else 0
            content_id = getattr(a, "cid", None) or getattr(a, "contentId", None)
            mimetype = getattr(a, "mimetype", None)  # may be None; server can guess
            # base64 the data so Node can merge PDFs if desired
            b64 = base64.b64encode(data).decode("ascii") if data else None

            atts.append({
                "filename": fname,
                "contentId": content_id,
                "contentType": mimetype,
                "size": size,
                "isInline": bool(content_id),
                "data_b64": b64,
            })

        out = _normalize({
            "ok": True,
            "headers": headers,
            "text": text_body,
            "html": html_body,
            "attachments": atts,
        })

        print(json.dumps(out, ensure_ascii=False))
        return 0

    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1

if __name__ == "__main__":
    sys.exit(main())
