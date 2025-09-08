/* OrdoLux Email→PDF server — v1.4.0
   - Robust /convert-json that always returns JSON
   - Unicode-safe rendering via DejaVuSans
   - Strips zero-width/odd spaces
   - Scales images nicely
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const bodyParser = require('body-parser');
const { simpleParser } = require('mailparser');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { htmlToText } = require('html-to-text');

const SECRET_HEADER = 'x-ordolux-secret';
const EXPECTED_SECRET = process.env.ORDOLUX_SECRET || ''; // Railway variable recommended

const app = express();
app.use(bodyParser.json({ limit: '25mb' }));

// --- helpers ----
const INVISIBLES_RX = /[\u200B\u200C\u200D\uFEFF\u2060\u00AD]/g; // zero width + soft hyphen
const NBSP_RX = /\u00A0/g;

function sanitizeString(s) {
  if (!s) return '';
  return String(s)
    .replace(NBSP_RX, ' ')
    .replace(INVISIBLES_RX, '')
    .replace(/\r\n/g, '\n')
    .replace(/\u2028|\u2029/g, '\n');
}

function mustAuth(req, res) {
  if (!EXPECTED_SECRET) return true; // dev mode
  return (req.headers[SECRET_HEADER] || '') === EXPECTED_SECRET;
}

function toTinySummary(parsed) {
  const m = parsed.message || {};
  const a = m.attachments || [];
  return {
    ok: true,
    parsed: {
      meta: parsed.meta || {},
      message: {
        from: m.from || '',
        to: m.to || '',
        cc: m.cc || '',
        subject: m.subject || '',
        date: m.date || '',
        text_length: (m.text || '').length,
        html_length: (m.html || '').length,
        attach_count: a.length
      }
    }
  };
}

async function runPyMsgToJson(tmpPath) {
  const py = '/opt/pyenv/bin/python3';
  const script = path.join(__dirname, 'msg_to_json.py');
  return new Promise((resolve, reject) => {
    execFile(py, [script, tmpPath], { maxBuffer: 25 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        const obj = JSON.parse(stdout);
        resolve(obj);
      } catch (e) {
        reject(new Error(`.msg parse JSON error: ${e.message}`));
      }
    });
  });
}

function normalizeAddrs(addrs) {
  // addrs can be AddressObject or string; keep it simple for PDF header
  if (!addrs) return '';
  if (typeof addrs === 'string') return sanitizeString(addrs);
  const arr = [];
  const list = [].concat(addrs.value || []);
  for (const a of list) {
    const n = sanitizeString(a.name || '');
    const a1 = sanitizeString(a.address || '');
    if (n && a1) arr.push(`${n} <${a1}>`);
    else if (a1) arr.push(a1);
    else if (n) arr.push(n);
  }
  return arr.join(', ');
}

async function parseEmailFromUpload(fileBase64, filename) {
  const buf = Buffer.from(fileBase64, 'base64');
  const lower = (filename || '').toLowerCase();

  if (lower.endsWith('.eml')) {
    const mail = await simpleParser(buf);
    const attachments = (mail.attachments || []).map(att => ({
      filename: att.filename || '',
      contentType: att.contentType || '',
      contentId: (att.cid || '').replace(/[<>]/g, '').toLowerCase(),
      inline: !!att.cid,
      dataBase64: (att.content ? Buffer.from(att.content).toString('base64') : '')
    }));
    return {
      meta: { source: 'eml', has_html: !!mail.html, attachment_count: attachments.length },
      message: {
        from: normalizeAddrs(mail.from),
        to: normalizeAddrs(mail.to),
        cc: normalizeAddrs(mail.cc),
        subject: sanitizeString(mail.subject),
        date: mail.date ? new Date(mail.date).toISOString() : '',
        text: sanitizeString(mail.text || ''),
        html: sanitizeString(typeof mail.html === 'string' ? mail.html : ''),
        attachments
      }
    };
  }

  // Fallback: assume .msg — write temp file then call Python
  const tmp = path.join(os.tmpdir(), `upl-${Date.now()}-${Math.random().toString(36).slice(2)}.msg`);
  fs.writeFileSync(tmp, buf);
  try {
    const obj = await runPyMsgToJson(tmp);
    // attachments already base64 in obj
    const attachments = (obj.attachments || []).map(att => ({
      filename: att.filename || '',
      contentType: att.contentType || '',
      contentId: (att.contentId || '').replace(/[<>]/g, '').toLowerCase(),
      inline: !!att.inline,
      dataBase64: att.dataBase64 || ''
    }));
    return {
      meta: { source: 'msg', has_html: !!obj.html, attachment_count: attachments.length },
      message: {
        from: sanitizeString(obj.from || ''),
        to: sanitizeString(obj.to || ''),
        cc: sanitizeString(obj.cc || ''),
        subject: sanitizeString(obj.subject || ''),
        date: obj.date || '',
        text: sanitizeString(obj.text || ''),
        html: sanitizeString(obj.html || ''),
        attachments
      }
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function htmlToPlain(s) {
  if (!s) return '';
  const text = htmlToText(s, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' } // we render images separately
    ]
  });
  return sanitizeString(text);
}

function collectCidOrderFromHtml(html) {
  if (!html) return [];
  const rx = /<img[^>]+src=['"]cid:([^'">]+)['"][^>]*>/ig;
  const order = [];
  let m;
  while ((m = rx.exec(html))) {
    order.push(m[1].replace(/[<>]/g, '').toLowerCase());
  }
  return order;
}

async function renderPdf(parsed) {
  const { message } = parsed;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  // Use DejaVu Sans (installed by Dockerfile)
  const fontBytes = fs.readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  const font = await doc.embedFont(fontBytes, { subset: true });

  const pageWidth = 595.28;   // A4
  const pageHeight = 841.89;
  const margin = 48;
  const usableW = pageWidth - margin * 2;
  const lineGap = 4;
  const fontSize = 10;

  let page = doc.addPage([pageWidth, pageHeight]);
  let cursorY = pageHeight - margin;

  const setColor = rgb(0, 0, 0);

  function newPage(hMin = 0) {
    page = doc.addPage([pageWidth, pageHeight]);
    cursorY = pageHeight - margin;
  }
  function ensureSpace(h) {
    if (cursorY - h < margin) newPage();
  }
  function drawTextBlock(txt) {
    if (!txt) return;
    const lines = wrapText(txt, usableW, font, fontSize);
    for (const ln of lines) {
      const height = fontSize;
      ensureSpace(height);
      page.drawText(ln, { x: margin, y: cursorY - height, size: fontSize, font, color: setColor });
      cursorY -= (height + lineGap);
    }
  }
  // Simple word-wrapping using font width
  function wrapText(text, maxWidth, font, size) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const trial = line ? line + ' ' + w : w;
      const width = font.widthOfTextAtSize(trial, size);
      if (width <= maxWidth) {
        line = trial;
      } else {
        if (line) lines.push(line);
        // very long single "word" fallback
        if (font.widthOfTextAtSize(w, size) > maxWidth) {
          let buf = '';
          for (const ch of w) {
            const t2 = buf + ch;
            if (font.widthOfTextAtSize(t2, size) <= maxWidth) buf = t2;
            else { lines.push(buf); buf = ch; }
          }
          line = buf;
        } else {
          line = w;
        }
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Header (no OrdoLux logo/mark, per request)
  const header = [
    `From: ${sanitizeString(message.from || '')}`,
    `To: ${sanitizeString(message.to || '')}`,
    message.cc ? `Cc: ${sanitizeString(message.cc)}` : '',
    message.date ? `Date: ${sanitizeString(message.date)}` : '',
    `Subject: ${sanitizeString(message.subject || '')}`
  ].filter(Boolean).join('\n');

  drawTextBlock(header);
  cursorY -= 8;

  // Body text (prefer HTML → text)
  const bodyText = message.html ? htmlToPlain(message.html) : sanitizeString(message.text || '');
  drawTextBlock(bodyText);

  // Inline images (by CID order in HTML); if none, embed all image attachments at end
  const att = Array.isArray(message.attachments) ? message.attachments : [];
  const images = att.filter(a => (a.contentType || '').toLowerCase().startsWith('image/') && a.dataBase64);

  const cidOrder = collectCidOrderFromHtml(message.html || '');
  const cidMap = new Map();
  for (const a of images) cidMap.set((a.contentId || '').toLowerCase(), a);
  const ordered = [];
  for (const id of cidOrder) {
    const it = cidMap.get(id);
    if (it) { ordered.push(it); cidMap.delete(id); }
  }
  for (const a of images) {
    if (cidMap.has((a.contentId || '').toLowerCase())) ordered.push(a);
  }

  for (const img of ordered) {
    const bytes = Buffer.from(img.dataBase64, 'base64');
    let embedded;
    try {
      // pdf-lib auto-detects
      embedded = await doc.embedPng(bytes).catch(async () => await doc.embedJpg(bytes));
    } catch {
      continue; // skip bad image
    }
    const maxW = usableW;
    const maxH = 420; // sensible cap
    let w = embedded.width;
    let h = embedded.height;
    const scale = Math.min(maxW / w, maxH / h, 1);
    w = w * scale; h = h * scale;

    ensureSpace(h + 16);
    page.drawImage(embedded, { x: margin, y: cursorY - h, width: w, height: h });
    cursorY -= (h + 12);
    if (img.filename) {
      page.drawText(sanitizeString(img.filename), { x: margin, y: cursorY - fontSize, size: fontSize, font, color: rgb(0.3,0.3,0.3) });
      cursorY -= (fontSize + 8);
    }
  }

  return await doc.save();
}

// ---- routes ----
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, name: 'ordolux-email-pdf', version: '1.4.0', ts: new Date().toISOString() });
});

app.get('/routes', (req, res) => {
  if (!mustAuth(req, res)) return res.status(401).json({ ok:false, error: 'unauthorized', expects: SECRET_HEADER });
  res.json({ ok: true, routes: ['GET  /healthz','GET  /routes','POST /echo','POST /convert-json','POST /convert'], expects_header: 'X-Ordolux-Secret' });
});

app.post('/echo', (req, res) => {
  if (!mustAuth(req, res)) return res.status(401).json({ ok:false, error: 'unauthorized' });
  const b = req.body || {};
  res.json({ ok: true, keys: Object.keys(b), has_fileBase64: !!b.fileBase64 });
});

app.post('/convert-json', async (req, res) => {
  if (!mustAuth(req, res)) return res.status(401).json({ ok:false, error:'unauthorized' });
  try {
    const { fileBase64, filename } = req.body || {};
    if (!fileBase64 || !filename) return res.status(400).json({ ok:false, error: 'missing fileBase64/filename' });
    const parsed = await parseEmailFromUpload(fileBase64, filename);
    return res.json(toTinySummary(parsed));
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e && e.message || e) });
  }
});

app.post('/convert', async (req, res) => {
  if (!mustAuth(req, res)) return res.status(401).json({ ok:false, error:'unauthorized' });
  try {
    const { fileBase64, filename } = req.body || {};
    if (!fileBase64 || !filename) return res.status(400).json({ ok:false, error: 'missing fileBase64/filename' });

    const parsed = await parseEmailFromUpload(fileBase64, filename);
    const pdfBytes = await renderPdf(parsed);

    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    // Still send JSON so your script can show something useful
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`OrdoLux Email→PDF listening on ${PORT}`));
