// server.cjs
// OrdoLux email -> PDF microservice (CommonJS)
// - Parses .eml locally (mailparser)
// - Parses .msg via Python (extract_msg) -> JSON
// - Renders a clean "cover" PDF with headers + body text
// - Shows inline images (cid:/data: + best-effort http/https fetch)
// - Merges any attached PDFs after the cover
// - No OrdoLux mark/header

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { simpleParser } = require('mailparser');
const PDFDocument = require('pdfkit');
const cheerio = require('cheerio');
const fetch = require('node-fetch'); // v2 (CommonJS-friendly)
const { PDFDocument: PDFLib } = require('pdf-lib');

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.ORDOLUX_CONVERTER_SECRET || process.env.ORDOLUX_SECRET || process.env.SHARED_SECRET || 'dev-secret';
const MAX_BYTES = parseInt(process.env.MAX_BYTES || '26214400', 10); // 25 MB default

const app = express();
app.use(express.json({ limit: '50mb' })); // accept big base64 payloads

// ---- utils
function bad(res, code, msg, extra = {}) {
  return res.status(code).json({ ok: false, error: msg, ...extra });
}

function okJson(res, data) {
  return res.status(200).json({ ok: true, ...data });
}

function ensureSecret(req, res) {
  const s = req.headers['x-ordolux-secret'];
  if (!s || s !== SHARED_SECRET) {
    bad(res, 401, 'unauthorized');
    return false;
  }
  return true;
}

function isPdfAttachment(att) {
  const name = (att.filename || '').toLowerCase();
  const ct = (att.contentType || '').toLowerCase();
  return name.endsWith('.pdf') || ct === 'application/pdf';
}

function decodeBase64ToBuffer(b64) {
  return Buffer.from(b64, 'base64');
}

function bytesFromDataUri(uri) {
  // data:[<mediatype>][;base64],<data>
  const m = /^data:([^;]+);base64,(.*)$/i.exec(uri || '');
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch { return null; }
}

async function fetchRemoteImage(url, timeoutMs = 3000) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const buf = await r.buffer();
    if (buf.length > 0 && buf.length < 15 * 1024 * 1024) return buf; // guardrails
    return null;
  } catch { return null; }
}

function cleanNameEmail(str) {
  if (!str) return '';
  // Split common separators ; ,  (but preserve quoted commas)
  const parts = str
    .split(/;+/)
    .map(s => s.trim())
    .filter(Boolean)
    .flatMap(s => s.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) // comma not inside quotes
    .map(s => s.trim())
    .filter(Boolean);

  const OUT = [];
  for (const p of parts) {
    // Try name <email>
    let m = /^(.*?)\s*<([^>]+)>$/.exec(p);
    if (m) {
      const name = m[1].replace(/^"|"$/g, '').trim();
      const email = m[2].trim();
      OUT.push(name ? `${name} <${email}>` : email);
      continue;
    }
    // Try bare email
    m = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.exec(p);
    if (m) { OUT.push(m[1]); continue; }
    // Fallback: as-is (some Exchange encoded display names)
    OUT.push(p);
  }
  return OUT.join('; ');
}

function toPlainTextFromHtml($, root) {
  // Extract readable text with line breaks
  const lines = [];
  const walk = (el) => {
    if (el.type === 'text') {
      const t = (el.data || '').replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
      return;
    }
    if (el.name === 'br' || el.name === 'p' || el.name === 'div' || el.name === 'li') {
      lines.push('\n');
    }
    if (el.children) el.children.forEach(walk);
  };
  root.children().each((_, node) => walk(node));
  return lines.join(' ').replace(/\n\s*\n\s*\n+/g, '\n\n');
}

function drawWrappedText(doc, text, opts = {}) {
  doc.fontSize(opts.fontSize || 11).fillColor(opts.color || '#000000');
  doc.text(text, { width: 500, lineGap: 2 });
}

