import express from 'express';
import crypto from 'crypto';
import { jsPDF } from 'jspdf';
import { simpleParser } from 'mailparser';
import MsgReader from 'msgreader';
import he from 'he';
import { PDFDocument } from 'pdf-lib';

const app = express();
app.use(express.json({ limit: '25mb' })); // supports big base64 payloads

// ---------------- Auth ----------------
const SHARED_SECRET = process.env.SHARED_SECRET || 'dev-secret';

// Optional HMAC header names, keep both for easier client tests
const SIG_HEX = 'x-ordolux-signature';          // e.g. sha256=<hex>
const SIG_B64 = 'x-ordolux-signature-base';     // e.g. sha256_b64=<b64>
const SECRET_HDR = 'x-ordolux-secret';          // raw shared secret

function verify(req, rawBody) {
  // 1) shared-secret must match
  const s = req.headers[SECRET_HDR] || '';
  if (s !== SHARED_SECRET) return false;

  // 2) if a signature is provided, accept when valid (but don’t require)
  const hmac = crypto.createHmac('sha256', SHARED_SECRET);
  hmac.update(rawBody);
  const hex = 'sha256=' + hmac.digest('hex');

  if (req.headers[SIG_HEX] && req.headers[SIG_HEX] !== hex) {
    // Try b64 variant if sent
    if (req.headers[SIG_B64]) {
      const hmac2 = crypto.createHmac('sha256', SHARED_SECRET);
      hmac2.update(rawBody);
      const b64 = 'sha256_b64=' + hmac2.digest('base64');
      if (req.headers[SIG_B64] !== b64) return false;
    } else {
      return false;
    }
  }
  return true;
}

// Raw body capture for HMAC
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path !== '/convert') return next();
  let buf = Buffer.alloc(0);
  req.on('data', (chunk) => (buf = Buffer.concat([buf, chunk])));
  req.on('end', () => {
    req.rawBody = buf;
    try {
      req.body = JSON.parse(buf.toString('utf8'));
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }
    next();
  });
});

// ---------------- Utilities ----------------
function isPlaceholder(htmlOrText) {
  const s = stripHtml(htmlOrText).toLowerCase();
  return s.includes('converted from outlook') && s.includes('open the original message in outlook');
}
function stripHtml(html = '') {
  let s = String(html);
  s = s.replace(/<\s*script[\s\S]*?<\/\s*script\s*>/gi, '');
  s = s.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, '');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/\s*(p|div|li)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = he.decode(s);
  s = s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}
