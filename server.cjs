/* OrdoLux Email→PDF — stable text renderer (images gated) */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const he = require('he');
const { htmlToText } = require('html-to-text');

const app = express();
app.use(express.json({ limit: '35mb' }));

const PORT = process.env.PORT || 8080;
const SECRET_HEADER = 'X-Ordolux-Secret';
const SECRET = process.env.ORDOLUX_SECRET || process.env.ORDO_SECRET || process.env.SECRET;

const okSecret = (req) => {
  if (!SECRET) return true; // dev-friendly if not set
  return req.get(SECRET_HEADER) === SECRET;
};

app.get('/healthz', (_req, res) =>
  res.json({ ok: true, name: 'ordolux-email-pdf', version: '1.3.2', ts: new Date().toISOString() })
);

app.get('/routes', (req, res) => {
  if (!okSecret(req)) return res.status(401).json({ ok: false, error: `missing ${SECRET_HEADER}` });
  res.json({
    ok: true,
    routes: ['GET  /healthz', 'GET  /routes', 'POST /echo', 'POST /convert-json', 'POST /convert'],
    expects_header: SECRET_HEADER
  });
});

app.post('/echo', (req, res) => {
  if (!okSecret(req)) return res.status(401).json({ ok: false, error: `missing ${SECRET_HEADER}` });
  res.json({ ok: true, keys: Object.keys(req.body || {}), has_fileBase64: !!(req.body || {}).fileBase64 });
});

// ---------- helpers ----------
function writeTemp(base64, filename = '') {
  const ext = (path.extname(filename) || '').toLowerCase();
  const p = path.join(os.tmpdir(), `upl-${Date.now()}-${uuidv4()}${ext}`);
  fs.writeFileSync(p, Buffer.from(base64, 'base64'));
  return p;
}

function parseWithPython(tempPath) {
  return new Promise((resolve, reject) => {
    const py = '/opt/pyenv/bin/python3';
    const child = spawn(py, ['/app/msg_to_json.py', tempPath]);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', () => {
      try {
        const j = JSON.parse(out);
        resolve(j);
      } catch (e) {
        reject(new Error(`msg_to_json failed: ${err || out}`));
      }
    });
  });
}

function stripZWs(s) {
  if (!s) return '';
  return s
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '') // zero-widths
    .replace(/\u00A0/g, ' '); // nbsp -> space
}

function sanitizeWinAnsi(s) {
  s = stripZWs(s);
  const map = {
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
    '\u2013': '-', '\u2014': '-', '\u2212': '-',
    '\u2026': '...', '\u2022': '*', '\u00B7': '*'
  };
  s = s.replace(
    /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2013\u2014\u2212\u2026\u2022\u00B7]/g,
    (c) => map[c] || ''
  );
  s = s.replace(/[^\x00-\xFF]/g, '');                 // keep within WinAnsi
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // remove stray controls
  return s;
}

function bodyFrom(html, text) {
  if (text && text.trim()) return text;
  if (html && html.trim()) {
    return htmlToText(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] });
  }
  return '';
}

async function renderPdf(parsed, opts = {}) {
  const renderImages = !!opts.renderImages; // default false (safe)
  const doc = await PDFDocument.create();
  const font = await doc.embedStandardFont(StandardFonts.Helvetica);
  const fontB = await doc.embedStandardFont(StandardFonts.HelveticaBold);

  const A4 = [595.28, 841.89];
  let page = doc.addPage(A4);
  let { width, height } = page.getSize();
  const margin = 50;
  let y = height - margin;

  const draw = (txt, size = 12, bold = false, gap = 6) => {
    const f = bold ? fontB : font;
    const s = sanitizeWinAnsi(txt || '');
    page.drawText(s, { x: margin, y: y - size, size, font: f });
    y -= size + gap;
    if (y < margin) {
      page = doc.addPage(A4);
      ({ width, height } = page.getSize());
      y = height - margin;
    }
  };

  const wrap = (txt, size = 11, gap = 4) => {
    const f = font;
    const maxW = width - margin * 2;
    const words = sanitizeWinAnsi(txt || '').split(/\s+/);
    let line = '';
    const flush = () => {
      if (!line) return;
      page.drawText(line, { x: margin, y: y - size, size, font: f });
      y -= size + gap;
      if (y < margin) {
        page = doc.addPage(A4);
        ({ width, height } = page.getSize());
        y = height - margin;
      }
      line = '';
    };
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (f.widthOfTextAtSize(t, size) > maxW) {
        flush();
        // If a single token is too long, hard-slice
        let token = w;
        while (f.widthOfTextAtSize(token, size) > maxW) {
          let i = token.length;
          while (i > 1 && f.widthOfTextAtSize(token.slice(0, i), size) > maxW) i--;
          page.drawText(token.slice(0, i), { x: margin, y: y - size, size, font: f });
          y -= size + gap;
          if (y < margin) {
            page = doc.addPage(A4);
            ({ width, height } = page.getSize());
            y = height - margin;
          }
          token = token.slice(i);
        }
        line = token;
      } else {
        line = t;
      }
    }
    flush();
  };

  const m = parsed.message || {};
  // Headers
  draw(`From: ${m.from || ''}`, 12, true);
  draw(`To: ${m.to || ''}`);
  if (m.cc) draw(`Cc: ${m.cc}`);
  draw(`Subject: ${m.subject || ''}`);
  if (m.date) draw(`Date: ${m.date}`);

  // Body (always present via fallback)
  let html = m.html ? he.decode(m.html) : '';
  const textBody = bodyFrom(html, m.text);
  if (textBody && textBody.trim()) {
    draw('', 6, false, 6);
    for (const para of textBody.split(/\n{2,}/)) {
      const lines = para.split(/\n/);
      for (const ln of lines) wrap(ln, 11);
      draw('', 6, false, 6);
    }
  } else {
    draw('(No message body)');
  }

  // Images intentionally skipped unless renderImages === true
  if (renderImages) {
    // (Left empty intentionally in the “stable” build)
  }

  return Buffer.from(await doc.save());
}

async function parseUpload(fileBase64, filename) {
  const tmp = writeTemp(fileBase64, filename || '');
  try {
    return await parseWithPython(tmp);
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ---------- routes ----------
app.post('/convert-json', async (req, res) => {
  if (!okSecret(req)) return res.status(401).json({ ok: false, error: `missing ${SECRET_HEADER}` });
  try {
    const { fileBase64, filename } = req.body || {};
    if (!fileBase64) return res.status(400).json({ ok: false, error: 'fileBase64 missing' });
    const parsed = await parseUpload(fileBase64, filename || '');
    const m = parsed.message || {};
    res.json({
      ok: true,
      parsed: {
        meta: parsed.meta || {},
        message: {
          from: m.from || '',
          to: m.to || '',
          cc: m.cc || '',
          subject: m.subject || '',
          date: m.date || '',
          text_length: m.text ? m.text.length : 0,
          html_length: m.html ? m.html.length : 0,
          attach_count: (m.attachments || []).length
        }
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/convert', async (req, res) => {
  if (!okSecret(req)) return res.status(401).json({ ok: false, error: `missing ${SECRET_HEADER}` });
  try {
    const { fileBase64, filename, options = {} } = req.body || {};
    if (!fileBase64) return res.status(400).json({ ok: false, error: 'fileBase64 missing' });
    const parsed = await parseUpload(fileBase64, filename || '');
    const pdf = await renderPdf(parsed, options); // images gated by options.renderImages
    res.set('Content-Type', 'application/pdf');
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => console.log(`OrdoLux email-pdf listening on ${PORT}`));