async function renderEmailToPdfBuffer(parsed) {
  // parsed: { headers{from,to,cc,bcc,subject,date}, html?, text?, attachments[] }
  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  // -------- Cover (no branding)
  const H = parsed.headers || {};
  const subject = H.subject || '(no subject)';
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#000000').text(subject, { width: 500 });
  doc.moveDown(0.6);

  const hdrs = [
    ['From', cleanNameEmail(H.from || '')],
    ['To', cleanNameEmail(H.to || '')],
    ...(H.cc ? [['Cc', cleanNameEmail(H.cc)]] : []),
    ...(H.bcc ? [['Bcc', cleanNameEmail(H.bcc)]] : []),
    ...(H.date ? [['Date', String(H.date)]] : []),
  ];

  doc.font('Helvetica').fontSize(9).fillColor('#333333');
  hdrs.forEach(([label, val]) => {
    doc.text(`${label}: `, { continued: true }).font('Helvetica').fontSize(10).fillColor('#000000').text(val);
    doc.font('Helvetica').fontSize(9).fillColor('#333333');
  });

  doc.moveDown(0.6);
  doc.strokeColor('#dddddd').moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.6);

  // ---------- Body (prefer HTML with images)
  const html = parsed.html && parsed.html.trim() ? parsed.html : null;
  const text = parsed.text && parsed.text.trim() ? parsed.text : null;

  const attByCid = new Map(); // cid -> Buffer
  (parsed.attachments || []).forEach((a) => {
    if (a.isInline && a.contentId && a.data) {
      attByCid.set(String(a.contentId).replace(/^<|>$/g, ''), a.data);
    }
  });

  if (html) {
    const $ = cheerio.load(html, { decodeEntities: true });
    const $body = $('body').length ? $('body') : $.root();

    // Replace <img src="cid:..."> with buffers; for others try data: or http(s)
    const blocks = []; // sequence of {type:'text'|'image', data:...}
    // Build text from HTML but insert image blocks where they occur
    $body.find('img').each((_, img) => {
      const $img = $(img);
      // Insert a marker node before image to help split text
      $img.before('<--IMG-MARKER-->');
    });

    const bodyHtml = $body.html() || '';
    const parts = bodyHtml.split('<--IMG-MARKER-->');

    // Collect <img> elements in order
    const imgs = $body.find('img').toArray();

    for (let i = 0; i < parts.length; i++) {
      // Text part
      const $frag = cheerio.load(parts[i] || '');
      const txt = toPlainTextFromHtml($frag, $frag.root());
      if (txt.trim()) blocks.push({ type: 'text', text: txt.trim() });

      // Image part (if any)
      if (i < imgs.length) {
        const node = imgs[i];
        const src = ($(node).attr('src') || '').trim();
        let buf = null;

        if (/^cid:/i.test(src)) {
          const key = src.replace(/^cid:/i, '').replace(/^<|>$/g, '');
          buf = attByCid.get(key) || null;
        } else if (/^data:/i.test(src)) {
          buf = bytesFromDataUri(src);
        } else if (/^https?:\/\//i.test(src)) {
          // best-effort remote fetch
          /* eslint-disable no-await-in-loop */
          buf = await fetchRemoteImage(src, 3000);
        }

        if (buf && buf.length > 0) {
          blocks.push({ type: 'image', data: buf });
        }
      }
    }

    // Render blocks
    for (const b of blocks) {
      if (b.type === 'text') {
        drawWrappedText(doc, b.text, { fontSize: 11 });
        doc.moveDown(0.4);
      } else if (b.type === 'image') {
        try {
          // keep within page width; PDFKit will scale when fit is provided
          doc.moveDown(0.2);
          doc.image(b.data, {
            fit: [doc.page.width - doc.page.margins.left - doc.page.margins.right, 420]
          });
          doc.moveDown(0.5);
        } catch {
          // ignore bad image data
        }
      }
    }
  } else if (text) {
    drawWrappedText(doc, text, { fontSize: 11 });
  } else {
    drawWrappedText(doc, '(no body)', { fontSize: 11, color: '#666666' });
  }

  doc.end();
  return done;
}

