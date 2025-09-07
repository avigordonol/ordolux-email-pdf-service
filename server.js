// OrdoLux Email→PDF microservice (EML + MSG via msgconvert)
// - Auth: header X-Ordolux-Secret must equal process.env.SHARED_SECRET
// - POST /convert: { fileBase64, filename, options? }
//      -> application/pdf (default) OR application/json (if Accept: application/json)
// - GET  /healthz: { ok: true }
// - GET  /diag: environment diagnostics

const express    = require('express');
const bodyParser = require('body-parser');
const crypto     = require('crypto');
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

function fail(res, code, msg, extra) {
  const out = { ok: false, error: msg };
  if (extra) out.details = extra;
  // If caller wants JSON, always send JSON
  const wantsJson = (res.req.headers.accept || '').includes('application/json');
  if (wantsJson) return res.status(code).json(out);
  // Otherwise text for errors
  return res.status(code).type('text/plain').send(JSON.stringify(out));
}

app.get('/healthz', (req, res) => {
  if (!SHARED_SECRET) return res.status(500).json({ ok: false, error: 'Missing SHARED_SECRET' });
  return res.json({ ok: true });
});

app.get('/diag', async (req, res) => {
  const diag = {
    ok: true,
    node: process.version,
    secretSet: !!SHARED_SECRET,
    msgconvert: null
  };
  try {
    await new Promise((resolve, reject) => {
      execFile('msgconvert', ['--help'], { timeout: 4000 }, (err, stdout, stderr) => {
        if (err) return resolve(); // not fatal, just absent
        diag.msgconvert = 'ok';
        resolve();
      });
    });
  } catch {}
  res.json(diag);
});

app.post('/convert', async (req, res) => {
  const secret = req.header('X-Ordolux-Secret') || '';
  if (!SHARED_SECRET || secret !== SHARED_SECRET) {
    return fail(res, 401, 'Unauthorized');
  }

  const wantsPdf  = (req.headers.accept || '').includes('application/pdf');
  const wantsJson = (req.headers.accept || '').includes('application/json');

  const { fileBase64, filename, fileUrl, options } = req.body || {};
  if (!fileBase64 && !fileUrl) return fail(res, 400, 'Provide fileBase64 or fileUrl');
  if (!filename) return fail(res, 400, 'Provide filename');

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ordolux-'));
  const cleanup = async () => { try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {} };

  const logs = [];
  try {
    // 1) Acquire bytes
    let bytes;
    if (fileBase64) {
      try {
        bytes = Buffer.from(fileBase64, 'base64');
      } catch (e) {
        return fail(res, 400, 'Invalid base64', String(e && e.message || e));
      }
    } else {
      // (Optional) remote fetch path; disabled by default for safety
      return fail(res, 400, 'fileUrl not supported in this build, use fileBase64');
    }

    const ext = path.extname(filename || '').toLowerCase();
    const srcPath = path.join(tmpDir, `upload${ext || ''}`);
    await fsp.writeFile(srcPath, bytes);

    // 2) If .msg → convert to .eml via msgconvert
    let emlPath = null;
    if (ext === '.msg') {
      const outPath = path.join(tmpDir, 'converted.eml');
      logs.push('detected .msg; invoking msgconvert');
      await new Promise((resolve, reject) => {
        execFile('msgconvert', ['--outfile', outPath, srcPath], { timeout: 30000 }, (err, stdout, stderr) => {
          if (err) {
            logs.push(`msgconvert failed: ${stderr || String(err)}`);
            return reject(new Error('msgconvert failed (is it installed? file may be corrupt/RTF/TNEF)'));
          }
          resolve();
        });
      });
      emlPath = outPath;
    } else if (ext === '.eml') {
      emlPath = srcPath;
    } else {
      // Not an email: make a tiny “stub” PDF with filename and size (keeps pipeline testable)
      const pdf = renderStubPDF(filename, bytes.length);
      if (wantsJson) {
        return res.json({ ok: true, route: 'stub-non-email', bytes: bytes.length, logs });
      }
      res.type('application/pdf').send(pdf);
      return;
    }

    // 3) Parse EML (subject/from/to/cc/date + html/text)
    const emlBuf = await fsp.readFile(emlPath);
    let parsed;
    try {
      parsed = await simpleParser(emlBuf);
    } catch (e) {
      logs.push('simpleParser error: ' + (e && e.message || e));
      return fail(res, 422, 'Failed to parse EML after conversion', String(e && e.message || e));
    }

    const subject = parsed.subject || '(no subject)';
    const from    = parsed.from ? parsed.from.text : '';
    const to      = parsed.to   ? parsed.to.text   : '';
    const cc      = parsed.cc   ? parsed.cc.text   : '';
    const date    = parsed.date ? new Date(parsed.date).toISOString() : (parsed.headers && parsed.headers.get && parsed.headers.get('date')) || '';

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
      return fail(res, 422, 'No readable body found in message', { logs });
    }

    // 4) Render PDF (simple, robust)
    const pdfBuffer = await renderEmailPDF({
      title: subject,
      meta: { From: from, To: to, Cc: cc, Date: date },
      bodyText
    });

    // (Optional) merge PDF attachments later; for now we return the main PDF.
    if (wantsJson) {
      return res.json({ ok: true, route: (ext === '.msg' ? 'msg->eml->pdf' : 'eml->pdf'), logs });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdfBuffer);

  } catch (e) {
    return fail(res, 500, 'Internal error', { msg: String(e && e.message || e), logs });
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

    doc.fontSize(18).text(title, { width: 515, continued: false });
    doc.moveDown(0.5);

    doc.fontSize(11);
    const keys = ['From', 'To', 'Cc', 'Date'];
    keys.forEach(k => {
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
