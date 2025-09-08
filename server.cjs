/* OrdoLux Email → PDF microservice (CommonJS) */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const PDFDocument = require('pdfkit');
const { simpleParser } = require('mailparser');
const he = require('he');
const { PDFDocument: PdfLib } = require('pdf-lib');

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || ''; // set in Railway

const IMG_MARKER = '<!--IMG-MARKER-->';
const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg']);

const app = express();
app.use(express.json({ limit: '50mb' }));

/* --------- helpers --------- */
function ensureAuth(req, res) {
  const sent = req.headers['x-ordolux-secret'] || '';
  if (!SHARED_SECRET || sent !== SHARED_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function tmpFile(suffix = '') {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(os.tmpdir(), `upl-${id}${suffix}`);
}

function stripHtml(html) {
  // very light HTML → plain text for PDF (we're interleaving images ourselves)
  // decode entities and collapse whitespace.
  const noTags = (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?[^>]+>/g, '');
  const decoded = he.decode(noTags);
  return decoded.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function drawHeader(doc, meta) {
  doc.fontSize(18).text(meta.subject || '(no subject)', { width: 500 });
  doc.moveDown(0.5);
  const lines = [];
  if (meta.from) lines.push(`From: ${meta.from}`);
  if (meta.to) lines.push(`To: ${meta.to}`);
  if (meta.cc) lines.push(`Cc: ${meta.cc}`);
  if (meta.date) lines.push(`Date: ${meta.date}`);
  for (const ln of lines) doc.fontSize(10).fillColor('gray').text(ln, { width: 500 });
  doc.fillColor('black').moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke();
  doc.moveDown(0.8);
}

async function buildPdfBuffer(emailJson) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Header
    drawHeader(doc, {
      subject: emailJson.subject,
      from: emailJson.from,
      to: emailJson.to,
      cc: emailJson.cc,
      date: emailJson.date
    });

    // Body with inline images
    const html = emailJson.html || emailJson.text || '';
    const parts = (html.includes(IMG_MARKER) ? html : he.encode(html)).split(IMG_MARKER);
    const inline = Array.isArray(emailJson.inlineImages) ? emailJson.inlineImages : [];
    let imgIdx = 0;

    for (let i = 0; i < parts.length; i++) {
      const textPart = stripHtml(parts[i]);
      if (textPart) doc.fontSize(11).fillColor('black').text(textPart, { width: 500 });
      if (i < parts.length - 1) {
        // There should be an image after this part
        const img = inline[imgIdx++];
        if (img && img.data && SUPPORTED_IMAGE_MIMES.has((img.mime || '').toLowerCase())) {
          try {
            const buf = Buffer.from(img.data, 'base64');
            // Fit a sensible size; most signatures/logos are small
            doc.moveDown(0.2);
            doc.image(buf, { fit: [220, 120], align: 'left' });
            doc.moveDown(0.6);
          } catch (e) {
            doc.moveDown(0.2);
            doc.fillColor('gray').fontSize(9).text(`[inline image could not be rendered]`);
            doc.fillColor('black');
            doc.moveDown(0.4);
          }
        } else {
          // Not supported / missing / remote
          doc.moveDown(0.2);
          doc.fillColor('gray').fontSize(9).text(`[inline image omitted${img && img.mime ? ` (${img.mime})` : ''}]`);
          doc.fillColor('black');
          doc.moveDown(0.4);
        }
      }
    }

    // End stream (we may merge PDFs afterwards in the route handler)
    doc.end();
  });
}

async function mergePdfAttachments(mainBuffer, pdfAttachmentsB64) {
  if (!pdfAttachmentsB64 || pdfAttachmentsB64.length === 0) return mainBuffer;

  const base = await PdfLib.load(mainBuffer);
  for (const b64 of pdfAttachmentsB64) {
    try {
      const attDoc = await PdfLib.load(Buffer.from(b64, 'base64'));
      const pages = await base.copyPages(attDoc, attDoc.getPageIndices());
      pages.forEach(p => base.addPage(p));
    } catch {
      // Skip corrupted/unsupported PDFs quietly
    }
  }
  return Buffer.from(await base.save());
}

