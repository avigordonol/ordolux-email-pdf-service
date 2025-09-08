# OrdoLux: parse .msg and .eml -> compact JSON (no datetime objects)
import sys, os, json, base64, mimetypes
from email import policy
from email.parser import BytesParser

def b64(b): 
    return base64.b64encode(b or b'').decode('ascii')

def parse_eml(p):
    with open(p, 'rb') as f:
        m = BytesParser(policy=policy.default).parse(f)

    def hdr(name):
        v = m.get(name)
        return str(v) if v is not None else ''

    text = ''
    html = ''
    atts = []

    for part in m.walk():
        ctype = part.get_content_type()
        disp = part.get_content_disposition()
        if ctype == 'text/plain' and not text:
            try:
                text = part.get_content()
            except Exception:
                try:
                    text = (part.get_payload(decode=True) or b'').decode(part.get_content_charset() or 'utf-8','replace')
                except Exception:
                    text = ''
        elif ctype == 'text/html' and not html:
            try:
                html = part.get_content()
            except Exception:
                try:
                    html = (part.get_payload(decode=True) or b'').decode(part.get_content_charset() or 'utf-8','replace')
                except Exception:
                    html = ''
        elif disp in ('attachment','inline') or part.get_filename() or part.get('Content-ID'):
            data = part.get_payload(decode=True) or b''
            fname = part.get_filename() or ''
            cid = part.get('Content-ID') or ''
            atts.append({
                "filename": fname,
                "contentType": ctype,
                "isInline": (disp == 'inline' or bool(cid)),
                "cid": cid.strip('<>') if isinstance(cid, str) else '',
                "_content": b64(data)
            })

    return {
        "meta": { "source": "eml", "has_html": bool(html), "attachment_count": len(atts) },
        "message": {
            "from": hdr('From'), "to": hdr('To'), "cc": hdr('Cc') or '',
            "subject": hdr('Subject'), "date": hdr('Date') or '',
            "text": text, "html": html, "attachments": atts
        }
    }

def parse_msg(p):
    import extract_msg
    m = extract_msg.Message(p)

    # Basic fields
    from_ = getattr(m, 'sender', '') or ''
    to = getattr(m, 'to', '') or ''
    cc = getattr(m, 'cc', '') or ''
    subject = getattr(m, 'subject', '') or ''
    date = str(getattr(m, 'date', '') or '')

    text = getattr(m, 'body', '') or ''
    html = getattr(m, 'htmlBody', '') or ''

    atts = []
    for a in getattr(m, 'attachments', []):
        # filenames
        fname = getattr(a, 'longFilename', None) or getattr(a, 'shortFilename', None) \
                or getattr(a, 'filename', None) or ''
        data = getattr(a, 'data', b'') or b''

        ctype = None
        if fname:
            ctype = mimetypes.guess_type(fname)[0]
        if not ctype:
            if data.startswith(b'\x89PNG\r\n\x1a\n'):
                ctype = 'image/png'
            elif data[:2] == b'\xff\xd8':
                ctype = 'image/jpeg'
            else:
                ctype = 'application/octet-stream'

        cid = getattr(a, 'cid', '') or ''
        is_inline = False
        try:
            is_inline = bool(getattr(a, 'isInline', False))
        except Exception:
            pass

        atts.append({
            "filename": fname,
            "contentType": ctype,
            "isInline": (is_inline or (bool(cid))),
            "cid": cid.strip('<>') if isinstance(cid, str) else '',
            "_content": b64(data)
        })

    return {
        "meta": { "source": "msg", "has_html": bool(html), "attachment_count": len(atts) },
        "message": {
            "from": from_, "to": to, "cc": cc,
            "subject": subject, "date": date,
            "text": text, "html": html, "attachments": atts
        }
    }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({ "ok": False, "error": "path arg missing" }))
        return
    p = sys.argv[1]
    ext = os.path.splitext(p)[1].lower()
    try:
        out = parse_msg(p) if ext == '.msg' else parse_eml(p)
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({ "ok": False, "error": str(e) }))

if __name__ == "__main__":
    main()