async function mergePdfBuffers(buffers) {
  if (!buffers.length) return null;
  const merged = await PDFLib.create();
  for (const buf of buffers) {
    try {
      const src = await PDFLib.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch {
      // skip bad PDFs
    }
  }
  return Buffer.from(await merged.save());
}

// ---- parsers
async function parseEml(buffer) {
  const mail = await simpleParser(buffer);
  const headers = {
    from: mail.from && mail.from.text || '',
    to: mail.to && mail.to.text || '',
    cc: mail.cc && mail.cc.text || '',
    bcc: mail.bcc && mail.bcc.text || '',
    subject: mail.subject || '',
    date: mail.date ? mail.date.toISOString() : '',
    message_id: mail.messageId || ''
  };

  const attachments = (mail.attachments || []).map(a => ({
    filename: a.filename || 'attachment',
    contentId: a.cid || null,
    contentType: a.contentType || '',
    size: a.content ? a.content.length : 0,
    isInline: !!a.cid,
    data: a.content || null
  }));

  return {
    headers,
    html: mail.html || '',
    text: mail.text || '',
    attachments
  };
}

async function parseMsg(buffer) {
  const tmp = path.join(os.tmpdir(), `upl-${Date.now()}-${Math.random().toString(36).slice(2)}.msg`);
  fs.writeFileSync(tmp, buffer);
  try {
    const json = await new Promise((resolve, reject) => {
      execFile(process.env.PYTHON || 'python3', [path.join(__dirname, 'msg_to_json.py'), tmp], { timeout: 20000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || String(err)));
        resolve(stdout);
      });
    });

    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(`python-json-parse-failed: ${e.message}`);
    }

    if (!parsed || parsed.ok === false) {
      throw new Error(parsed && parsed.error ? parsed.error : 'python returned error');
    }

    // Convert attachments data_b64 -> Buffer
    const attachments = (parsed.attachments || []).map(a => ({
      filename: a.filename || 'attachment',
      contentId: a.contentId || null,
      contentType: a.contentType || '',
      size: a.size || 0,
      isInline: !!a.isInline,
      data: a.data_b64 ? decodeBase64ToBuffer(a.data_b64) : null
    }));

    return {
      headers: parsed.headers || {},
      html: parsed.html || '',
      text: parsed.text || '',
      attachments
    };
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ---- routes
app.get('/healthz', (req, res) => {
  if (!ensureSecret(req, res)) return;
  res.json({ ok: true });
});

app.post('/convert', async (req, res) => {
  if (!ensureSecret(req, res)) return;

  try {
    const accept = String(req.headers['accept'] || '').toLowerCase();
    const asPdf = accept.includes('application/pdf');

    const { fileBase64, filename, options } = req.body || {};
    if (!fileBase64 || !filename) {
      return bad(res, 422, 'fileBase64 and filename required');
    }
    const bin = decodeBase64ToBuffer(fileBase64);
    if (!bin || !bin.length) return bad(res, 422, 'empty file');
    if (bin.length > MAX_BYTES) return bad(res, 413, `file too large (>${MAX_BYTES} bytes)`);

    const isMsg = /\.msg$/i.test(filename);
    const isEml = /\.eml$/i.test(filename);

    let parsed;
    if (isEml) parsed = await parseEml(bin);
    else if (isMsg) parsed = await parseMsg(bin);
    else {
      // Guess by sniffing
      if (bin.slice(0, 8).toString('utf8').toLowerCase().includes('from:')) parsed = await parseEml(bin);
      else parsed = await parseMsg(bin);
    }

    // Build email PDF
    const emailPdf = await renderEmailToPdfBuffer(parsed);

    // Merge PDF attachments if requested
    const mergeAttachments = options && options.mergeAttachments === true;
    let finalPdf = emailPdf;

    if (mergeAttachments) {
      const pdfAtts = (parsed.attachments || []).filter(isPdfAttachment).map(a => a.data).filter(Boolean);
      if (pdfAtts.length) {
        const merged = await mergePdfBuffers([emailPdf, ...pdfAtts]);
        if (merged) finalPdf = merged;
      }
    }

    if (asPdf) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(filename, path.extname(filename))}.pdf"`);
      return res.status(200).send(finalPdf);
    }

    // JSON debug path
    return okJson(res, {
      headers: parsed.headers,
      hasHtml: !!(parsed.html && parsed.html.trim()),
      textPreview: (parsed.text || '').slice(0, 4000),
      attachments: (parsed.attachments || []).map(a => ({
        filename: a.filename,
        contentId: a.contentId,
        contentType: a.contentType,
        size: a.size,
        isInline: a.isInline,
        isPdf: isPdfAttachment(a)
      }))
    });
  } catch (e) {
    return bad(res, 500, String(e && e.message ? e.message : e));
  }
});

// ---- start
app.listen(PORT, () => {
  console.log(`OrdoLux email->PDF listening on :${PORT}`);
});
