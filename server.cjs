/* eslint-disable no-console */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const tmp = require('tmp');
const { simpleParser } = require('mailparser'); // for .eml support

const PORT = process.env.PORT || 8080;
const SECRET = process.env.ORDOLUX_SECRET || process.env.SECRET;

const app = express();
app.use(express.json({ limit: '25mb' }));

function ensureSecret(req, res) {
  const got = req.get('X-Ordolux-Secret') || req.get('x-ordolux-secret');
  return (!!SECRET && got === SECRET) || (!SECRET); // allow no-secret if env not set
}

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.post('/convert', async (req, res) => {
  try {
    if (!ensureSecret(req, res)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const accept = req.get('Accept') || 'application/pdf';
    const { fileBase64, filename, options } = req.body || {};
    if (!fileBase64 || !filename) {
      return res.status(422).json({ error: 'fileBase64 and filename required' });
    }

    // Write the upload to a temp file
    const buf = Buffer.from(fileBase64, 'base64');
    const ext = path.extname(filename).toLowerCase();
    const tmpPath = path.join(os.tmpdir(), `upl-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tmpPath, buf);

    // Parse the email -> normalized JSON
    const parsed = ext === '.msg' ? await parseMSG(tmpPath) : await parseEML(buf);

    // If the client wants raw JSON (debug), return it
    if (accept.includes('application/json')) {
      return res.json(parsed);
    }

    // Build the PDF
    const pdfBytes = await renderPdfFromParsed(parsed, options || {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName(filename.replace(ext, '.pdf'))}"`);
    return res.send(Buffer.from(pdfBytes));
  } catch (err) {
    // Always try to return structured JSON on failure
    const payload = { error: err.message || String(err), stack: (err.stack || '').split('\n') };
    // If they asked for PDF we still return JSON so Avi can see the reason
    res.status(500).type('application/json').send(payload);
  }
});

function safeName(s) {
  return s.replace(/["\r\n]/g, '');
}

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr?.toString();
        err.stdout = stdout?.toString();
        return reject(err);
      }
      resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
    });
  });
}

async function parseMSG(filePath) {
  const { stdout } = await execFileAsync('/opt/pyenv/bin/python3', [path.join(__dirname, 'msg_to_json.py'), filePath], { timeout: 30000 });
  const j = JSON.parse(stdout || '{}');
  if (j.error) throw new Error(j.error);
  return j;
}

async function parseEML(buffer) {
  const mail = await simpleParser(buffer);
  const to = mail.to ? mail.to.text : '';
  const cc = mail.cc ? mail.cc.text : '';
  const atts = (mail.attachments || []).map(a => ({
    filename: a.filename || 'attachment',
    content_type: a.contentType || 'application/octet-stream',
    content_id: a.contentId || null,
    is_inline: !!a.contentId,
    data_base64: (a.contentId && a.content && a.contentType.startsWith('image/')) ? a.content.toString('base64') : undefined
  }));
  return {
    meta: { source: 'eml', has_html: !!mail.html, attachment_count: atts.length },
    message: {
      from: (mail.from && mail.from.text) || '',
      to, cc,
      subject: mail.subject || '',
      date: mail.date ? new Date(mail.date).toISOString() : null,
      body_html: mail.html || null,
      body_text: mail.text || '',
      attachments: atts
    }
  };
}

