// server.cjs
"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");

const app = express();
app.use(bodyParser.json({ limit: "25mb" }));

// -------------------- auth --------------------
const SECRET =
  process.env.ORDOLUX_CONVERTER_SECRET ||
  process.env.CONVERTER_SECRET ||
  process.env.SHARED_SECRET ||
  "";

function requireAuth(req, res) {
  if (!SECRET || req.get("X-Ordolux-Secret") !== SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// -------------------- helpers --------------------
function runPythonStdIn(scriptPath, stdinBuffer) {
  return new Promise((resolve, reject) => {
    const py = spawn(process.env.PYTHON || "python3", [scriptPath]);
    const chunks = [];
    const errs = [];
    py.stdout.on("data", d => chunks.push(d));
    py.stderr.on("data", d => errs.push(d));
    py.on("close", code => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error(Buffer.concat(errs).toString() || `python exited ${code}`));
    });
    py.stdin.write(stdinBuffer);
    py.stdin.end();
  });
}

function escapeHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function stripAngle(s = "") {
  return String(s).replace(/^<|>$/g, "");
}
function detectChromium() {
  const cands = [
    process.env.CHROMIUM_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  throw new Error("Chromium not found. Install chromium and/or set CHROMIUM_PATH.");
}

// Trim obvious leading blanks in raw HTML string
function normalizeEmailHtml(s) {
  if (!s) return "";
  s = s.replace(
    /^(?:\s|<br\s*\/?>|<p>\s*(?:&nbsp;|\u00a0)?\s*<\/p>|<div>\s*(?:&nbsp;|\u00a0)?\s*<\/div>)+/i,
    ""
  );
  s = s.replace(/(?:<br\s*\/?>\s*){3,}/gi, "<br><br>");
  return s;
}

// -------------------- HTML builder --------------------
function buildHtmlFromParsed(parsed) {
  const subject = parsed.subject || "(no subject)";
  const from = parsed.from || parsed.headers?.from || "";
  const to = parsed.to || parsed.headers?.to || "";
  const date = parsed.date || parsed.headers?.date || "";

  let bodyHtml = parsed.html || parsed.bodyHtml || null;
  if (!bodyHtml) {
    const t = parsed.text || parsed.textPreview || "";
    bodyHtml = `<pre style="white-space:pre-wrap">${escapeHtml(t)}</pre>`;
  }

  // Map CID → data URL
  const cidMap = new Map();
  const norm = (v) => String(v || "").toLowerCase().replace(/[<>\s]/g, "");
  (parsed.attachments || []).forEach((a) => {
    const b64 = a.dataBase64 || a.base64 || a.data || a.contentBase64 || a.content;
    const mime = a.contentType || a.mime || a.mimetype || "application/octet-stream";
    const candidates = [
      a.cid, a.contentId, a.contentID, a["content-id"], a.headers?.["content-id"], a.headers?.["Content-ID"],
    ].filter(Boolean);
    for (const c of candidates) {
      const key = norm(c);
      if (key && b64) cidMap.set(key, `data:${mime};base64,${b64}`);
    }
  });
  bodyHtml = bodyHtml.replace(/cid:<?([^">\s]+)>?/gi, (m, raw) => cidMap.get(norm(raw)) || m);

  bodyHtml = normalizeEmailHtml(bodyHtml);

  // Aggressive first-child margin reset + small top padding
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
  <style>
    @page { size: A4; margin: 8mm 12mm 12mm 12mm; }
    html, body { margin:0; padding:0; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:#111; }
    .wrapper { padding: 8mm 12mm 0 12mm; } /* very small top padding */
    /* Kill giant first-child spacing from Outlook/Word HTML */
    body > *:first-child,
    .wrapper > *:first-child,
    .WordSection1:first-child,
    #divtagdefaultwrapper:first-child {
      margin-top: 0 !important;
      padding-top: 0 !important;
    }
    /* Also clamp first 3 blocks' top margins to zero */
    .wrapper > *:nth-child(-n+3) { margin-top: 0 !important; }
    table { border-collapse: collapse; }
    table[role="presentation"] { border-collapse: collapse; }
    img { max-width:100%; height:auto; }
    img[width][height]{ height:auto !important; }
    p:empty { display:none; }
    a[href^="https://eur01.safelinks.protection.outlook.com"] { word-break: break-all; }
  </style>
</head>
<body>
  <div class="wrapper">
    <h1 style="margin:0 0 6px 0; font-size:18px;">${escapeHtml(subject)}</h1>
    <div class="meta" style="color:#555; margin-bottom:10px; font-size:12px;">
      ${escapeHtml(from)} → ${escapeHtml(to)} — ${escapeHtml(date)}
    </div>
    <hr style="border:0;border-top:1px solid #ddd;margin:12px 0;" />
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// -------------------- Puppeteer print with TOP-TRIM + broken-image handling --------------------
async function htmlToPdf(html) {
  const CHROME = detectChromium();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    // 1) Hide broken/blocked images; clamp absurdly tall placeholders
    await page.evaluate(() => {
      document.querySelectorAll("img").forEach(img => {
        if (!img.complete || img.naturalWidth === 0) {
          img.style.display = "none";
        }
        const h = parseFloat(getComputedStyle(img).height || "0");
        if (h > 500) {
          img.style.maxHeight = "300px";
          img.style.height = "auto";
        }
      });
    });

    // 2) Top-trim pass: remove/neutralise giant spacers at the very top
    await page.evaluate(() => {
      const isVisible = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height >= 0;
      };
      const isTrulyEmpty = (el) => {
        const hasText = (el.innerText || "").trim().length > 0;
        const hasMedia = !!el.querySelector("img, svg, canvas, video, iframe");
        return !hasText && !hasMedia;
      };
      const clampTopMargin = (el) => {
        const cs = getComputedStyle(el);
        const mt = parseFloat(cs.marginTop || "0");
        if (mt > 60) el.style.marginTop = "0px";
        const mh = parseFloat(cs.minHeight || "0");
        if (mh > 200) el.style.minHeight = "0";
        const lh = parseFloat(cs.lineHeight || "0");
        if (!el.innerText.trim() && lh > 40) el.style.lineHeight = "normal";
        const pt = parseFloat(cs.paddingTop || "0");
        if (pt > 60) el.style.paddingTop = "0px";
      };

      const cutLeadingEmpties = () => {
        let changed = false;
        while (document.body.firstElementChild) {
          const el = document.body.firstElementChild;
          if (!isVisible(el)) { el.remove(); changed = true; continue; }
          if (el.tagName.toLowerCase() === "br") { el.remove(); changed = true; continue; }
          const rect = el.getBoundingClientRect();
          const tall = rect.height > 240; // ≈ large header spacer
          if (["div","p","table","section"].includes(el.tagName.toLowerCase()) &&
              isTrulyEmpty(el) && (tall || rect.top < 5)) {
            el.remove(); changed = true; continue;
          }
          break; // first meaningful thing reached
        }
        return changed;
      };

      for (let i = 0; i < 4; i++) {
        const first = document.body.firstElementChild;
        if (!first) break;
        clampTopMargin(first);
        const changed = cutLeadingEmpties();
        if (!changed) break;
      }

      let seen = 0;
      for (const el of Array.from(document.body.children)) {
        if (!isVisible(el)) continue;
        clampTopMargin(el);
        seen += 1;
        if (seen >= 3) break;
      }
    });

    // 3) Print with tight top margin
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: "6mm", bottom: "12mm", left: "12mm", right: "12mm" },
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

// -------------------- Python parsers --------------------
async function msgToEmlBytes(msgBuffer) {
  const script = process.env.MSG_TO_EML_SCRIPT || path.join(__dirname, "py", "msg_to_eml.py");
  return await runPythonStdIn(script, msgBuffer);
}
async function parseEmlToJson(emlBuffer) {
  const script = process.env.PARSE_EML_SCRIPT || path.join(__dirname, "py", "parse_eml_minimal.py");
  const out = await runPythonStdIn(script, emlBuffer);
  const parsed = JSON.parse(out.toString("utf8"));
  parsed.attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  return parsed;
}

// -------------------- routes --------------------
app.get("/healthz", (req, res) => {
  if (!requireAuth(req, res)) return;
  res.json({ ok: true });
});

// POST /convert { fileBase64, filename }
app.post("/convert", async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const { fileBase64, filename } = req.body || {};
    if (!fileBase64 || !filename) {
      return res.status(422).json({ ok: false, error: "fileBase64 and filename required" });
    }

    const raw = Buffer.from(fileBase64, "base64");

    // 1) .msg → .eml if needed
    let emlBytes = raw;
    if (filename.toLowerCase().endsWith(".msg")) {
      try { emlBytes = await msgToEmlBytes(raw); }
      catch (e) { return res.status(422).json({ ok: false, error: "msg-to-eml-failed", detail: String(e) }); }
    }

    // 2) parse .eml to JSON
    const parsed = await parseEmlToJson(emlBytes);

    if (String(req.query.debug || "") === "1") {
      return res.json({ ok: true, ...parsed });
    }

    // 3) build HTML → 4) print
    const html = buildHtmlFromParsed(parsed);
    const pdf = await htmlToPdf(html);

    res.setHeader("content-type", "application/pdf");
    return res.status(200).send(pdf);

  } catch (e) {
    console.error("convert:error", e);
    return res.status(422).json({ ok: false, error: "convert-failed", detail: String(e?.message || e) });
  }
});

// -------------------- start --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
