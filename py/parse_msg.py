#!/usr/bin/env python3
import sys, json, base64, tempfile, os

def main():
    try:
        data = json.load(sys.stdin)
        fb64 = data.get("fileBase64") or ""
        raw = base64.b64decode(fb64)

        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "in.msg")
            with open(p, "wb") as f:
                f.write(raw)

            import extract_msg
            m = extract_msg.Message(p)

            subj = m.subject or ""
            body = (m.body or "").strip()
            dt   = m.date or ""
            frm  = m.sender or ""
            to   = ", ".join(m.to or [])
            cc   = ", ".join(m.cc or [])

            atts = []
            for a in m.attachments:
                name = getattr(a, 'longFilename', None) or getattr(a, 'shortFilename', None) or getattr(a, 'filename', None) or "attachment"
                data_bytes = a.data
                if not data_bytes:
                    continue
                # Only pass back PDFs for merging
                is_pdf = name.lower().endswith(".pdf") or (data_bytes[:4] == b'%PDF')
                if is_pdf:
                    atts.append({
                        "filename": name,
                        "contentType": "application/pdf",
                        "dataBase64": base64.b64encode(data_bytes).decode("ascii")
                    })

            out = {
                "ok": True,
                "subject": subj,
                "from": frm,
                "to": to,
                "cc": cc,
                "date": dt,
                "bodyText": body,
                "attachments": atts
            }
            print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    main()
