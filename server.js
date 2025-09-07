// OrdoLux Email→PDF microservice (EML + MSG via Python extract_msg)
// Auth: header X-Ordolux-Secret must equal process.env.SHARED_SECRET
// Endpoints:
//   GET  /healthz -> { ok: true }
//   GET  /diag    -> { ok:true, node, secretSet, python:"ok"|"missing" }
//   POST /convert { fileBase64, filename, options? } -> PDF (Accept: application/pdf) or JSON (Accept: application/json)

const express    = require('express');
const bodyParser = require('body-parser');
const fs         = require('fs');
const fsp        = fs.promises;
const os         = require('os');
const path       = require('path');
const { execFile } = require('child_process');
const { simpleParser } = require('mailparser');
const { htmlToText }  = require('html-to-text');
const PDFDocument     = require('pdfkit');

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || '';

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

function sendError(res, code, msg, details) {
  const asJson = (res.req.headers.accept || '').includes('application/json');
  const payload = { ok: false, error: msg };
  if (details) payload.details = details;
  if (asJson) return res.status(code).json(payload);
  return res.status(code).type('text/plain').send(JSON.stringify(payload));
}

app.get('/healthz', (req, res) => {
  if (!SHARED_SECRET) return res.status(500).json({ ok: false, error: 'Missing SHARED_SECRET' });
  res.json({ ok: true });
});

app.get('/diag', (req, res) => {
  const diag = { ok: true, node: process.version, secretSet: !!SHARED_SECRET, python: "missing" };
  execFile('python3', ['--version'], { timeout: 4000 }, (err) => {
    if (!err) diag.python = "ok";
    res.json(diag);
  });
});

app.post('/convert', async (req, res) => {
  // Auth
  const secret = req.header('X-Ordolux-Secret') || '';
  if (!SHARED_SECRET || secret !== SHARED_SECRET) {
    return sendError(res, 401, 'Unauthorized');
  }

  const accept = (req.headers.accept || '').toLowerCase();
  const wantsPdf  = accept.includes('application/pdf');
  const wantsJson = accept.includes('application/json');

  const { fileBase64, filename, fileUrl, options } = req.body || {};
  if (!fileBase64 && !fileUrl) return sendError(res, 400, 'Provide fileBase64 or fileUrl');
  if (!filename) return sendError(res, 400, 'Provide filename');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ordolux-'));
  const cleanup = async () => { try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {} };

  const logs = [];
  try {
    // Acquire bytes (this build only supports base64 to keep things simple)
    let bytes;
    if (fileBase64) {
      try {
        bytes = Buffer.from(fileBase64, 'base64');
      } catch (e) {
        return sendError(res, 400, 'Invalid base64', String(e && e.message || e));
      }
    } else {
      return sendError(res, 400, 'fileUrl not supported in this build (use fileBase64)');
    }

    const ext = (path.extname(filename || '') || '').toLowerCase();
    const srcPath = path.join(tmpDir, `upload${ext || ''}`);
    await fsp.writeFile(srcPath, bytes);

    // If MSG → use Python extract_msg to produce an EML
    let emlPath = null;
    if (ext === '.msg') {
      logs.push('detected .msg; invoking msg2eml.py (extract_msg)');
      const outPath = path.join(tmpDir, 'converted.eml');

      // quick python check
      const pyOk = await new Promise((resolve) => {
        execFile('python3', ['-c', 'import extract_msg'], { timeout: 5000 }, (err) => resolve(!err));
      });
      if (!pyOk) {
        return sendError(res, 500,
          'Python extract_msg not available in container. Please redeploy with correct Dockerfile.',
          { logs });
      }

      await new Promise((resolve, reject) => {
        execFile('python3', ['/app/msg2eml.py', srcPath, outPath], { timeout: 45000 }, (err, _stdout, stderr) => {
          if (err) {
            logs.push(`msg2eml.py failed: ${stderr || String(err)}`);
            return reject(new Error('MSG→EML conversion failed (file may be corrupt/unsupported)'));
          }
          resolve();
        });
      });
      emlPath = outPath;
    } else if (ext === '.eml') {
      emlPath = srcPath;
    } else {
      // Not an email: return a stub PDF so the pipeline remains testable
      const pdf = renderStubPDF(filename, bytes.length);
      if (wantsJson) return res.json({ ok: true, route: 'stub-non-email', bytes: bytes.length, logs });
      res.type('application/pdf').send(pdf);
      return;
    }

    // Parse EML
    let parsed;
    try {
      const emlBuf = await fsp.readFile(emlPath);
      parsed = await simpleParser(emlBuf);
    } catch (e) {
      logs.push('simpleParser error: ' + (e && e.message || e));
      return sendError(res, 422, 'Failed to parse EML after conversion', { logs });
    }

    // Extract fields
    const subject = parsed.subject || '(no subject)';
    const from    = parsed.from ? parsed.from.text : '';
    const to      = parsed.to   ? parsed.to.text   : '';
    const cc      = parsed.cc   ? parsed.cc.text   : '';
    const date    = parsed.date ? new Date(parsed.date).toISOString()
                                : (parsed.headers && parsed.headers.get && parsed.headers.get('date')) || '';

    // Prefer HTML→text; fallback to text
    let bodyText = '';
    if (parsed.html) {
      try {
        bodyText = htmlToText(parsed.html, {
          wordwrap: 100,
          selectors: [
            { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
            { selector: 'img', format: 'skip' }
          ]
        });
      } catch {}
    }
    if (!bodyText && parsed.text) bodyText = parsed.text;

    if (!bodyText || !bodyText.trim()) {
      logs.push('No readable body after parsing');
      return sendError(res, 422, 'No readable body found in message', { logs });
    }

    // Render PDF
    const pdfBuffer = await renderEmailPDF({
      title: subject,
      meta: { From: from, To: to, Cc: cc, Date: date },
      bodyText
    });

    if (wantsJson) return res.json({ ok: true, route: (ext === '.msg' ? 'msg(py)->eml->pdf' : 'eml->pdf'), logs });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdfBuffer);

  } catch (e) {
    return sendError(res, 500, 'Internal error', { msg: String(e && e.message || e), logs });
  } finally {
    await cleanup();
  }
});

function renderStubPDF(filename, size) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', d => chunks.push(d));
  doc.on('end', () => {});
  doc.fontSize(22).text('OrdoLux Email→PDF (Stub)', { underline: true });
  doc.moveDown();
  doc.fontSize(12).text(`Filename: ${filename}`);
  doc.text(`Bytes: ${size}`);
  doc.text(`Generated: ${new Date().toISOString()}`);
  doc.end();
  return Buffer.concat(chunks);
}

function renderEmailPDF({ title, meta, bodyText }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).text(title, { width: 515 });
    doc.moveDown(0.5);

    doc.fontSize(11);
    ['From', 'To', 'Cc', 'Date'].forEach(k => {
      const v = (meta && meta[k]) ? String(meta[k]).trim() : '';
      if (v) doc.text(`${k}: ${v}`, { width: 515 });
    });

    doc.moveDown(0.5);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown();

    doc.fontSize(12).text(String(bodyText || '').slice(0, 500000), { width: 515 });
    doc.end();
  });
}

app.listen(PORT, () => {
  console.log(`OrdoLux email-pdf service listening on :${PORT}`);
});
