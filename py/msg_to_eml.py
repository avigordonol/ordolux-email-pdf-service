# py/msg_to_eml.py
import sys, tempfile, base64
import email
from email.message import EmailMessage

import extract_msg  # pinned in Dockerfile

def _as_list(v):
    if v is None: return []
    if isinstance(v, (list, tuple)): return [str(x) for x in v]
    return [str(v)]

def _set_addrs(msg: EmailMessage, key: str, value):
    vals = _as_list(value)
    if vals:
        msg[key] = ", ".join(vals)

def _manual_build_eml(m) -> EmailMessage:
    """Build a reasonable EML using fields exposed by extract_msg."""
    em = EmailMessage()
    try: em['Subject'] = m.subject or ""
    except: pass
    try: _set_addrs(em, 'From', getattr(m, 'sender', None))
    except: pass
    try: _set_addrs(em, 'To', getattr(m, 'to', None))
    except: pass
    try: _set_addrs(em, 'Cc', getattr(m, 'cc', None))
    except: pass
    try:
        dt = getattr(m, 'date', None) or getattr(m, 'date_str', None)
        if dt: em['Date'] = str(dt)
    except: pass

    # Bodies
    html = None
    text = None
    for attr in ('htmlBody', 'html', 'bodyHTML'):
        try:
            html = getattr(m, attr, None)
            if html: break
        except: pass
    for attr in ('plainText', 'body', 'text'):
        try:
            text = getattr(m, attr, None)
            if text: break
        except: pass

    if text:
        em.set_content(text)
    else:
        em.set_content("")

    if html:
        em.add_alternative(html, subtype="html")

    # Attachments (try to preserve inline CIDs)
    try:
        atts = getattr(m, 'attachments', []) or []
        for a in atts:
            data = None
            for cand in ('data', 'data_raw', 'payload'):
                try:
                    v = getattr(a, cand)
                    data = v() if callable(v) else v
                    if data: break
                except: pass
            if not data:
                try:
                    # Some versions only support save()
                    with tempfile.NamedTemporaryFile(delete=True) as tf:
                        a.save(customPath=tf.name)
                        tf.flush()
                        data = tf.read()
                except:
                    continue

            fn = None
            for cand in ('longFilename', 'shortFilename', 'filename', 'name'):
                try:
                    fn = getattr(a, cand, None)
                    if fn: break
                except: pass

            ctype = getattr(a, 'mimetype', None) or getattr(a, 'mime', None) or "application/octet-stream"
            maintype, _, subtype = ctype.partition("/")
            if not subtype: maintype, subtype = "application", "octet-stream"

            # Inline content-id if available
            cid = None
            for cand in ('cid', 'contentId', 'contentID', 'content_id'):
                try:
                    cid = getattr(a, cand, None)
                    if cid: break
                except: pass

            if cid:
                # EmailMessage.add_attachment supports cid= to set Content-ID
                em.add_attachment(data, maintype=maintype, subtype=subtype, filename=fn, cid=str(cid))
            else:
                em.add_attachment(data, maintype=maintype, subtype=subtype, filename=fn)
    except Exception:
        pass

    return em

def main():
    raw = sys.stdin.buffer.read()
    with tempfile.NamedTemporaryFile(suffix=".msg", delete=True) as f:
        f.write(raw); f.flush()
        m = extract_msg.Message(f.name)

        # Try known APIs first
        em = None
        for attr in ("get_email_message", "as_email_message", "get_message"):
            try:
                candidate = getattr(m, attr, None)
                if callable(candidate):
                    em = candidate()
                    break
            except Exception:
                pass

        if em is None:
            em = _manual_build_eml(m)

        # Output EML bytes
        sys.stdout.buffer.write(em.as_bytes(policy=email.policy.default))

if __name__ == "__main__":
    main()
