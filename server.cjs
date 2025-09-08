/* OrdoLux Email→PDF Service (Unicode-safe + image scaling)
   - Fixes WinAnsi encoding errors (U+200B etc.) by embedding DejaVu Sans
   - Strips zero-width and NBSP-like characters defensively
   - Collapses whitespace in headers (tabs/newlines)
   - Scales inline images to page width, keeps aspect ratio
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
app.use(express.json({ limit: '30mb' }));

// Where Debian puts DejaVu Sans on slim images:
const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
let DEJAVU_BYTES = null;
try {
  DEJAVU_BYTES = fs.readFileSync(DEJAVU);
} catch (_) {
  // As a fallback, try sibling path if ever needed; otherwise we’ll throw on first use.
}

function okSecret(req) {
  return SECRET ? req.header('X-Ordolux-Secret') === SECRET : true;
}

app.get('/healthz', (req, res) => {
  if (!okSecret(req)) return res.status(401).send('unauthorized');
  return res.json({ ok: true });
});

// ---------- Helpers ----------
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;        // ZWSP, ZWNJ, ZWJ, BOM
const NBSP      = /\u00A0/g;
const CTRL_MISC = /[\u2028\u2029]/g;               // line sep, paragraph sep

function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(ZERO_WIDTH, '')
    .replace(NBSP, ' ')
    .replace(CTRL_MISC, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function oneLine(s) {
  return cleanText(s).replace(/\s+/g, ' ').trim();
}

function fmtHeaderList(v) {
  if (!v) return '';
  // Accept either array of strings or a single string
  if (Array.isArray(v)) return oneLine(v.join(', '));
  return oneLine(v);
}

function bytesFromBase64(b64) {
  return Buffer.from(b64, 'base64');
}

function isImage(att) {
  const t = (att.contentType || att.mimeType || '').toLowerCase();
  return t.startsWith('image/');
}

// Try to unify attachment object shapes from .eml and .msg paths
function normalizeAttachment(att) {
  return {
    filename: att.filename || att.name || 'image',
    contentType: att.contentType || att.mimeType || '',
    contentId: att.contentId || att.cid || null,
    dataBase64:
      att.dataBase64 || att.data_b64 || att.dataB64 || // msg_to_json.py possibilities
      (att.content ? Buffer.from(att.content).toString('base64') : null)
  };
}

// Extract a minimal message model we can render
function toRenderModel(parsed) {
  const m = parsed.message || parsed; // accept either shape
  return {
    from: fmtHeaderList(m.from),
    to: fmtHeaderList(m.to),
    cc: fmtHeaderList(m.cc),
    subject: cleanText(m.subject || '(no subject)'),
    date: m.date ? new Date(m.date).toISOString() : '',
    // Prefer HTML->text fallback; we don’t attempt full HTML layout — we render text blocks + images.
    bodyText: cleanText(m.body_text || m.text || he.decode((m.body_html || m.html || '').replace(/<[^>]+>/g, ' '))),
    attachments: Array.isArray(m.attachments) ? m.attachments.map(normalizeAttachment) : []
  };
}

// Simple text wrapper
function wrapLines(font, size, text, maxWidth) {
  const words = text.split(/(\s+)/); // keep spaces as tokens
  const lines = [];
  let current = '';
  for (const tok of words) {
    const trial = current + tok;
    const width = font.widthOfTextAtSize(trial, size);
    if (width <= maxWidth || current.length === 0) {
      current = trial;
    } else {
      lines.push(current.trimEnd());
      current = tok.trimStart();
    }
  }
  if (current) lines.push(current.trimEnd());

  // Also split on explicit newlines
  return lines
    .join('\n')
    .split('\n')
    .map(l => l.trimEnd());
}

async function renderPdfFromParsed(parsed, opts = {}) {
  if (!DEJAVU_BYTES) throw new Error('Unicode font not found (DejaVu Sans).');
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(DEJAVU_BYTES, { subset: true });

  const pageMargin = 40;
  const pageWidth = 595.28;  // A4 width (pt)
  const pageHeight = 841.89; // A4 height
  let page = pdfDoc.addPage([pageWidth, pageHeight]);

  const headerSize = 12;
  const bodySize = 11;
  const lineGap = 4;
  const maxWidth = pageWidth - 2 * pageMargin;
  let y = pageHeight - pageMargin;

  function drawLine(txt, size = bodySize) {
    txt = cleanText(txt);
    if (!txt) return;
    const lines = wrapLines(font, size, txt, maxWidth);
    for (const l of lines) {
      const h = font.heightAtSize(size);
      if (y - h < pageMargin) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        y = pageHeight - pageMargin;
      }
      page.drawText(l, { x: pageMargin, y: y - h, size, font, color: rgb(0, 0, 0) });
      y -= h + lineGap;
    }
  }

  function drawSpacer(px = 8) {
    y -= px;
    if (y < pageMargin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - pageMargin;
    }
  }

  async function drawImage(att) {
    if (!att || !att.dataBase64) return;
    const bin = bytesFromBase64(att.dataBase64);
    let image;
    const ct = (att.contentType || '').toLowerCase();
    if (ct.includes('png')) {
      image = await pdfDoc.embedPng(bin);
    } else if (ct.includes('jpg') || ct.includes('jpeg')) {
      image = await pdfDoc.embedJpg(bin);
    } else if (ct.includes('gif')) {
      // pdf-lib doesn’t embed GIF natively; skip quietly.
      return;
    } else {
      return;
    }
    const w = image.width;
    const h = image.height;
    const scale = Math.min(1, (maxWidth) / w);
    const drawW = w * scale;
    const drawH = h * scale;

    if (y - drawH < pageMargin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - pageMargin;
    }
    page.drawImage(image, {
      x: pageMargin,
      y: y - drawH,
      width: drawW,
      height: drawH
    });
    y -= drawH + 8;
  }

  const m = toRenderModel(parsed);

  // Header (no branding)
  drawLine(`From: ${m.from}`, headerSize);
  if (m.to) drawLine(`To: ${m.to}`, headerSize);
  if (m.cc) drawLine(`Cc: ${m.cc}`, headerSize);
  if (m.date) drawLine(`Date: ${m.date}`, headerSize);
  drawLine(`Subject: ${m.subject}`, headerSize);
  drawSpacer(10);

  // Body
  drawLine(m.bodyText, bodySize);
  drawSpacer(6);

  // Inline images / attachments (scaled)
  if (opts.mergeAttachments !== false && m.attachments?.length) {
    for (const a of m.attachments) {
      if (isImage(a)) {
        await drawImage(a);
      }
    }
  }

  return await pdfDoc.save();
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
  // Call Python helper (extract_msg) to normalize .msg to JSON
  return new Promise((resolve, reject) => {
    const py = spawn('/opt/pyenv/bin/python3', [path.join(__dirname, 'msg_to_json.py'), tmpPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    py.stdout.on('data', d => (out += d.toString('utf8')));
    py.stderr.on('data', d => (err += d.toString('utf8')));
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `msg_to_json exited ${code}`));
      try {
        const json = JSON.parse(out);
        resolve(json);
      } catch (e) {
        reject(new Error(`Bad JSON from msg_to_json: ${e.message}\n${out}`));
      }
    });
  });
}

// ---------- Route ----------
app.post('/convert', async (req, res) => {
  try {
    if (!okSecret(req)) return res.status(401).json({ error: 'unauthorized' });

    const { fileBase64, filename, options } = req.body || {};
    if (!fileBase64 || !filename) {
      return res.status(422).json({ error: 'fileBase64 and filename are required' });
    }

    // Write upload to temp
    const ext = path.extname(filename).toLowerCase();
    const tmpPath = path.join('/tmp', `upl-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tmpPath, bytesFromBase64(fileBase64));
    let parsed;

    try {
      if (ext === '.eml') parsed = await parseEML(tmpPath);
      else if (ext === '.msg') parsed = await parseMSG(tmpPath);
      else return res.status(415).json({ error: `unsupported file type: ${ext}` });
    } finally {
      // best-effort cleanup
      fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath);
    }

    // Optional concise debug (stays small)
    if (options && options.debugRender) {
      return res.json({
        render_ok: true,
        parsed: {
          meta: parsed.meta,
          message: {
            from: oneLine(parsed.message.from),
            to: oneLine(parsed.message.to),
            cc: oneLine(parsed.message.cc),
            subject: oneLine(parsed.message.subject),
            html_length: (parsed.message.body_html || '').length,
            attach_count: (parsed.message.attachments || []).length
          }
        }
      });
    }

    const pdfBytes = await renderPdfFromParsed(parsed, { mergeAttachments: options?.mergeAttachments !== false });
    res.setHeader('Content-Type', 'application/pdf');
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    // Return concise JSON error (no giant HTML)
    res.status(500).json({
      render_ok: false,
      error: e.message,
      stack: (e.stack || '').split('\n').slice(0, 8)
    });
  }
});

app.listen(PORT, () => {
  console.log(`OrdoLux email→PDF listening on ${PORT}`);
});
