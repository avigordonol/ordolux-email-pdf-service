#!/usr/bin/env python3
import sys, json, base64, mimetypes, datetime
from bs4 import BeautifulSoup
import extract_msg
from striprtf.striprtf import rtf_to_text

def to_iso(dt):
    if isinstance(dt, datetime.datetime):
        try: return dt.isoformat()
        except Exception: return str(dt)
    return str(dt) if dt is not None else None

def safe_text_from_html(html):
    try:
        soup = BeautifulSoup(html, "html.parser")
        for br in soup.find_all(["br","p","div","li"]):
            br.insert_after("\n")
        txt = soup.get_text()
        return "\n".join([line.strip() for line in txt.splitlines() if line.strip() != ""])
    except Exception:
        return None

def body_variants(msg):
    html = getattr(msg, "htmlBody", None)
    text = getattr(msg, "body", None)
    if html and isinstance(html, (str, bytes)):
        if isinstance(html, bytes):
            try: html = html.decode("utf-8","ignore")
            except Exception: html = html.decode("latin-1","ignore")
        text_from_html = safe_text_from_html(html)
        return {"body_html": html, "body_text": text_from_html or text or ""}
    rtf = getattr(msg, "rtfBody", None)
    if rtf and isinstance(rtf, (bytes, bytearray)):
        try:
            rtf_str = rtf.decode("latin-1","ignore")
            text_from_rtf = rtf_to_text(rtf_str)
            return {"body_html": None, "body_text": text_from_rtf}
        except Exception:
            pass
    return {"body_html": None, "body_text": text or ""}

def _clean(s):
    if s is None: return None
    return str(s).replace("\t"," ").replace("\r"," ").replace("\n"," ").strip()

def gather_attachments(msg):
    atts = []
    try:
        for a in msg.attachments:
            name = getattr(a,"longFilename",None) or getattr(a,"shortFilename",None) or "attachment"
            data = getattr(a,"data",None)
            cid  = getattr(a,"cid",None) or getattr(a,"contentId",None) or getattr(a,"content_id",None)
            mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
            entry = {"filename": name, "content_type": mime, "content_id": cid, "is_inline": bool(cid)}
            if data and mime.startswith("image/") and entry["is_inline"]:
                entry["data_base64"] = base64.b64encode(data).decode("ascii")
            atts.append(entry)
    except Exception:
        pass
    return atts

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error":"usage: msg_to_json.py <path>"})); return
    path = sys.argv[1]
    msg = extract_msg.Message(path)
    bodies = body_variants(msg)
    out = {
        "meta": {
            "source":"msg",
            "has_html": bool(bodies.get("body_html")),
            "attachment_count": len(getattr(msg,"attachments",[]))
        },
        "message": {
            "from": _clean(getattr(msg,"sender",None) or getattr(msg,"senderName",None)),
            "to": _clean(getattr(msg,"to",None)),
            "cc": _clean(getattr(msg,"cc",None)),
            "subject": _clean(getattr(msg,"subject",None)),
            "date": to_iso(getattr(msg,"date",None)),
            "body_html": bodies.get("body_html"),
            "body_text": bodies.get("body_text"),
            "attachments": gather_attachments(msg)
        }
    }
    print(json.dumps(out))
    msg.close()

if __name__ == "__main__":
    main()