// ----- PDF rendering -----
async function renderPdfFromParsed(parsed, opts) {
  const mergeAttachments = !!opts.mergeAttachments;

  const pdfDoc = await PDFDocument.create();

  // Use a Unicode font so curly quotes, en dashes etc. render correctly
  const fontPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const fontBytes = fs.readFileSync(fontPath);
  const font = await pdfDoc.embedFont(fontBytes);

  const pageMargin = 54; // ~0.75"
  const bodySize = 11;
  const smallSize = 10;
  const lineGap = 4;

  let page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const maxTextWidth = width - pageMargin * 2;

  let cursorY = height - pageMargin;

  const msg = parsed.message || {};
  const headers = [
    ['From', msg.from || ''],
    ['To', msg.to || ''],
    ['Cc', msg.cc || ''],
    ['Date', msg.date || ''],
    ['Subject', msg.subject || '']
  ];

  // Draw headers (no logo/watermark)
  for (const [label, value] of headers) {
    if (!value) continue;
    const text = `${label}: ${value}`;
    ({ page, cursorY } = drawWrappedText(pdfDoc, page, font, smallSize, maxTextWidth, pageMargin, cursorY, text, lineGap));
    cursorY -= 4;
  }

  cursorY -= 8;

  // Body text – prefer HTML-derived text if present (Python already cleaned it)
  const bodyText = (msg.body_text && String(msg.body_text).trim()) || '';
  if (bodyText) {
    ({ page, cursorY } = drawWrappedText(pdfDoc, page, font, bodySize, maxTextWidth, pageMargin, cursorY, bodyText, lineGap));
    cursorY -= 8;
  }

  // Inline images (scale to page width, keep aspect ratio). Only PNG/JPEG are supported by pdf-lib.
  const inlineImgs = (msg.attachments || []).filter(a => a.is_inline && a.data_base64 && /^image\/(png|jpe?g)$/i.test(a.content_type || ''));
  for (const img of inlineImgs) {
    const bytes = Buffer.from(img.data_base64, 'base64');
    let embedded, imgW, imgH;
    if (/png$/i.test(img.content_type)) {
      embedded = await pdfDoc.embedPng(bytes);
    } else {
      embedded = await pdfDoc.embedJpg(bytes);
    }
    imgW = embedded.width;
    imgH = embedded.height;

    // scale to fit width
    const maxW = maxTextWidth;
    const scale = Math.min(1, maxW / imgW);
    const drawW = imgW * scale;
    const drawH = imgH * scale;

    // New page if not enough vertical room
    if (cursorY - drawH < pageMargin) {
      page = pdfDoc.addPage();
      cursorY = page.getSize().height - pageMargin;
    }

    page.drawImage(embedded, {
      x: pageMargin,
      y: cursorY - drawH,
      width: drawW,
      height: drawH
    });
    cursorY -= (drawH + 10);
  }

  // Optionally merge PDF attachments at the end (skip non-PDFs)
  if (mergeAttachments) {
    const pdfAtts = (msg.attachments || []).filter(a => /^application\/pdf$/i.test(a.content_type || '') && a.data_base64);
    for (const a of pdfAtts) {
      try {
        const attDoc = await PDFDocument.load(Buffer.from(a.data_base64, 'base64'));
        const pages = await pdfDoc.copyPages(attDoc, attDoc.getPageIndices());
        pages.forEach(p => pdfDoc.addPage(p));
      } catch {
        // ignore attachment merge errors
      }
    }
  }

  return await pdfDoc.save();
}

function drawWrappedText(pdfDoc, page, font, size, maxWidth, marginX, cursorY, text, gap) {
  const words = text.replace(/\r/g, '').split(/\s+/);
  const lineHeight = size + gap;
  const color = rgb(0, 0, 0);

  let line = '';
  for (const w of words) {
    const test = line ? (line + ' ' + w) : w;
    const width = font.widthOfTextAtSize(test, size);
    if (width > maxWidth) {
      // emit current line
      if (cursorY - lineHeight < marginX) {
        page = pdfDoc.addPage();
        cursorY = page.getSize().height - marginX;
      }
      page.drawText(line, { x: marginX, y: cursorY - lineHeight, size, font, color, maxWidth });
      cursorY -= lineHeight;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) {
    if (cursorY - lineHeight < marginX) {
      page = pdfDoc.addPage();
      cursorY = page.getSize().height - marginX;
    }
    page.drawText(line, { x: marginX, y: cursorY - lineHeight, size, font, color, maxWidth });
    cursorY -= lineHeight;
  }
  return { page, cursorY };
}

app.listen(PORT, () => console.log(`listening on ${PORT}`));
