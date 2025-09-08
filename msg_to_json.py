#!/usr/bin/env python3
import sys, json, base64, re, datetime, os
from pathlib import Path

try:
    import extract_msg
except Exception as e:
    print(json.dumps({"error": f"import extract_msg failed: {e}"}))
    sys.exit(1)

IMG_MARKER = "<!--IMG-MARKER-->"

def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")

def _mime_from_name(name: str) -> str:
    ext = (Path(name).suffix or "").lower().lstrip(".")
    return {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "bmp": "image/bmp",
        "tif": "image/tiff",
        "tiff": "image/tiff",
        "svg": "image/svg+xml",
        "emf": "image/emf",
        "wmf": "image/wmf",
        "ico": "image/x-icon",
        "pdf": "application/pdf",
    }.get(ext, "application/octet-stream")

def _cid_from_attachment(att) -> str:
    for k in ("cid", "contentId", "content_id"):
        if hasattr(att, k):
            v = getattr(att, k)
            if v:
                return v.strip("<>")
    return None

def default_json(obj):
    if isinstance(obj,
