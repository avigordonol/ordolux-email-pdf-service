import express from 'express';
import crypto from 'crypto';
import { jsPDF } from 'jspdf';
import { simpleParser } from 'mailparser';
import MsgReader from 'msgreader';
import he from 'he';
import { PDFDocument } from 'pdf-lib';

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Auth ----------
const SHARED_SECRET = process.env.SHARED_SECRET || 'dev-secret';
const SECRET_HDR = 'x-ordolux-secret';
const SIG_HEX = 'x-ordolux-signature';          // sha256=<hex>
const SIG_B64 = 'x-ordolux-signature-base';     // sha256_b64=<base64>

function verify(req, rawBody) {
  // Require the shared secret
  const s = req.headers[SECRET_HDR] || '';
  if (s !== SHARED_SECRET) return false;

  // If a signature header is provided, ensure it matches; otherwise allow
  if (req.headers[SIG_HEX] || req.headers[SIG_B64]) {
    const h = crypto.createHmac('sha256', SHARED_SECRET).update(rawBody).digest();
    const hex = 'sha256=' + h.toString('hex');
    const b64 = 'sha256_b64=' + h.toString('base64');

    if (req.headers[SIG_HEX] && req.headers[SIG_HEX] !== hex) return false;
    if (req.headers[SIG_B64] && req.headers[SIG_B64] !== b64) return false;
  }
  return true;
}

// ---------- Body parsing (order matters!) ----------
// 1) Capture raw body for /convert (so HMAC works)
app.use('/convert', express.raw({ type: '*/*', limit: '25mb' }), (req, res, next) => {
  req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  try {
    req.body = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }
  next();
});

// 2) Normal JSON parser for other routes
app.use(express.json({ limit: '1mb' }));

// ---------- Small helpers ----------
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
function isPlaceholder(t) {
  const s = stripHtml(t || '').toLowerCase();
  return s.includes('converted from outlook') && s.includes('open the original message');
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
async function mergePdfBytes(mainPdf, others) {
  const out = await PDFDocument.create();
  const first = await PDFDocument.load(mainPdf);
  const pages = await out.copyPages(first, first.getPageIndices());
  pages.forEach(p => out.addPage(p));
  for (const b of others) {
    try {
      const d = await PDFDocument.load(b);
      const ps = await out.copyPages(d, d.getPageIndices());
      ps.forEach(p => out.addPage(p));
    } catch { /* skip bad pdf */ }
  }
  return await out.save();
}
function guessType(name = '') {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.eml')) return 'message/rfc822';
  if (n.endsWith('.msg')) return 'application/vnd.ms-outlook';
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'text/html';
  if (n.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

// ---------- Parsers ----------
async function parseEML(buf) {
  const p = await simpleParser(buf);
  const meta = {
    Subject: p.subject || '',
    From: p.from?.text || '',
    To: p.to?.text || '',
    Cc: p.cc?.text || '',
    Date: p.date ? new Date(p.date).toISOString() : ''
  };
  const html = p.html || '';
  const plain = p.text || '';
  let text = plain || stripHtml(html);
  if (isPlaceholder(html || plain)) text = '';

  const attachments = (p.attachments || []).map(a => ({
    filename: a.filename || 'attachment',
    contentType: a.contentType || 'application/octet-stream',
    bytes: Buffer.from(a.content)
  }));
  return { meta, text: quality(text), attachments };
}
function parseMSG(buf) {
  const mr = new MsgReader(buf);
  const data = mr.getFileData();

  const from =
    (data.senderName || '') + (data.senderEmail ? ` <${data.senderEmail}>` : '');
  const to = Array.isArray(data.recipients)
    ? data.recipients
        .map(r => (r.name || '') + (r.email ? ` <${r.email}>` : ''))
        .filter(Boolean)
        .join(', ')
    : '';

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

  const attachments = [];
  if (typeof mr.getAttachment === 'function' && Array.isArray(data.attachments)) {
    for (let i = 0; i < data.attachments.length; i++) {
      const raw = mr.getAttachment(i); // { fileName, content: Uint8Array }
      if (raw?.content?.byteLength) {
        attachments.push({
          filename: raw.fileName || 'attachment',
          contentType: guessType(raw.fileName),
          bytes: Buffer.from(raw.content.buffer, raw.content.byteOffset, raw.content.byteLength)
        });
      }
    }
  }
  return { meta, text: quality(text), attachments };
}

// ---------- Routes ----------
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/convert', async (req, res) => {
  try {
    if (!verify(req, req.rawBody || Buffer.alloc(0))) {
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
    else { try { parsed = await parseEML(bytes); } catch { parsed = parseMSG(bytes); } }

    if (!parsed || !parsed.text) {
      return res.status(422).json({ ok: false, error: 'No safe human-readable body found' });
    }

    // Email body → PDF
    const bodyPdf = Buffer.from(
      renderEmailPDF({
        title: parsed.meta.Subject || '(no subject)',
        meta: { From: parsed.meta.From || '', To: parsed.meta.To || '', Cc: parsed.meta.Cc || '', Date: parsed.meta.Date || '' },
        bodyText: parsed.text
      })
    );

    let outPdf = bodyPdf;

    // Merge PDF attachments if requested
    if (options.mergeAttachments && parsed.attachments?.length) {
      const pdfs = parsed.attachments
        .filter(a => (a.contentType || '').toLowerCase() === 'application/pdf' || (a.filename || '').toLowerCase().endsWith('.pdf'))
        .map(a => a.bytes);

      if (pdfs.length) outPdf = Buffer.from(await mergePdfBytes(outPdf, pdfs));
    }

    res.setHeader('Content-Type', 'application/pdf');
    return res.status(200).end(outPdf);
  } catch (e) {
    console.error(e);
    const wantsJson = (req.headers['accept'] || '').includes('application/json');
    const msg = String(e?.message || e);
    return wantsJson ? res.status(500).json({ ok: false, error: msg }) : res.status(500).end(msg);
  }
});

// ---------- Start ----------
app.listen(PORT, () => console.log('Email→PDF service listening on ' + PORT));
