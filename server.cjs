/* OrdoLux Email→PDF (robust)
   - Unicode-safe (embeds DejaVu Sans)
   - Strips zero-width chars & Outlook/BOM junk
   - Safer image handling (skip/range-limit very large images)
   - Always returns concise JSON on error
   - Adds /convert-json for quick debug without rendering
*/
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { simpleParser } = require('mailparser');
const { PDFDocument, rgb } = require('pdf-lib');
const he = require('he');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.ORDOLUX_SECRET || '';
const app = express();

// Larger body limit for chunky .msg with inline images
app.use(express.json({ limit: '60mb' }));

// Where Debian puts DejaVu Sans
const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
let DEJAVU_BYTES = null;
try {
  DEJAVU_BYTES = fs.readFileSync(DEJAVU);
} catch (e) {
  console.error('Unicode font missing:', e.message);
}

// Security
function okSecret(req) {
  return SECRET ? req.header('X-Ordolux-Secret') === SECRET : true;
}
app.get('/healthz', (req, res) => okSecret(req) ? res.json({ ok: true }) : res.status(401).send('unauthorized'));

// --------- Text clean-up ----------
const RE_ZW   = /[\u200B-\u200D\uFEFF]/g; // ZWSP, ZWNJ, ZWJ, BOM
const RE_NBSP = /\u00A0/g;
const RE_SEP  = /[\u2028\u2029]/g;

const cleanText = (s) =>
  String(s || '')
    .replace(RE_ZW, '')
    .replace(RE_NBSP, ' ')
    .replace(RE_SEP, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

const oneLine = (s) => cleanText(s).replace(/\s+/g, ' ').trim();

const fmtHeaderList = (v) => Array.isArray(v) ? oneLine(v.join(', ')) : oneLine(v);

// ---- Attachments helpers ----
const isImage = (att) => ((att.contentType || '').toLowerCase().startsWith('image/'));
const normalizeAttachment = (att) => ({
  filename: att.filename || att.name || 'file',
  contentType: att.contentType || att.mimeType || '',
  contentId: att.contentId || att.cid || null,
  dataBase64:
    att.dataBase64 || att.data_b64 || att.dataB64 ||
    (att.content ? Buffer.from(att.content).toString('base64') : null)
});

// Build a minimal render model
function toRenderModel(parsed) {
  const m = parsed.message || parsed;
  const html = m.body_html || m.html || '';
  const bodyText = m.body_text || m.text || he.decode(html.replace(/<[^>]+>/g, ' '));
  return {
    from: fmtHeaderList(m.from),
    to: fmtHeaderList(m.to),
    cc: fmtHeaderList(m.cc),
    subject: cleanText(m.subject || '(no subject)'),
    date: m.date ? new Date(m.date).toISOString() : '',
    bodyText: cleanText(bodyText),
    attachments: Array.isArray(m.attachments) ? m.attachments.map(normalizeAttachment) : []
  };
}

// Word wrap
function wrapLines(font, size, text, maxWidth) {
  const words = text.split(/(\s+)/);
  const lines = [];
  let cur = '';
  for (const tok of words) {
    const trial = cur + tok;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth || !cur) cur = trial;
    else { lines.push(cur.trimEnd()); cur = tok.trimStart(); }
  }
  if (cur) lines.push(cur.trimEnd());
  return lines.join('\n').split('\n').map(l => l.trimEnd());
}

// Rendering (A4)
async function renderPdf(parsed, opts = {}) {
  if (!DEJAVU_BYTES) throw new Error('Unicode font (DejaVu Sans) not found on image.');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(DEJAVU_BYTES, { subset: true });

  const margin = 40;
  const width  = 595.28;
  const height = 841.89;
  let page = pdf.addPage([width, height]);

  const headerSize = 12, bodySize = 11, gap = 4, maxW = width - 2 * margin;
  let y = height - margin;

  function newPageIfNeeded(h) {
    if (y - h < margin) { page = pdf.addPage([width, height]); y = height - margin; }
  }

  const drawLine = (txt, size = bodySize) => {
    txt = cleanText(txt);
    if (!txt) return;
    for (const l of wrapLines(font, size, txt, maxW)) {
      const h = font.heightAtSize(size);
      newPageIfNeeded(h);
      page.drawText(l, { x: margin, y: y - h, size, font, color: rgb(0,0,0) });
      y -= h + gap;
    }
  };

  const spacer = (px = 8) => { y -= px; if (y < margin) { page = pdf.addPage([width, height]); y = height - margin; } };

  // Prevent memory blowups (skip absurd images)
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB
  async function drawImage(att) {
    if (!att?.dataBase64) return;
    const buf = Buffer.from(att.dataBase64, 'base64');
    if (buf.length > MAX_IMAGE_BYTES) {
      // Skip huge images silently (or log on server)
      return;
    }
    let img;
    const ct = (att.contentType || '').toLowerCase();
    if (ct.includes('png')) img = await pdf.embedPng(buf);
    else if (ct.includes('jpg') || ct.includes('jpeg')) img = await pdf.embedJpg(buf);
    else return;

    const scale = Math.min(1, (maxW) / img.width);
    const w = img.width * scale, h = img.height * scale;
    newPageIfNeeded(h);
    page.drawImage(img, { x: margin, y: y - h, width: w, height: h });
    y -= h + 8;
  }

  const m = toRenderModel(parsed);

  // Header (no branding)
  drawLine(`From: ${m.from}`, headerSize);
  if (m.to)  drawLine(`To: ${m.to}`, headerSize);
  if (m.cc)  drawLine(`Cc: ${m.cc}`, headerSize);
  if (m.date) drawLine(`Date: ${m.date}`, headerSize);
  drawLine(`Subject: ${m.subject}`, headerSize);
  spacer(10);

  // Body
  drawLine(m.bodyText, bodySize);
  spacer(6);

  // Inline images / attachments
  if (opts.mergeAttachments !== false && m.attachments?.length) {
    for (const a of m.attachments) {
      if (isImage(a)) await drawImage(a);
    }
  }

  return pdf.save();
}

