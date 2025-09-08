#!/usr/bin/env python3
import sys, json, base64, datetime
import extract_msg

def to_iso(d):
    try:
        if isinstance(d, datetime.datetime):
            return d.isoformat()
        return str(d) if d else None
    except Exception:
        return None

def first_attr(obj, names):
    for n in names:
        if hasattr(obj, n):
            v = getattr(obj, n)
            if v:
                return v
    return None

def fmt_people(p):
    if not p:
        return ""
    # extract_msg returns strings; sometimes lists for certain fields
    if isinstance(p, list):
        return "; ".join([str(x) for x in p if x])
    return str(p)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: msg_to_json.py <file>"}))
        return

    path = sys.argv[1]
    try:
        m = extract_msg.Message(path)
        # force attachment loading
        _ = m.attachments

        html = first_attr(m, ["htmlBody", "HTMLBody", "HtmlBody", "html"])
        text = first_attr(m, ["body", "Body", "text"])

        atts = []
        for a in (m.attachments or []):
            try:
                ct  = first_attr(a, ["mimeType", "mimetype", "mimetypestr"]) or ""
                cid = first_attr(a, ["cid", "content_id", "contentId"])
                name = first_attr(a, ["longFilename", "shortFilename", "filename"]) or ""
                data = getattr(a, "data", None)
                if data is None and hasattr(a, "getBinary"):
                    data = a.getBinary()
                size = len(data) if data else 0
                b64  = base64.b64encode(data).decode("ascii") if data else None
                atts.append({
                    "filename": name,
                    "contentType": ct,
                    "contentId": cid,
                    "isInline": bool(cid),
                    "size": size,
                    "base64": b64
                })
            except Exception as e:
                atts.append({"filename": "unknown", "error": str(e)})

        out = {
            "ok": True,
            "meta": { "source": "msg" },
            "message": {
                "from": fmt_people(m.sender),
                "to": fmt_people(getattr(m, "to", None)),
                "cc": fmt_people(getattr(m, "cc", None)),
                "subject": m.subject or "",
                "date": to_iso(getattr(m, "date", None)),
                "text": text or "",
                "html": html or "",
                "attachments": atts
            }
        }
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    main()
