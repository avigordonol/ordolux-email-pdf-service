# py/msg_to_eml.py
import sys, tempfile, re
import email
from email.message import EmailMessage

import extract_msg
try:
    from compressed_rtf.rtfde import decompress as rtf_decompress
except Exception:
    rtf_decompress = None

def _as_list(v):
    if v is None: return []
    if isinstance(v, (list, tuple)): return [str(x) for x in v]
    return [str(v)]

def _set_addrs(msg: EmailMessage, key: str, value):
    vals = _as_list(value)
    if vals:
        msg[key] = ", ".join(vals)

def _safe_str(val):
    if val is None: return ""
    if isinstance(val, bytes):
        for enc in ("utf-8", "utf-16", "latin-1"):
            try: return val.decode(enc, errors="replace")
            except Exception: pass
        return val.decode("latin-1", errors="replace")
    return str(val)

def _try_attrs(obj, names):
    for n in names:
        try:
            v = getattr(obj, n)
            if callable(v): v = v()
            if v: return v
        except Exception:
            continue
    return None

def _rtf_to_text(rtf_bytes):
    if not rtf_bytes: return ""
    try:
        data = rtf_bytes
        if rtf_decompress:
            try: data = rtf_decompress(rtf_bytes)
            except Exception: pass
        s = _safe_str(data)
        s = re.sub(r"{\\\*?[^{}]*}|\\'[0-9a-fA-F]{2}|\\[a-zA-Z]+-?\d* ?|[{}]", "", s)
        s = s.replace("\r\n", "\n").replace("\\par", "\n")
        return s.strip()
    except Exception:
        return ""

def _manual_build_eml(m) -> EmailMessage:
    em = EmailMessage()
    try: em['Subject'] = _safe_str(getattr(m, 'subject', None))
    except: pass
    try: _set_addrs(em, 'From', getattr(m, 'sender', None))
    except: pass
    try: _set_addrs(em, 'To', getattr(m, 'to', None))
    except: pass
    try: _set_addrs(em, 'Cc', getattr(m, 'cc', None))
    except: pass
    try:
        dt = getattr(m, 'date', None) or getattr(m, 'date_str', None)
        if dt: em['Date'] = _safe_str(dt)
    except: pass

    html = _try_attrs(m, ('htmlBody', 'html', 'bodyHTML', 'bodyHtml'))
    html = _safe_str(html) if html else None

    text = None
    if not html:
        text = _try_attrs(m, ('plainText', 'body', 'text', 'body_text'))
        text = _safe_str(text) if text else None

    if not html and not text:
        rtf = _try_attrs(m, ('rtfBody', 'bodyRTF', 'rtf'))
        if isinstance(rtf, str):
            rtf = rtf.encode('latin-1', errors='replace')
        text = _rtf_to_text(rtf)

    em.set_content(_safe_str(text) if text else "")
    if html:
        em.add_alternative(html, subtype="html")

    try:
        atts = getattr(m, 'attachments', []) or []
        for a in atts:
            data = _try_attrs(a, ('data', 'data_raw', 'payload', 'getData'))
            if not data:
                try:
                    with tempfile.NamedTemporaryFile(delete=True) as tf:
                        a.save(customPath=tf.name)
                        tf.flush()
                        data = tf.read()
                except Exception:
                    data = None
            if not data: continue

            fn = _try_attrs(a, ('longFilename', 'shortFilename', 'filename', 'name'))
            ctype = _try_attrs(a, ('mimetype', 'mime')) or "application/octet-stream"
            maintype, _, subtype = ctype.partition("/")
            if not subtype: maintype, subtype = "application", "octet-stream"

            cid = _try_attrs(a, ('cid', 'contentId', 'contentID', 'content_id'))
            if cid:
                em.add_attachment(data, maintype=maintype, subtype=subtype, filename=_safe_str(fn), cid=str(cid))
            else:
                em.add_attachment(data, maintype=maintype, subtype=subtype, filename=_safe_str(fn))
    except Exception:
        pass

    return em

def main():
    raw = sys.stdin.buffer.read()
    with tempfile.NamedTemporaryFile(suffix=".msg", delete=True) as f:
        f.write(raw); f.flush()
        m = extract_msg.Message(f.name)

        # Try library helpers first (API differs by version)
        for attr in ("get_email_message", "as_email_message", "get_message"):
            try:
                api = getattr(m, attr, None)
                if callable(api):
                    em = api()
                    sys.stdout.buffer.write(em.as_bytes(policy=email.policy.default))
                    return
            except Exception:
                continue

        # Fallback manual build (robust)
        em = _manual_build_eml(m)
        sys.stdout.buffer.write(em.as_bytes(policy=email.policy.default))

if __name__ == "__main__":
    main()
