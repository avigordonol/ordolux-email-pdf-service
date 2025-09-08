#!/usr/bin/env python3
import sys, json, base64, mimetypes, datetime
from bs4 import BeautifulSoup

# extract_msg imports
import extract_msg
from striprtf.striprtf import rtf_to_text

def to_iso(dt):
    if isinstance(dt, datetime.datetime):
        try:
            return dt.isoformat()
        except Exception:
            return str(dt)
    return str(dt) if dt is not None else None

def safe_text_from_html(html):
    try:
        soup = BeautifulSoup(html, "html.parser")
        # collapse excessive whitespace but keep line breaks for paragraphs
        for br in soup.find_all(["br", "p", "div", "li"]):
            br.insert_after("\n")
        txt = soup.get_text()
        # normalize spaces
        return "\n".join([line.strip() for line in txt.splitlines() if line.strip() != ""])
    except Exception:
        return None

def body_variants(msg):
    html = getattr(msg, "htmlBody", None)
    text = getattr(msg, "body", None)

    if html and isinstance(html, (str, bytes)):
        if isinstance(html, bytes):
            try: html = html.decode("utf-8", "ignore")
            except Exception: html = html.decode("latin-1", "ignore")
        text_from_html = safe_text_from_html(html)
        return {"body_html": html, "body_text": text_from_html or text or ""}

    # Fallback: try RTF -> text
    rtf = getattr(msg, "rtfBody", None)
    if rtf and isinstance(rtf, (bytes, bytearray)):
        try:
            rtf_str = rtf.decode("latin-1", "ignore")
        except Exception:
            rtf_str = str(rtf)
        try:
            text_from_rtf = rtf_to_text(rtf_str)
            return {"body_html": None, "body_text": text_from_rtf}
        except Exception:
            pass

    return {"body_html": None, "body_text": text or ""}

def gather_attachments(msg):
    atts = []
    try:
        for a in msg.attachments:
            name = getattr(a, "longFilename", None) or getattr(a, "shortFilename", None) or "attachment"
            data = getattr(a, "data", None)
            cid  = getattr(a, "cid", None) or getattr(a, "contentId", None) or getattr(a, "content_id", None)
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"

            entry = {
                "filename": name,
                "content_type": mime,
                "content_id": cid,
                "is_inline": bool(cid)
            }

            # Include bytes for inline images so Node can render them in-PDF
            if data and mime.startswith("image/") and entry["is_inline"]:
                entry["data_base64"] = base64.b64encode(data).decode("ascii")

            atts.append(entry)
    except Exception:
        pass
    return atts

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: msg_to_json.py <path>"}))
        return

    path = sys.argv[1]
    msg = extract_msg.Message(path)
    msg_sender = getattr(msg, "sender", None) or getattr(msg, "senderName", None)
    msg_to = getattr(msg, "to", None)
    msg_cc = getattr(msg, "cc", None)
    msg_subj = getattr(msg, "subject", None)
    msg_date = to_iso(getattr(msg, "date", None))

    bodies = body_variants(msg)
    atts = gather_attachments(msg)

    out = {
        "meta": {
            "source": "msg",
            "has_html": bool(bodies.get("body_html")),
            "attachment_count": len(atts)
        },
        "message": {
            "from": msg_sender,
            "to": msg_to,
            "cc": msg_cc,
            "subject": msg_subj,
            "date": msg_date,
            "body_html": bodies.get("body_html"),
            "body_text": bodies.get("body_text"),
            "attachments": atts
        }
    }
    print(json.dumps(out))
    msg.close()

if __name__ == "__main__":
    main()
