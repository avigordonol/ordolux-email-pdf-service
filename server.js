// OrdoLux Email → PDF microservice (Railway)
// - Accepts fileBase64 or fileUrl + filename
// - Auth via X-Ordolux-Secret
// - Parses .eml via mailparser, .msg via Python extract_msg
// - Streams a real PDF using pdfkit
// - Normalizes text to avoid stray "Ð" etc.

const express         = require('express');
const { simpleParser }= require('mailparser');
const PDFDocument     = require('pdfkit');
const fs              = require('fs');
const os              = require('os');
const path            = require('path');
const http            = require('http');
const https           = require('https');
const { spawnSync }   = require('child_process');

const SHARED_SECRET = process.env.SHARED_SECRET || '';
const PORT          = process.env.PORT || 8080;

// ------------------------- helpers -------------------------

function normalizeText(s = '') {
  return String(s)
    .replace(/\r\n/g, '\n')  // CRLF -> LF
    .replace(/\r/g, '\n')    // lone CR -> LF
    .replace(/\u00A0/g, ' ') // NBSP -> normal space
    .replace(/\u200B/g, '')  // zero-width space
    .replace(/\uFEFF/g, '')  // BOM
    .replace(/\u0000/g, ''); // stray NULs
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

function writeTmp(buf, ext) {
  const p = path.join(
    os.tmpdir(),
    `ordolux-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  );
  fs.writeFileSync(p, buf);
  return p;
}

function parseMsgWithPython(tmpPath) {
  const py = '/opt/pyenv/bin/python';
  const code = `
import sys, json
try:
    import extract_msg
except Exception as e:
    print(json.dumps({"ok": False, "error": "extract_msg-not-available", "detail": str(e)}))
    sys.exit(0)

p = sys.argv[1]
try:
    msg = extract_msg.Message(p)
    subject = getattr(msg, 'subject', '') or ''
    body = getattr(msg, 'body', '') or getattr(msg, 'body_text', '') or ''
    sender = getattr(msg, 'sender', '') or getattr(msg, 'sender_name', '') or ''
    to = getattr(msg, 'to', '') or ''
    cc = getattr(msg, 'cc', '') or ''
    date = str(getattr(msg, 'date', '') or '')
    out = {"ok": True, "subject": subject, "body": body, "from": sender, "to": to, "cc": cc, "date": date}
    print(json.dumps(out, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok": False, "error": "msg-parse-failed", "detail": str(e)}))
`;
  const r = spawnSync(py, ['-c', code, tmpPath], { encoding: 'utf8' });
  if (r.error) return { ok: false, error: String(r.error) };

  const text = (r.stdout || '').trim();
  try { return JSON.parse(text || '{}'); }
  catch { return { ok: false, error: 'bad-json-from-python', detail: text }; }
}

// ------------------------- app -------------------------

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/healthz', (req, res) => {
  if (SHARED_SECRET && req.get('X-Ordolux-Secret') !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  res.json({ ok: true });
});

app.post('/convert', async (req, res) => {
  try {
    if (SHARED_SECRET && req.get('X-Ordolux-Secret') !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { fileBase64, fileUrl, filename = 'Email.eml', options = {} } = req.body || {};
    if (!fileBase64 && !fileUrl) {
      return res.status(422).json({ ok: false, error: 'missing fileBase64 or fileUrl' });
    }

    // Get file bytes
    let buf;
    if (fileBase64) buf = Buffer.from(fileBase64, 'base64');
    else            buf = await fetchUrl(fileUrl);

    // Determine type
    let ext = path.extname(filename).toLowerCase();
    if (!ext) {
      ext = buf.slice(0, 4).toString('ascii') === 'From' ? '.eml' : '.msg';
    }

    // Parse
    let meta = { subject: '', from: '', to: '', cc: '', date: '' };
    let bodyText = '';

    if (ext === '.eml') {
      const parsed = await simpleParser(buf);
      meta.subject = parsed.subject || '';
      meta.from    = parsed.from ? parsed.from.text : '';
      meta.to      = parsed.to ? parsed.to.text : '';
      meta.cc      = parsed.cc ? parsed.cc.text : '';
      meta.date    = parsed.date ? new Date(parsed.date).toISOString() : '';
      bodyText     = normalizeText(parsed.text || parsed.html || parsed.textAsHtml || '');
    } else if (ext === '.msg') {
      const tmpPath = writeTmp(buf, '.msg');
      const out = parseMsgWithPython(tmpPath);
      fs.unlink(tmpPath, () => {});
      if (!out.ok) return res.status(500).json({ ok: false, error: 'msg-parse', detail: out });

      meta.subject = out.subject || '';
      meta.from    = out.from || '';
      meta.to      = out.to || '';
      meta.cc      = out.cc || '';
      meta.date    = out.date || '';
      bodyText     = normalizeText(out.body || '');
    } else {
      const parsed = await simpleParser(buf);
      meta.subject = parsed.subject || '';
      meta.from    = parsed.from ? parsed.from.text : '';
      meta.to      = parsed.to ? parsed.to.text : '';
      meta.cc      = parsed.cc ? parsed.cc.text : '';
      meta.date    = parsed.date ? new Date(parsed.date).toISOString() : '';
      bodyText     = normalizeText(parsed.text || '');
    }

    // JSON debug if requested
    const accept = (req.get('accept') || '').toLowerCase();
    if (accept.includes('application/json') && !accept.includes('pdf')) {
      return res.json({ ok: true, meta, bytes: buf.length, options });
    }

    // PDF output
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="${(path.basename(filename, ext) || 'email')}.pdf"`);

    const doc = new PDFDocument({
      autoFirstPage: true,
      margins: { top: 54, bottom: 54, left: 54, right: 54 },
    });
    doc.pipe(res);

    doc.font('Helvetica-Bold').fontSize(18).text('OrdoLux Email → PDF');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10);
    if (meta.subject) doc.text(`Subject: ${normalizeText(meta.subject)}`);
    if (meta.from)    doc.text(`From:    ${normalizeText(meta.from)}`);
    if (meta.to)      doc.text(`To:      ${normalizeText(meta.to)}`);
    if (meta.cc)      doc.text(`Cc:      ${normalizeText(meta.cc)}`);
    if (meta.date)    doc.text(`Date:    ${normalizeText(meta.date)}`);

    doc.moveDown().moveTo(54, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown();

    doc.font('Helvetica').fontSize(12).text(bodyText || '(no body)', { width: 520 });

    // if (options.mergeAttachments) { /* future: merge attachments */ }

    doc.end();
  } catch (err) {
    console.error('convert error', err);
    res.status(500).json({ ok: false, error: 'internal', detail: String(err && err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`OrdoLux email→PDF listening on ${PORT}`);
});
