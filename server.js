// server.js — Safe EML converter + graceful MSG 422
// ESM-compatible (package.json has "type":"module")

import express from 'express';
import PDFDocument from 'pdfkit';
import { simpleParser } from 'mailparser';

// --- config/secrets ---
const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET; // set in Railway env

// --- app ---
const app = express();
// allow big-ish emails; adjust if needed
app.use(express.json({ limit: '25mb' }));

// small helper
function wantPdf(req) {
  const a = (req.headers['accept'] || '').toLowerCase();
  return a.includes('application/pdf');
}

function errJson(res, status, msg, extra = {}) {
  return res.status(status).json({ ok: false, error: msg, ...extra });
}

app.get('/healthz', (req, res) => {
  if (SHARED_SECRET && req.headers['x-ordolux-secret'] !== SHARED_SECRET) {
    return errJson(res, 401, 'unauthorized');
  }
  res.json({ ok: true });
});

// --- /convert ---
// Accepts:
//  { fileBase64: <base64>, filename: "name.eml" | "name.msg", options?: { mergeAttachments?: boolean } }
// Returns:
//  - PDF binary when Accept: application/pdf (EML only in this build)
//  - JSON {ok:false,...} errors for invalid/MSG/etc.
app.post('/convert', async (req, res) => {
  try {
    // auth
    if (SHARED_SECRET && req.headers['x-ordolux-secret'] !== SHARED_SECRET) {
      return errJson(res, 401, 'Invalid secret');
    }

    const { fileBase64, filename = '', options = {} } = req.body || {};
    if (!fileBase64 || !filename) {
      return errJson(res, 400, 'Missing fileBase64 or filename');
    }

    // basic filename checks
    const lower = String(filename).toLowerCase().trim();
    const isEML = lower.endsWith('.eml');
    const isMSG = lower.endsWith('.msg');

    // For now, MSG is not enabled in this image — return clean 422 (no crash)
    if (isMSG) {
      return errJson(res, 422,
        'MSG not enabled in this build. The service supports EML now. ' +
        'We can enable MSG next via a Python-backed parser, or you can upload the MIME (.eml) form.');
    }

    if (!isEML) {
      return errJson(res, 400, 'Unsupported extension; send .eml (or .msg once enabled).');
    }

    // decode base64
    let raw;
    try {
      raw = Buffer.from(fileBase64, 'base64');
    } catch {
      return errJson(res, 400, 'Invalid base64');
    }

    // parse EML
    let mail;
    try {
      mail = await simpleParser(raw);
    } catch (e) {
      return errJson(res, 422, 'Failed to parse EML', { detail: String(e?.message || e) });
    }

    // pick a body
    const textBody = (mail.text || '').trim();
    const htmlBody = (mail.html && typeof mail.html === 'string') ? mail.html : '';
    const body = textBody || stripHtml(htmlBody) || '(no body)';

    // render to PDF
    const pdf = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', wantPdf(req) ? 'application/pdf' : 'application/pdf');
    // Content-Disposition: inline so browsers render; change to attachment if you prefer downloads
    res.setHeader('Content-Disposition', `inline; filename="${safePdfName(filename)}"`);

    pdf.pipe(res);

    pdf.fontSize(18).text(mail.subject || '(no subject)', { underline: false });
    pdf.moveDown(0.5);

    // headers block
    pdf.fontSize(10);
    const hdrs = [
      ['From', showAddr(mail.from)],
      ['To', showAddrs(mail.to)],
      ['Cc', showAddrs(mail.cc)],
      ['Date', mail.date ? new Date(mail.date).toString() : '']
    ];
    hdrs.forEach(([k, v]) => { if (v) pdf.text(`${k}: ${v}`); });
    pdf.moveDown(0.5);
    pdf.moveTo(pdf.x, pdf.y).lineTo(pdf.page.width - pdf.page.margins.right, pdf.y).stroke();
    pdf.moveDown(0.75);

    // body
    pdf.fontSize(12).text(body, { align: 'left' });

    // NOTE: attachments merging is not implemented in this build
    if (options && options.mergeAttachments) {
      pdf.addPage().fontSize(11).text('Attachments merging is not enabled in this build.', { align: 'left' });
    }

    pdf.end();
  } catch (e) {
    // never crash silently — always JSON
    try {
      return errJson(res, 500, 'Unhandled error', { detail: String(e?.message || e) });
    } catch {
      res.status(500).end();
    }
  }
});

// --- helpers ---
function showAddr(addr) {
  if (!addr) return '';
  try {
    if (addr.text) return addr.text;
    if (addr.value && Array.isArray(addr.value) && addr.value.length) {
      return addr.value.map(v => v.address ? `${v.name ? (v.name + ' ') : ''}<${v.address}>` : (v.name || '')).join(', ');
    }
  } catch { /* ignore */ }
  return '';
}
function showAddrs(a) { return showAddr(a); }

function stripHtml(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<\s*script[\s\S]*?<\/\s*script\s*>/gi, '');
  s = s.replace(/<\s*style[\s\S]*?<\/\s*style\s*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n• ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function safePdfName(name) {
  const base = String(name || 'Email').replace(/\.[^.]+$/, '');
  return (base || 'Email') + '.pdf';
}

app.listen(PORT, () => {
  console.log(`OrdoLux Email→PDF service listening on :${PORT}`);
});