// ---------- Parsers ----------
async function parseEML(tmpPath) {
  const raw = fs.readFileSync(tmpPath);
  const eml = await simpleParser(raw);
  const atts = (eml.attachments || []).map(a => ({
    filename: a.filename,
    contentType: a.contentType,
    contentId: a.cid || a.contentId || null,
    dataBase64: a.content ? Buffer.from(a.content).toString('base64') : null
  }));
  return {
    message: {
      from: eml.from ? eml.from.text : '',
      to: eml.to ? eml.to.text : '',
      cc: eml.cc ? eml.cc.text : '',
      subject: eml.subject || '',
      date: eml.date || '',
      body_html: eml.html || '',
      body_text: eml.text || '',
      attachments: atts
    },
    meta: { source: 'eml', has_html: !!eml.html, attachment_count: atts.length }
  };
}

async function parseMSG(tmpPath) {
  return new Promise((resolve, reject) => {
    const py = spawn('/opt/pyenv/bin/python3', [path.join(__dirname, 'msg_to_json.py'), tmpPath], { stdio: ['ignore','pipe','pipe'] });
    let out = '', err = '';
    py.stdout.on('data', d => out += d.toString('utf8'));
    py.stderr.on('data', d => err += d.toString('utf8'));
    py.on('close', code => {
      if (code !== 0) return reject(new Error(err || `msg_to_json exited ${code}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`Bad JSON from msg_to_json: ${e.message}`)); }
    });
  });
}

// ---------- Core handler ----------
async function handleConvert(req, res, forceJson) {
  if (!okSecret(req)) return res.status(401).json({ error: 'unauthorized' });

  const { fileBase64, filename, options } = req.body || {};
  if (!fileBase64 || !filename) {
    return res.status(422).json({ error: 'fileBase64 and filename are required' });
  }

  const ext = path.extname(filename).toLowerCase();
  const tmp = path.join('/tmp', `upl-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  try {
    fs.writeFileSync(tmp, Buffer.from(fileBase64, 'base64'));

    // Parse first (JSON-safe)
    let parsed;
    if (ext === '.eml') parsed = await parseEML(tmp);
    else if (ext === '.msg') parsed = await parseMSG(tmp);
    else return res.status(415).json({ error: `unsupported file type: ${ext}` });

    // If forceJson (or debugRender) -> short summary, no rendering
    if (forceJson || options?.debugRender) {
      const m = toRenderModel(parsed);
      return res.json({
        ok: true,
        parsed: {
          meta: parsed.meta,
          message: {
            from: oneLine(m.from),
            to: oneLine(m.to),
            cc: oneLine(m.cc),
            subject: oneLine(m.subject),
            text_length: m.bodyText.length,
            attach_count: (m.attachments || []).length
          }
        }
      });
    }

    // Render PDF
    const pdfBytes = await renderPdf(parsed, { mergeAttachments: options?.mergeAttachments !== false });
    res.setHeader('Content-Type', 'application/pdf');
    return res.send(Buffer.from(pdfBytes));
  } catch (e) {
    // Always a concise JSON error
    return res.status(500).json({
      ok: false,
      error: e.message,
      hint: 'Try options.debugRender=true or POST to /convert-json to inspect parsed headers quickly.'
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// Routes
app.post('/convert', (req, res) => handleConvert(req, res, false));
app.post('/convert-json', (req, res) => handleConvert(req, res, true));

// Last-resort error middleware (keeps process alive & ensures JSON)
app.use((err, req, res, _next) => {
  console.error('Unhandled middleware error:', err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: err.message || String(err) });
});

// Keep the process from crashing silently
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

app.listen(PORT, () => console.log(`OrdoLux Email→PDF listening on ${PORT}`));
