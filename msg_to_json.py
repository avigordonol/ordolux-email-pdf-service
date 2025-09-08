#!/usr/bin/env python3
import sys, json, base64, datetime
from extract_msg import Message

def b64(x: bytes) -> str:
    return base64.b64encode(x).decode('ascii')

def iso(dt):
    if not dt:
        return None
    if isinstance(dt, datetime.datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt.astimezone(datetime.timezone.utc).isoformat()
    return str(dt)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "no input path"}))
        return
    path = sys.argv[1]
    try:
        msg = Message(path)
        msg_sender = (msg.sender or msg.header.get('From') or "").strip()
        msg_to     = (msg.to or msg.header.get('To') or "").strip()
        msg_cc     = (msg.cc or msg.header.get('Cc') or "").strip()
        subject    = (msg.subject or "").strip()
        date_iso   = iso(msg.date)

        body_html  = msg.htmlBody if msg.htmlBody else None
        body_text  = msg.body if msg.body else None

        atts = []
        for a in msg.attachments:
            data = None
            try:
                data = a.data
            except Exception:
                data = None
            atts.append({
                "filename": a.longFilename or a.shortFilename or "attachment",
                "contentType": a.mimeType or "application/octet-stream",
                # extract_msg rarely exposes CID; keep empty unless present
                "contentId": (getattr(a, "cid", None) or getattr(a, "content_id", None) or "") or "",
                "isInline": bool(getattr(a, "cid", None) or getattr(a, "content_id", None)),
                "dataB64": b64(data) if isinstance(data, (bytes, bytearray)) else None
            })

        out = {
            "ok": True,
            "meta": {
                "source": "msg",
                "has_html": bool(body_html),
                "attachment_count": len(atts)
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
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    main()
