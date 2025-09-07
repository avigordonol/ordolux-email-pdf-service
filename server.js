// server.js — EML + MSG (MSG via Python helper), optional merge of PDF attachments
import express from 'express';
import PDFDocument from 'pdfkit';
import { simpleParser } from 'mailparser';
import { spawn } from 'node:child_process';
import { PDFDocument as PdfLib } from 'pdf-lib';

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || '';

const app = express();
app.use(express.json({ limit: '25mb' }));

// ---------- utils ----------
function errJson(res, status, msg, extra = {}) {
  return res.status(status).json({ ok: false, error: msg, ...extra });
}
function safePdfName(name) {
  const base = String(name || 'Email').replace(/\.[^.]+$/, '');
  return (base || 'Email') + '.pdf';
}
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
function showAddr(addr) {
  if (!addr) return '';
  try {
    if (addr.text) return addr.text;
    if (addr.value && Array.isArray(addr.value) && addr.value.length) {
      return addr.value
        .map(v => v.address ? `${v.name ? (v.name + ' ') : ''}<${v.address}>` : (v.name || ''))
        .join(', ');
    }
  } catch {}
  return '';
}
function showAddrs(a) { return showAddr(a); }

function renderCoverPdfToBuffer({ subject, meta, bodyText }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Title
    doc.fontSize(18).text(subject || '(no subject)');
    doc.moveDown(0.5);

    // Meta
    doc.fontSize(10);
    const hdrs = [
      ['From', meta.From || ''],
      ['To',   meta.To   || ''],
      ['Cc',   meta.Cc   || ''],
      ['Date', meta.Date || '']
    ];
    hdrs.forEach(([k, v]) => { if (v) doc.text(`${k}: ${v}`); });
    doc.moveDown(0.5);
    doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
    doc.moveDown(0.75);

    // Body
    doc.fontSize(12).text(bodyText || '(no body)', { align: 'left' });

    doc.end();
  });
}

async function mergePdfs(buffers) {
  const merged = await PdfLib.create();
  for (const buf of buffers) {
    const src = await PdfLib.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  const out = await merged.save();
  return Buffer.from(out);
}

function wantPdf(req) {
  const a = (req.headers['accept'] || '').toLowerCase();
  return a.includes('application/pdf');
}

function pythonCmd() {
  // We install a venv at /opt/pyenv in the Dockerfile
  return process.env.PYTHON || '/opt/pyenv/bin/python';
}

function parseMsgViaPython(fileBase64, filename) {
  return new Promise((resolve, reject) => {
    const p = spawn(pythonCmd(), ['/app/py/parse_msg.py']);
    let stdout = '', stderr = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => stdout += d);
    p.stderr.on('data', d => stderr += d);
    p.on('error', reject);
    p.on('close', (_code) => {
      try {
        const j = JSON.parse(stdout || '{}');
        resolve(j);
      } catch (e) {
        reject(new Error('Python JSON parse failed: ' + e + ' stderr: ' + stderr));
      }
    });
    p.stdin.end(JSON.stringify({ fileBase64, filename }));
  });
}

// ---------- routes ----------
app.get('/healthz', (req, res) => {
  if (SHARED_SECRET && req.headers['x-ordolux-secret'] !== SHARED_SECRET) {
    return errJson(res, 401, 'unauthorized');
  }
  res.json({ ok: true });
});

app.post('/convert', async (req, res) => {
  try {
    if (SHARED_SECRET && req.headers['x-ordolux-secret'] !== SHARED_SECRET) {
      return errJson(res, 401, 'Invalid secret');
    }

    const { fileBase64, filename = '', options = {} } = req.body || {};
    if (!fileBase64 || !filename) {
      return errJson(res, 400, 'Missing fileBase64 or filename');
    }

    const lower = String(filename).toLowerCase().trim();
    const isEML = lower.endsWith('.eml');
    const isMSG = lower.endsWith('.msg');

    // Decode once
    let raw;
    try {
      raw = Buffer.from(fileBase64, 'base64');
    } catch {
      return errJson(res, 400, 'Invalid base64');
    }

    // ---- MSG path (via Python) ----
    if (isMSG) {
      const parsed = await parseMsgViaPython(fileBase64, filename);
      if (!parsed || parsed.ok === false) {
        return errJson(res, 422, 'Failed to parse MSG', { detail: parsed?.error || 'unknown' });
      }

      const meta = {
        From: parsed.from || '',
        To: parsed.to || '',
        Cc: parsed.cc || '',
        Date: parsed.date || ''
      };
      const cover = await renderCoverPdfToBuffer({
        subject: parsed.subject || '(no subject)',
        meta,
        bodyText: parsed.bodyText || ''
      });

      let finalPdf = cover;
      if (options.mergeAttachments && Array.isArray(parsed.attachments) && parsed.attachments.length) {
        const pdfAtts = parsed.attachments
          .filter(a => (a.contentType || '').includes('pdf') && a.dataBase64)
          .map(a => Buffer.from(a.dataBase64, 'base64'));
        if (pdfAtts.length) {
          finalPdf = await mergePdfs([cover, ...pdfAtts]);
        }
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${safePdfName(filename)}"`);
      return res.end(finalPdf);
    }

    // ---- EML path ----
    if (!isEML) {
      return errJson(res, 400, 'Unsupported extension; send .eml or .msg');
    }

    let mail;
    try {
      mail = await simpleParser(raw);
    } catch (e) {
      return errJson(res, 422, 'Failed to parse EML', { detail: String(e?.message || e) });
    }

    const textBody = (mail.text || '').trim();
    const htmlBody = (mail.html && typeof mail.html === 'string') ? mail.html : '';
    const body = textBody || stripHtml(htmlBody) || '(no body)';
    const meta = {
      From: showAddr(mail.from),
      To: showAddrs(mail.to),
      Cc: showAddrs(mail.cc),
      Date: mail.date ? new Date(mail.date).toString() : ''
    };

    const cover = await renderCoverPdfToBuffer({
      subject: mail.subject || '(no subject)',
      meta,
      bodyText: body
    });

    // NOTE: In this build we only merge PDF attachments when source is MSG.
    // EML merges can be added later if needed.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safePdfName(filename)}"`);
    return res.end(cover);
  } catch (e) {
    return errJson(res, 500, 'Unhandled error', { detail: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log('OrdoLux Email→PDF listening on :' + PORT);
});