/* --------- routes --------- */

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/convert', async (req, res) => {
  try {
    if (!ensureAuth(req, res)) return;

    const { fileBase64, filename, fileUrl, options } = req.body || {};
    const opts = Object.assign({ mergeAttachments: false }, options || {});

    if (!fileBase64 && !fileUrl) {
      return res.status(422).json({ error: 'missing fileBase64 or fileUrl' });
    }

    // Save uploaded bytes (we support base64 body)
    let filePath = null;
    if (fileBase64) {
      const raw = Buffer.from(fileBase64, 'base64');
      filePath = tmpFile();
      fs.writeFileSync(filePath, raw);
    } else {
      return res.status(422).json({ error: 'fileUrl not supported in this build' });
    }

    const ext = (path.extname(filename || '').toLowerCase()) || '';

    let emailJson = null;

    if (ext === '.msg') {
      // Use Python converter
      const { spawnSync } = require('child_process');
      const py = spawnSync('/opt/pyenv/bin/python3', ['/app/msg_to_json.py', filePath], { encoding: 'utf8' });
      if (py.status !== 0) {
        const errOut = (py.stderr || '').trim();
        const stdOut = (py.stdout || '').trim();
        return res.status(500).json({ error: 'msg_to_json failed', stderr: errOut, stdout: stdOut });
      }
      try {
        emailJson = JSON.parse(py.stdout);
      } catch (e) {
        return res.status(500).json({ error: 'invalid JSON from msg_to_json', detail: e.message, stdout: py.stdout.slice(0, 4000) });
      }
    } else if (ext === '.eml') {
      // Parse with mailparser (handles inline CIDs, attachments, etc.)
      const raw = fs.readFileSync(filePath);
      const parsed = await simpleParser(raw);
      const inlineImages = [];
      const pdfAttachments = [];

      for (const a of parsed.attachments || []) {
        const mime = (a.contentType || '').toLowerCase();
        const cid = (a.cid || '').replace(/[<>]/g, '');
        if ((a.contentDisposition === 'inline' || cid) && (mime.startsWith('image/'))) {
          inlineImages.push({
            mime,
            data: a.content.toString('base64'),
            name: a.filename || ''
          });
        } else if (mime === 'application/pdf') {
          pdfAttachments.push(a.content.toString('base64'));
        }
      }

      emailJson = {
        source: 'eml',
        subject: parsed.subject || '',
        from: parsed.from && parsed.from.text || '',
        to: parsed.to && parsed.to.text || '',
        cc: parsed.cc && parsed.cc.text || '',
        date: parsed.date ? parsed.date.toISOString() : '',
        html: (parsed.html || '').replace(/<img\b[^>]*>/gi, IMG_MARKER), // keep positions; we’ll interleave
        text: parsed.text || '',
        inlineImages,
        pdfAttachments
      };
    } else {
      return res.status(415).json({ error: `unsupported file type: ${ext || '(none)'}` });
    }

    // Build main PDF
    const corePdf = await buildPdfBuffer(emailJson);

    // Optionally merge PDF attachments
    const finalPdf = opts.mergeAttachments
      ? await mergePdfAttachments(corePdf, emailJson.pdfAttachments || [])
      : corePdf;

    res.status(200).type('application/pdf').send(finalPdf);
  } catch (err) {
    // Always send a JSON body so your PowerShell fallback sees something useful
    console.error('convert error:', err);
    res.status(500).type('application/json').send(JSON.stringify({
      error: err && err.message ? err.message : String(err),
      stack: (process.env.NODE_ENV === 'production') ? undefined : (err && err.stack)
    }));
  }
});

// Last-resort error handler
app.use((err, req, res, next) => {
  console.error('unhandled', err);
  res.status(500).json({ error: err && err.message ? err.message : String(err) });
});

app.listen(PORT, () => {
  console.log(`Email→PDF listening on ${PORT}`);
});
