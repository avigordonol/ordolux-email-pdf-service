# py/parse_eml_minimal.py
import sys, base64, email
from email import policy
from email.parser import BytesParser

def b64(b):
    if b is None: return None
    return base64.b64encode(b).decode("ascii")

def get_payload_bytes(part):
    try:
        return part.get_payload(decode=True)
    except Exception:
        p = part.get_payload()
        if isinstance(p, str):
            return p.encode("utf-8", "replace")
        return None

def main():
    raw = sys.stdin.buffer.read()
    msg = BytesParser(policy=policy.default).parsebytes(raw)

    subject = msg.get("Subject", "")
    from_   = msg.get("From", "")
    to      = msg.get("To", "")
    date    = msg.get("Date", "")

    html = None
    text = None
    atts = []

    for part in msg.walk():
        ctype = part.get_content_type()
        disp  = (part.get("Content-Disposition") or "").lower()
        cid   = part.get("Content-ID") or part.get("Content-Id") or part.get("ContentID")
        fname = part.get_filename()

        if ctype == "text/html" and html is None:
            payload = part.get_payload(decode=True)
            if payload is not None:
                try:
                    html = payload.decode(part.get_content_charset() or "utf-8", "replace")
                except Exception:
                    html = payload.decode("utf-8", "replace")

        elif ctype == "text/plain" and text is None:
            payload = part.get_payload(decode=True)
            if payload is not None:
                try:
                    text = payload.decode(part.get_content_charset() or "utf-8", "replace")
                except Exception:
                    text = payload.decode("utf-8", "replace")

        if part.is_multipart():
            continue

        data = get_payload_bytes(part)
        if data:
            item = {
                "contentType": ctype,
                "filename": fname,
                "contentId": cid,
                "disposition": disp,
                "dataBase64": b64(data),
            }
            # Keep parts that could be inline or attachments (including ones with CID)
            # Skip only the main plain/html parts we've already captured
            keep = True
            if cid is None and ctype.startswith("text/") and ("inline" not in disp):
                # likely the same as html/text body already captured
                keep = False
            if keep:
                atts.append(item)

    out = {
        "ok": True,
        "subject": subject,
        "from": from_,
        "to": to,
        "date": date,
        "html": html,
        "text": text,
        "attachments": atts,
    }
    sys.stdout.write(__import__("json").dumps(out))

if __name__ == "__main__":
    main()
