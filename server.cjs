const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const app = express();
app.use(bodyParser.json({ limit: "20mb" }));

const SECRET =
  process.env.ORDOLUX_CONVERTER_SECRET ||
  process.env.CONVERTER_SECRET ||
  process.env.SHARED_SECRET;

// --- utilities ------------------------------------------------------------

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

// Run a python script, feed stdin (Buffer), capture stdout (Buffer)
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

function stripAngle(s = "") {
  return String(s).replace(/^<|>$/g, "");
}

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Build HTML from the parsed email JSON your service already produces
function buildHtmlFromParsed(parsed) {
  const subject = parsed.subject || "(no subject)";
  const from = parsed.from || parsed.headers?.from || "";
  const to = parsed.to || parsed.headers?.to || "";
  const date = parsed.date || parsed.headers?.date || "";

  // Prefer HTML body; fall back to text
  let bodyHtml = parsed.html || parsed.bodyHtml || null;
  if (!bodyHtml) {
    const t = parsed.text || parsed.textPreview || "";
    bodyHtml = `<pre style="white-space:pre-wrap">${escapeHtml(t)}</pre>`;
  }

  // Map inline attachments by Content-ID → data: URL
  const cidMap = new Map();
  (parsed.attachments || []).forEach(a => {
    const cid = a.contentId || a.cid || a.contentID;
    const mime = a.contentType || a.mime || "application/octet-stream";
    const b64 = a.dataBase64 || a.base64 || a.data;
    if (cid && b64) cidMap.set(stripAngle(cid), `data:${mime};base64,${b64}`);
  });

  // Replace cid: refs
  bodyHtml = bodyHtml.replace(/cid:<?([^">]+)>?/g, (m, cid) => {
    const repl = cidMap.get(cid);
    return repl || m;
    });

  // Simple, readable layout
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; padding: 24px; }
    h1 { font-size: 20px; margin: 0 0 8px 0; }
    .meta { color:#666; margin-bottom:12px; font-size: 12px; }
    hr { border:0; border-top:1px solid #ddd; margin:16px 0; }
    img { max-width: 100%; height: auto; }
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

// Use system Chromium to print HTML → PDF (keeps image support excellent)
async function htmlToPdf(html) {
  const tmpIn = path.join(os.tmpdir(), `email-${Date.now()}.html`);
  const tmpOut = path.join(os.tmpdir(), `email-${Date.now()}.pdf`);
  fs.writeFileSync(tmpIn, html);

  // Railway (Debian) typically installs Chromium to /usr/bin/chromium
  const CHROME = process.env.CHROMIUM_PATH || "/usr/bin/chromium";

  const args = [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--print-to-pdf=${tmpOut}`,
    `file://${tmpIn}`
  ];

  await execFileP(CHROME, args);
  const pdf = fs.readFileSync(tmpOut);
  fs.unlink(tmpIn, () => {});
  fs.unlink(tmpOut, () => {});
  return pdf;
}

// --- routes ---------------------------------------------------------------

app.get("/healthz", (req, res) => {
  if (req.get("X-Ordolux-Secret") !== SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return res.json({ ok: true });
});

// IMPORTANT: This route now returns application/pdf
app.post("/convert", async (req, res) => {
  try {
    if (req.get("X-Ordolux-Secret") !== SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { fileBase64, filename } = req.body || {};
    if (!fileBase64 || !filename) {
      return res.status(422).json({ ok: false, error: "fileBase64 and filename required" });
    }

    const raw = Buffer.from(fileBase64, "base64");
    let emlBytes = raw;

    // If it's MSG, convert to EML first (stdin → stdout)
    if (filename.toLowerCase().endsWith(".msg")) {
      try {
        const script = path.join(__dirname, "py", "parse_msg.py");
        emlBytes = await runPythonStdIn(script, raw);
      } catch (e) {
        return res.status(422).json({ ok: false, error: "msg-to-eml-failed", detail: String(e) });
      }
    }

    // ---- YOUR EXISTING PARSE STEP HERE ----
    // If you already have a parse function that produced the JSON you saw in logs, call it:
    // const parsed = await parseEmlToJson(emlBytes);
    // For now, we implement a minimal robust parse via Python 'email' if you don't have one:
    const parsed = await minimalParseEml(emlBytes);

    // Debug switch to see parsed JSON (optional)
    if (String(req.query.debug || "") === "1") {
      return res.json({ ok: true, ...parsed });
    }

    const html = buildHtmlFromParsed(parsed);
    const pdf = await htmlToPdf(html);

    res.setHeader("content-type", "application/pdf");
    return res.status(200).send(pdf);

  } catch (e) {
    return res.status(422).json({ ok: false, error: "convert-failed", detail: String(e) });
  }
});

// Minimal EML parser using Python stdlib (fallback if you don't have a JS parser)
async function minimalParseEml(bytes) {
  const script = path.join(__dirname, "py", "parse_eml_minimal.py");
  const out = await runPythonStdIn(script, bytes);
  // script prints JSON; parse it
  return JSON.parse(out.toString("utf8"));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
