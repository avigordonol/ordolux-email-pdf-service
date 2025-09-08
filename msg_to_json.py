#!/usr/bin/env python3
import sys, json, base64, datetime

def default(o):
    if isinstance(o, (datetime.datetime, datetime.date)):
        return o.isoformat()
    raise TypeError(f"Object of type {o.__class__.__name__} is not JSON serializable")

def norm(s):
    if s is None:
        return None
    if isinstance(s, bytes):
        try:
            return s.decode("utf-8", errors="replace")
        except Exception:
            return s.decode("latin-1", errors="replace")
    return str(s)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error":"missing path"}))
        return

    path = sys.argv[1]

    # Lazy import so python -c check is quick
    import extract_msg

    msg = extract_msg.Message(path)
    msg_message = msg

    subject = norm(getattr(msg_message, "subject", None))
    sender  = norm(getattr(msg_message, "sender", None) or getattr(msg_message, "sender_email", None))
    to_     = norm(getattr(msg_message, "to", None))
    cc_     = norm(getattr(msg_message, "cc", None))
    date    = getattr(msg_message, "date", None)

    # Bodies
    html = norm(getattr(msg_message, "htmlBody", None))
    text = norm(getattr(msg_message, "body", None))

    # Attachments (inline + regular)
    atts = []
    try:
        for a in (getattr(msg_message, "attachments", []) or []):
            fn = norm(getattr(a, "longFilename", None) or getattr(a, "shortFilename", None))
            ct = norm(getattr(a, "mimetype", None) or getattr(a, "mimeType", None))
            cid = norm(getattr(a, "cid", None) or getattr(a, "contentId", None))
            # data attribute may be bytes or has a .data property depending on version
            data = getattr(a, "data", None)
            if data is None and hasattr(a, "getData"):
                data = a.getData()
            if data is None and hasattr(a, "data"):
                data = a.data
            if isinstance(data, memoryview):
                data = data.tobytes()
            if data is None:
                continue
            atts.append({
                "filename": fn or "",
                "contentType": ct or "application/octet-stream",
                "contentId": cid or "",
                "isInline": bool(cid),
                "dataBase64": base64.b64encode(data).decode("ascii")
            })
    except Exception as e:
        # Don't fail conversion if attachments parsing is odd
        atts = []

    out = {
        "kind": "msg",
        "headers": {
            "from": sender,
            "to": to_,
            "cc": cc_,
            "subject": subject,
            "date": date
        },
        "body": {
            "html": html,
            "text": text
        },
        "attachments": atts
    }

    print(json.dumps(out, default=default))

if __name__ == "__main__":
    main()
