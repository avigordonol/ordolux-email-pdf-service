#!/usr/bin/env python3
import sys, json, base64, datetime
import extract_msg

def dt(v):
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    return v

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "no file"}))
        return
    p = sys.argv[1]
    m = extract_msg.Message(p)
    m.process()

    atts = []
    for a in m.attachments:
        # a.data is bytes
        data = a.data or b""
        # content-id if present
        cid = ""
        try:
            cid = (a.contentId or "").strip("<>")
        except Exception:
            cid = ""
        ct = ""
        try:
            ct = a.mimeType or ""
        except Exception:
            ct = ""
        atts.append({
            "filename": a.longFilename or a.shortFilename or "",
            "contentType": ct,
            "contentId": cid,
            "inline": bool(cid),
            "dataBase64": base64.b64encode(data).decode("ascii"),
        })

    out = {
        "ok": True,
        "from": (m.sender or "") or (m.sender_email or ""),
        "to": m.to or "",
        "cc": m.cc or "",
        "subject": m.subject or "",
        "date": dt(m.date),
        "text": m.body or "",
        "html": m.htmlBody or "",
        "attachments": atts,
    }
    print(json.dumps(out, ensure_ascii=False))
if __name__ == "__main__":
    main()
