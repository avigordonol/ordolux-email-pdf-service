// server.cjs
"use strict";

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

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

  // Map inline attachments by CID → data: URL
  const cidMap = new Map();
  (parsed.attachments || []).forEach(a => {
    const cid = stripAngle(a.contentId || a.cid || a.contentID || "");
    const mime = a.contentType || a.mime || "application/octet-stream";
    const b64 = a.dataBase64 || a.base64 || a.data;
    if (cid && b64) cidMap.set(cid, `data:${mime};base64,${b64}`);
  });

  // Replace cid: links in HTML
  bodyHtml = bodyHtml.replace(/cid:<?([^">\s]+)>?/g, (m, cid) => {
    return cidMap.get(cid) || m;
  });

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; padding: 24px; color: #111; }
    h1 { font-size: 20px; margin: 0 0 8px 0; }
    .meta { color:#555; margin-bottom:12px; font-size: 12px; }
    hr { border:0; border-top:1px solid #ddd; margin:16px 0; }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; }
    table, th, td { border: 1px solid #ddd; }
    th, td { padding: 6px 8px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(subject)}</h1>
  <div class="meta">${escapeHtml(from)} → ${escapeHtml(to)} — ${escapeHtml(date)}</div>
  <hr/>
  ${bodyHtml}
</body>
</html>`;
}

// --- HTML → PDF via system Chromium --------------------------------------

async function htmlToPdf(html) {
  const tmpDir = os.tmpdir();
  const inPath = path.join(tmpDir, `email-${Date.now()}.html`);
  const outPath = path.join(tmpDir, `email-${Date.now()}.pdf`);
  fs.writeFileSync(inPath, html);

  const CHROME = detectChromium();
  const args = [
    "--headless=new",            // fallback will be handled below if not supported
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--print-to-pdf=${outPath}`,
    `file://${inPath}`
  ];

  try {
    await execFileP(CHROME, args);
  } catch (e) {
    // Older Chromium may not support --headless=new → try legacy flag
    const legacyArgs = args.map(a => (a === "--headless=new" ? "--headless" : a));
    await execFileP(CHROME, legacyArgs);
  }

  const pdf = fs.readFileSync(outPath);
  fs.unlink(inPath, () => {});
  fs.unlink(outPath, () => {});
  return pdf;
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
  // normalize attachments array
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