function rtfToText(rtf) {
  try {
    let s = String(rtf || '');
    s = s.replace(/\\'[0-9a-fA-F]{2}/g, m => String.fromCharCode(parseInt(m.slice(2), 16)));
    s = s.replace(/\\par[d]?/g, '\n').replace(/\\tab/g, '\t');
    s = s.replace(/\\[a-zA-Z]+\d* ?/g, '').replace(/[{}]/g, '');
    return s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  } catch { return ''; }
}
function quality(t) {
  const s = String(t || '').trim();
  if (!s) return '';
  if (/ÿ{10,}/.test(s)) return '';
  const letters = (s.match(/[A-Za-z0-9]/g) || []).length;
  if (letters / s.length < 0.06) return '';
  return s;
}
function renderEmailPDF({ title, meta, bodyText }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const m = 40, width = 595.28 - m * 2;
  let y = m;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  y = addWrapped(doc, title || '(no subject)', m, y, width, 20);

  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  for (const k of ['From', 'To', 'Cc', 'Date']) {
    const v = meta[k];
    if (v && String(v).trim()) y = addWrapped(doc, `${k}: ${v}`, m, y, width, 16);
  }
  doc.setLineWidth(0.5); doc.line(m, y + 5, m + width, y + 5); y += 20;

  doc.setFontSize(12);
  y = addWrapped(doc, String(bodyText || '').slice(0, 500000), m, y, width, 16);
  return doc.output('arraybuffer');
}
function addWrapped(doc, text, x, y, maxWidth, lineHeight) {
  const lines = doc.splitTextToSize(text || '', maxWidth);
  for (const ln of lines) {
    if (y > 800) { doc.addPage(); y = 40; }
    doc.text(ln, x, y);
    y += lineHeight;
  }
  return y;
}
async function mergePdfBytes(mainPdfBytes, pdfBytesArray) {
  const out = await PDFDocument.create();
  const mainDoc = await PDFDocument.load(mainPdfBytes);
  const mainPages = await out.copyPages(mainDoc, mainDoc.getPageIndices());
  mainPages.forEach(p => out.addPage(p));

  for (const b of pdfBytesArray) {
    try {
      const d = await PDFDocument.load(b);
      const pages = await out.copyPages(d, d.getPageIndices());
      pages.forEach(p => out.addPage(p));
    } catch { /* skip bad pdf */ }
  }
  return await out.save();
}

// ---------------- Parsers ----------------
async function parseEML(buffer) {
  const parsed = await simpleParser(buffer);
  const meta = {
    Subject: parsed.subject || '',
    From: parsed.from?.text || '',
    To: parsed.to?.text || '',
    Cc: parsed.cc?.text || '',
    Date: parsed.date ? new Date(parsed.date).toISOString() : ''
  };

  let bodyHtml = parsed.html || '';
  let bodyText = parsed.text || '';

  let text = bodyText || stripHtml(bodyHtml);
  if (isPlaceholder(bodyHtml || bodyText)) text = '';

  const atts = [];
  for (const a of parsed.attachments || []) {
    atts.push({
      filename: a.filename || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      bytes: a.content // Buffer
    });
  }
  return { meta, text: quality(text), attachments: atts };
}

function parseMSG(buffer) {
  const mr = new MsgReader(buffer);
  const data = mr.getFileData();

  const from =
    (data.senderName || '') +
    (data.senderEmail ? ` <${data.senderEmail}>` : '');

  let to = '';
  if (Array.isArray(data.recipients)) {
    const arr = data.recipients.map(r => (r.name || '') + (r.email ? ` <${r.email}>` : '')).filter(Boolean);
    to = arr.join(', ');
  }

  const meta = {
    Subject: data.subject || data.headers?.subject || '',
    From: from.trim(),
    To: to,
    Cc: '',
    Date: data.headers?.date || ''
  };

  const html = data.bodyHTML || '';
  const plain = data.body || '';
  const rtf = data.bodyRTF || '';
  let text = plain || stripHtml(html) || (rtf.startsWith('{\\rtf') ? rtfToText(rtf) : '');

  if (isPlaceholder(html || plain)) text = '';

  // attachments (get raw bytes via getAttachment)
  const atts = [];
  if (typeof mr.getAttachment === 'function' && Array.isArray(data.attachments)) {
    for (let i = 0; i < data.attachments.length; i++) {
      const raw = mr.getAttachment(i); // { fileName, content: Uint8Array }
      if (raw?.content?.byteLength) {
        atts.push({
          filename: raw.fileName || 'attachment',
          contentType: guessType(raw.fileName),
          bytes: Buffer.from(raw.content.buffer, raw.content.byteOffset, raw.content.byteLength)
        });
      }
    }
  }
  return { meta, text: quality(text), attachments: atts };
}

function guessType(name = '') {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.txt')) return 'text/plain';
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'text/html';
  if (n.endsWith('.eml')) return 'message/rfc822';
  if (n.endsWith('.msg')) return 'application/vnd.ms-outlook';
  return 'application/octet-stream';
}

// ---------------- Routes ----------------
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/convert', async (req, res) => {
  try {
    if (!verify(req, req.rawBody)) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }

    const { fileBase64, fileUrl, filename = 'Email', options = {} } = req.body || {};
    let bytes;

    if (fileBase64) {
      bytes = Buffer.from(fileBase64, 'base64');
    } else if (fileUrl) {
      const r = await fetch(fileUrl, { redirect: 'follow' });
      if (!r.ok) return res.status(400).json({ ok: false, error: `Download ${r.status}` });
      const ab = await r.arrayBuffer();
      bytes = Buffer.from(ab);
    } else {
      return res.status(400).json({ ok: false, error: 'Missing fileBase64 or fileUrl' });
    }

    const lower = (filename || '').toLowerCase();
    let parsed;
    if (lower.endsWith('.eml')) parsed = await parseEML(bytes);
    else if (lower.endsWith('.msg')) parsed = parseMSG(bytes);
    else {
      // best effort: try EML first, then MSG
      try { parsed = await parseEML(bytes); } catch { parsed = parseMSG(bytes); }
    }

    if (!parsed || !parsed.text) {
      return res.status(422).json({
        ok: false,
        error: 'No safe human-readable body found',
      });
    }

    // 1) render the email body
    const bodyPdf = renderEmailPDF({
      title: parsed.meta.Subject || '(no subject)',
      meta: { From: parsed.meta.From || '', To: parsed.meta.To || '', Cc: parsed.meta.Cc || '', Date: parsed.meta.Date || '' },
      bodyText: parsed.text
    });

    let finalPdfBytes = Buffer.from(bodyPdf);

    // 2) merge PDF attachments if requested
    if (options.mergeAttachments && parsed.attachments?.length) {
      const pdfParts = parsed.attachments
        .filter(a => (a.contentType || '').toLowerCase() === 'application/pdf' || a.filename?.toLowerCase().endsWith('.pdf'))
        .map(a => a.bytes);

      if (pdfParts.length) {
        finalPdfBytes = Buffer.from(await mergePdfBytes(finalPdfBytes, pdfParts));
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    // stream back
    return res.status(200).end(finalPdfBytes);

  } catch (err) {
    console.error(err);
    const wantsJson = (req.headers['accept'] || '').includes('application/json');
    const msg = String(err?.message || err);
    return wantsJson
      ? res.status(500).json({ ok: false, error: msg })
      : res.status(500).end(msg);
  }
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Email→PDF service listening on ' + PORT));
