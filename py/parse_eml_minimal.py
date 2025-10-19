# py/parse_eml_minimal.py
import sys, json, email
from email import policy

def main():
    b = sys.stdin.buffer.read()
    msg = email.message_from_bytes(b, policy=policy.default)
    out = {
        "subject": msg.get("subject"),
        "from": msg.get("from"),
        "to": msg.get("to"),
        "date": msg.get("date"),
        "html": None,
        "text": None,
        "attachments": []
    }

    # Walk parts
    for part in msg.walk():
        ctype = part.get_content_type() or ""
        disp = (part.get_content_disposition() or "")
        cid = part.get("Content-ID")
        if ctype == "text/html" and out["html"] is None:
            out["html"] = part.get_content()
        elif ctype.startswith("text/") and out["text"] is None:
            out["text"] = part.get_content()
        elif disp == "attachment" or cid:
            # Inline or attached
            payload = part.get_payload(decode=True) or b""
            out["attachments"].append({
                "filename": part.get_filename(),
                "contentType": ctype,
                "contentId": cid,
                "dataBase64": (payload.decode("latin1").encode("latin1").hex() and None) # placeholder
            })
            # Real base64 (avoid latin1 hack above)
            import base64
            out["attachments"][-1]["dataBase64"] = base64.b64encode(payload).decode("ascii")

    # textPreview for convenience
    if out["text"] and not out.get("textPreview"):
        out["textPreview"] = out["text"][:200]
    print(json.dumps(out))

if __name__ == "__main__":
    main()
