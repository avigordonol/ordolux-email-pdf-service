#!/usr/bin/env python3
# Convert a .msg file into structured JSON for Node.
# Uses extract_msg and prefers HTML body. Captures inline CID images.

import sys, json, base64, mimetypes
import extract_msg  # installed in the image

if len(sys.argv) != 2:
    print(json.dumps({"error": "usage: msg_to_json.py <file.msg>"}))
    sys.exit(1)

fn = sys.argv[1]
msg = extract_msg.Message(fn)

def recipients_by(kind_upper):
    out = []
    try:
        for r in getattr(msg, "recipients", []):
            typ = (getattr(r, "type", "") or "").strip().upper()
            if typ == kind_upper:
                name = getattr(r, "name", "") or getattr(r, "display_name", "") or ""
                addr = (
                    getattr(r, "email", "")
                    or getattr(r, "email_address", "")
                    or getattr(r, "smtp_address", "")
                    or getattr(r, "address", "")
                    or ""
                )
                out.append({"name": name, "address": addr})
    except Exception:
        pass
    return out

# Sender
from_list = []
try:
    from_list = [{
        "name": getattr(msg, "sender", "") or "",
        "address": getattr(msg, "sender_email", "") or getattr(msg, "sender_email_address", "") or ""
    }]
except Exception:
    pass

# Body
try:
    html = getattr(msg, "htmlBody", "") or ""
except Exception:
    html = ""
try:
    text = getattr(msg, "body", "") or ""
except Exception:
    text = ""

# Attachments
atts = []
for a in getattr(msg, "attachments", []):
    try:
        data = a.data
    except Exception:
        try:
            data = a._data
        except Exception:
            data = b""
    cid = getattr(a, "contentId", None) or getattr(a, "cid", None) or ""
    fname = getattr(a, "longFilename", None) or getattr(a, "shortFilename", None) or "attachment"
    ctype = getattr(a, "mimeType", None) or mimetypes.guess_type(fname)[0] or "application/octet-stream"
    inline = bool(cid)
    atts.append({
        "filename": fname,
        "contentType": ctype,
        "contentId": str(cid) if cid else "",
        "inline": inline,
        "data": base64.b64encode(data).decode("ascii")
    })

out = {
    "subject": getattr(msg, "subject", "") or "",
    "date": getattr(msg, "date", "") or "",
    "from": from_list,
    "to": recipients_by("TO"),
    "cc": recipients_by("CC"),
    "html": html,
    "text": text,
    "attachments": atts
}

print(json.dumps(out))
