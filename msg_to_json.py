#!/usr/bin/env /opt/pyenv/bin/python
import base64, json, sys, tempfile, os
import extract_msg

def to_str(v):
    if v is None:
        return ""
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8", errors="replace")
        except:
            return v.decode("latin1", errors="replace")
    return str(v)

def main():
    data = sys.stdin.read()
    j = json.loads(data)

    b64 = j.get("fileBase64") or j.get("content_base64") or ""
    raw = base64.b64decode(b64)
    # Write to temp file for extract_msg
    with tempfile.NamedTemporaryFile(delete=False, suffix=".msg") as f:
        f.write(raw)
        path = f.name

    try:
        msg = extract_msg.Message(path)
        msg_message = {
            "subject": to_str(getattr(msg, "subject", "")),
            "from": to_str(getattr(msg, "sender", "")) or to_str(getattr(msg, "from_", "")),
            "to": to_str(getattr(msg, "to", "")),
            "cc": to_str(getattr(msg, "cc", "")),
            "date": to_str(getattr(msg, "date", "")),
            "bodyText": to_str(getattr(msg, "body", "")),
            "attachments": []
        }

        # Collect only PDF attachments (as base64)
        atts = getattr(msg, "attachments", []) or []
        for a in atts:
            try:
                name = to_str(getattr(a, "longFilename", "")) or to_str(getattr(a, "shortFilename", "")) or "attachment"
                content = a.data
                if not content:
                    continue
                lname = name.lower()
                if lname.endswith(".pdf"):
                    msg_message["attachments"].append({
                        "filename": name,
                        "content_type": "application/pdf",
                        "base64": base64.b64encode(content).decode("ascii")
                    })
            except Exception as e:
                # skip broken attachment but keep going
                continue

        print(json.dumps({"ok": True, "message": msg_message}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
    finally:
        try:
            os.unlink(path)
        except:
            pass

if __name__ == "__main__":
    main()
