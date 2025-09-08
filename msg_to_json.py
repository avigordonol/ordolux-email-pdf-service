#!/usr/bin/env python3
# Reads a .msg and emits JSON with:
# - headers (subject/from/to/cc/date)
# - html_marked (IMG tags -> [[IMG:<cid>]] tokens)
# - inline (list of inline images with cid/filename/mime/dataBase64)
# - attachments (non-inline)
import sys, json, base64, re, mimetypes
from datetime import datetime

def b64(data: bytes) -> str:
    return base64.b64encode(data).decode('ascii')

def iso(dt):
    if isinstance(dt, datetime):
        try:
            return dt.isoformat()
        except Exception:
            return str(dt)
    return dt

def norm_cid(s: str) -> str:
    if not s: return ""
    s = s.strip().strip("<>").strip().lower()
    if s.startswith("cid:"): s = s[4:]
    # strip any fragment or query
    s = re.split(r"[?#]", s, 1)[0]
    return s

def html_replace_imgs(html: str, used_cids: list) -> str:
    if not html:
        return ""
    # Replace <img src="cid:..."> with [[IMG:cid]]
    def repl(m):
        cid = norm_cid(m.group(1))
        used_cids.append(cid)
        return f"[[IMG:{cid}]]"
    pattern = re.compile(r'<img\b[^>]*src=[\'"]cid:([^\'">]+)[\'"][^>]*>', re.IGNORECASE)
    html2 = pattern.sub(repl, html)
    return html2

def load_msg(path: str):
    import extract_msg
    from compressed_rtf import rtf_to_text

    msg = extract_msg.Message(path)
    msg_message_date = getattr(msg, "date", None) or getattr(msg, "sentOn", None)

    subject = getattr(msg, "subject", "") or ""
    from_   = getattr(msg, "sender", "") or ""
    to      = getattr(msg, "to", "") or ""
    cc      = getattr(msg, "cc", "") or ""

    html = getattr(msg, "htmlBody", None)
    if not html:
        # fall back to RTF -> text -> very simple HTML
        rtf = getattr(msg, "rtfBody", None)
        if rtf:
            try:
                text = rtf_to_text(rtf)
            except Exception:
                text = getattr(msg, "body", "") or ""
        else:
            text = getattr(msg, "body", "") or ""
        html = "<div>" + (text or "").replace("\r\n", "\n").replace("\n", "<br>") + "</div>"

    used_cids = []
    html_marked = html_replace_imgs(html, used_cids)

    # Collect attachments
    inline = []
    attachments = []
    for att in getattr(msg, "attachments", []) or []:
        # filename
        fn = getattr(att, "longFilename", None) or getattr(att, "shortFilename", None) or "attachment"
        # bytes
        data = getattr(att, "data", None)
        if not data:
            try:
                data = att.data
            except Exception:
                data = None
        if not data:
            continue
        # mime
        mime = getattr(att, "mimetype", None) or mimetypes.guess_type(fn)[0] or "application/octet-stream"
        # possible content-id
        cid = None
        for name in ("contentId", "content_id", "cid", "attachContentId", "pidTagAttachContentId"):
            if hasattr(att, name):
                cid = getattr(att, name)
                break
        # Some libs store it in props dict – best-effort scan
        if not cid and hasattr(att, "props"):
            props = getattr(att, "props") or {}
            for k, v in props.items():
                if isinstance(v, str) and "@" in v and len(v) < 200:
                    # heuristic
                    cid = v
                    break
        cid_norm = norm_cid(cid or "")
        record = {
            "filename": fn,
            "contentType": mime,
            "dataBase64": b64(data)
        }
        if cid_norm:
            record["cid"] = cid_norm

        # If it’s referenced in HTML by CID -> inline
        if cid_norm and cid_norm in used_cids:
            inline.append(record)
        else:
            attachments.append(record)

    out = {
        "subject": subject,
        "from": from_,
        "to": to,
        "cc": cc,
        "date": iso(msg_message_date),
        "html_marked": html_marked,
        "inline": inline,
        "attachments": attachments
    }
    print(json.dumps(out))
    return 0

def main():
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "Usage: msg_to_json.py <path>"}))
        return 1
    path = sys.argv[1]
    try:
        return load_msg(path)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 2

if __name__ == "__main__":
    sys.exit(main())
