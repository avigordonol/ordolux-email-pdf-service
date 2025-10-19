// server.cjs
"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const puppeteer = require("puppeteer-core");

const app = express();
app.use(bodyParser.json({ limit: "25mb" }));

// --- config / auth --------------------------------------------------------

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

// --- small helpers --------------------------------------------------------

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr && String(stderr)) || err.message));
      resolve({ stdout, stderr });
    });
  });
}

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
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripAngle(s = "") {
  return String(s).replace(/^<|>$/g, "");
}

function detectChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  throw new Error("Chromium not found. Ensure 'chromium' is installed and set CHROMIUM_PATH if needed.");
}

/**
 * Trim email HTML:
 * - remove leading empty blocks / &nbsp; spacers / long <br> runs
 * (do not strip tiny images; some signatures legitimately use tiny logos)
 */
function normalizeEmailHtml(s) {
  if (!s) return "";
  // Trim leading blank blocks (nbsp paragraphs, empty divs, many <br/>)
  s = s.replace(
    /^(?:\s|<br\s*\/?>|<p>\s*(?:&nbsp;|\u00a0)?\s*<\/p>|<div>\s*(?:&nbsp;|\u00a0)?\s*<\/div>)+/i,
    ""
  );
  // Collapse long runs of <br>
  s = s.replace(/(?:<br\s*\/?>\s*){3,}/gi, "<br><br>");
  return s;
}

// --- HTML builder from parsed email JSON ---------------------------------

function buildHtmlFromParsed(parsed) {
  const subject = parsed.subject || "(no subject)";
  const from = parsed.from || parsed.headers?.from || "";
  const to = parsed.to || parsed.headers?.to || "";
  const date = parsed.date || parsed.headers?.date || "";

  // Prefer provided HTML; fallback to text
  let bodyHtml = parsed.html || parsed.bodyHtml || null;
  if (!bodyHtml) {
    const t = parsed.text || parsed.textPreview || "";
    bodyHtml = `<pre style="white-space:pre-wrap">${escapeHtml(t)}</pre>`;
  }

  // Map inline attachments by CID → data: URL (tolerate many header variants)
  const cidMap = new Map();
  const norm = (v) => String(v || "").toLowerCase().replace(/[<>\s]/g, "");
  (parsed.attachments || []).forEach((a) => {
    const b64 =
      a.dataBase64 || a.base64 || a.data || a.contentBase64 || a.content;
    const mime =
      a.contentType || a.mime || a.mimetype || "application/octet-stream";

    const candidates = [
      a.cid,
      a.contentId,
      a.contentID,
      a["content-id"],
      a.headers?.["content-id"],
      a.headers?.["Content-ID"],
    ].filter(Boolean);

    for (const c of candidates) {
      const key = norm(c);
      if (key && b64) {
        cidMap.set(key, `data:${mime};base64,${b64}`);
      }
    }
  });

  // Replace cid: links in HTML (normalize both sides before compare)
  bodyHtml = bodyHtml.replace(/cid:<?([^">\s]+)>?/gi, (m, raw) => {
    const hit = cidMap.get(norm(raw));
    return hit || m; // leave untouched if we can't resolve
  });

  // Normalize top whitespace/spacers to avoid giant top gap
  bodyHtml = normalizeEmailHtml(bodyHtml);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
  <style>
    @page { size: A4; margin: 10mm 12mm 12mm 12mm; }  /* tighter top margin */
    html, body { margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; }
    .wrapper { padding: 14mm 12mm; }
    h1 { font-size: 20px; margin: 0 0 8px 0; }
    .meta { color:#555; margin-bottom:12px; font-size: 12px; }
    hr { border:0; border-top:1px solid #ddd; margin:16px 0; }
    img { max-width: 100%; height: auto; }
    img[width][height]{ height:auto !important; }   /* avoid stretched images */
    table { border-collapse: collapse; }
    th, td { padding: 6px 8px; }
    p:empty { display:none; }                        /* hide empty paras */
    a[href^="https://eur01.safelinks.protection.outlook.com"] { word-break: break-all; }
  </style>
</head>
<body>
  <div class="wrapper">
    <h1>${escapeHtml(subject)}</h1>
    <div class="meta">${escapeHtml(from)} → ${escapeHtml(to)} — ${escapeHtml(date)}</div>
    <hr/>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// --- HTML → PDF via Puppeteer (loads remote images, no headers) ----------

async function htmlToPdf(html) {
  const CHROME = detectChromium();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" }); // let remote images load
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: "10mm", bottom: "12mm", left: "12mm", right: "12mm" }
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

// --- Python-backed parsers ------------------------------------------------

// Convert .msg (stdin) → .eml bytes (stdout) via extract-msg
async function msgToEmlBytes(msgBuffer) {
  const script = process.env.MSG_TO_EML_SCRIPT ||
    path.join(__dirname, "py", "msg_to_eml.py");
  return await runPythonStdIn(script, msgBuffer);
}

// Parse .eml (stdin) → JSON { subject, from, to, date, html?, text?, attachments[] }
async function parseEmlToJson(emlBuffer) {
  const script = process.env.PARSE_EML_SCRIPT ||
    path.join(__dirname, "py", "parse_eml_minimal.py");
  const out = await runPythonStdIn(script, emlBuffer);
  const parsed = JSON.parse(out.toString("utf8"));
  parsed.attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  return parsed;
}

// --- routes ---------------------------------------------------------------

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

    // 1) Normalize to EML
    let emlBytes = raw;
    if (filename.toLowerCase().endsWith(".msg")) {
      try {
        emlBytes = await msgToEmlBytes(raw);
      } catch (e) {
        return res.status(422).json({ ok: false, error: "msg-to-eml-failed", detail: String(e) });
      }
    }

    // 2) Parse EML → JSON (for HTML composition and cid resolution)
    const parsed = await parseEmlToJson(emlBytes);

    // Debug: return parsed JSON instead of PDF (helpful during setup)
    if (String(req.query.debug || "") === "1") {
      return res.json({ ok: true, ...parsed });
    }

    // 3) Build HTML and 4) print to PDF
    const html = buildHtmlFromParsed(parsed);
    const pdf = await htmlToPdf(html);

    res.setHeader("content-type", "application/pdf");
    return res.status(200).send(pdf);

  } catch (e) {
    console.error("convert:error", e);
    return res.status(422).json({ ok: false, error: "convert-failed", detail: String(e?.message || e) });
  }
});

// --- start ---------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on ${PORT}`);
});
