#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Convert a .msg (Outlook) file to a simple JSON payload for the Node server.

Usage:
  python3 msg_to_json.py /path/to/email.msg

Output (stdout): JSON with top-level keys:
  - meta: info about source
  - message: normalized fields (from, to, cc, subject, date, body_text, body_html, attachments[])
"""

import sys
import os
import json
import base64
import mimetypes
from datetime import datetime, date
import extract_msg


def _first_attr(obj, names):
    """Return the first present attribute (or call result) from names list."""
    for n in names:
        if hasattr(obj, n):
            v = getattr(obj, n)
            try:
                # Some fields in older versions can be callables
                return v() if callable(v) else v
            except Exception:
                continue
    return None


def _as_iso8601(dt):
    if isinstance(dt, (datetime, date)):
        try:
            # Preserve timezone if present
            return dt.isoformat()
        except Exception:
            pass
    # Sometimes extract_msg returns strings already
    if isinstance(dt, str):
        return dt
    return None


def _ensure_str(x):
    if x is None:
        return None
    if isinstance(x, (bytes, bytearray)):
        try:
            return x.decode("utf-8", errors="replace")
        except Exception:
            return x.decode("latin-1", errors="replace")
    return str(x)


def _coerce_recipients(val):
    """
    extract_msg can return strings, lists, or custom types for recipients.
    Normalize to a readable comma-separated string.
    """
    if val is None:
        return None
    # If list-like, stringify each
    if isinstance(val, (list, tuple, set)):
        parts = []
        for item in val:
            parts.append(_ensure_str(item))
        # Filter empties
        parts = [p for p in parts if p]
        return ", ".join(parts) if parts else None
    # Fallback
    return _ensure_str(val)


def parse_msg(path):
    m = extract_msg.Message(path)

    subject = _first_attr(m, ["subject", "Subject"])
    sent_on = _first_attr(m, ["date", "sentOn", "sent_on", "date_str"])
    sender  = _first_attr(m, ["sender", "Sender", "sender_email", "senderEmail", "from_"])
    to_val  = _first_attr(m, ["to", "To", "recipients"])
    cc_val  = _first_attr(m, ["cc", "CC", "carbon_copy", "carbonCopy"])

    # Bodies
    body_text = _first_attr(m, ["body", "Body", "plain_text", "plainText"])
    body_html = _first_attr(m, ["htmlBody", "HTMLBody", "html_body", "HtmlBody"])

    body_text = _ensure_str(body_text) or ""
    body_html = _ensure_str(body_html) or None  # allow None if not present

    # Attachments
    atts = []
    try:
        for a in (m.attachments or []):
            # Best-effort fields (vary by version)
            fname = _first_attr(a, ["longFilename", "long_file_name", "longFilenameValue", "shortFilename", "filename"])
            cid   = _first_attr(a, ["cid", "ContentId", "contentId", "content_id"])
            inline = _first_attr(a, ["isInline", "is_inline", "IsInline"])

            # Data
            data = None
            # Some versions expose .data, some .data_binary, some require a method
            data = _first_attr(a, ["data", "data_binary", "binaryData"])
            if data is None and hasattr(a, "data"):
                data = a.data  # last resort

            if isinstance(data, str):
                data = data.encode("utf-8", errors="replace")

            b64 = base64.b64encode(data).decode("ascii") if data else None

            # Guess content-type from name
            ctype, _ = mimetypes.guess_type(fname or "")
            atts.append({
                "filename": fname or "attachment",
                "contentId": cid or None,
                "inline": bool(inline) if inline is not None else False,
                "contentType": ctype or "application/octet-stream",
                "size": len(data) if data else 0,
                "dataBase64": b64
            })
    except Exception:
        # Don't fail parsing just because an attachment is odd
        pass

    out = {
        "meta": {
            "source": "msg",
            "has_html": bool(body_html),
            "attachment_count": len(atts)
        },
        "message": {
            "from":   _ensure_str(sender),
            "to":     _coerce_recipients(to_val),
            "cc":     _coerce_recipients(cc_val),
            "subject": _ensure_str(subject),
            "date":   _as_iso8601(sent_on),
            "body_text": body_text,
            "body_html": body_html,
            "text_length": len(body_text or ""),
            "html_length": len(body_html or "") if body_html else 0,
            "attachments": atts
        }
    }
    return out


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: msg_to_json.py /path/to/file.msg"}))
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.isfile(path):
        print(json.dumps({"ok": False, "error": f"File not found: {path}"}))
        sys.exit(1)

    # Only .msg is handled here (Node handles .eml). Guard accordingly.
    _, ext = os.path.splitext(path)
    if ext.lower() != ".msg":
        print(json.dumps({"ok": False, "error": f"Unsupported extension for this parser: {ext}"}))
        sys.exit(1)

    try:
        payload = parse_msg(path)
        payload["ok"] = True
        print(json.dumps(payload, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
