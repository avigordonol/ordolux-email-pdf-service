/* eslint-disable no-console */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { simpleParser } = require('mailparser');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.ORDOLUX_SECRET || process.env.SECRET;

const app = express();
app.use(express.json({ limit: '25mb' }));

function ensureSecret(req) {
  const got = req.get('X-Ordolux-Secret') || req.get('x-ordolux-secret');
  return (!!SECRET && got === SECRET) || (!SECRET);
}

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.post('/convert', async (req, res) => {
  try {
    if (!ensureSecret(req)) return res.status(401).json({ error: 'unauthorized' });

    const accept = req.get('Accept') || 'application/pdf';
    const { fileBase64, filename, options } = req.body || {};
    if (!fileBase64 || !filename) return res.status(422).json({ error: 'fileBase64 and filename required' });

    const buf = Buffer.from(fileBase64, 'base64');
    const ext = path.extname(filename).toLowerCase();
    const tmpPath = path.join(os.tmpdir(), `upl-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    fs.writeFileSync(tmpPath, buf);

    const parsed = ext === '.msg' ? await parseMSG(tmpPath) : await parseEML(buf);
    normalizeAddresses(parsed?.message);

    // JSON path: return a concise summary (no huge body_html)
    if (accept.includes('application/json')) {
      let debug = null;
      if (options && options.debugRender) {
        try {
          await renderPdfFromParsed(parsed, options || {});
          debug = { render_ok: true };
        } catch (e) {
          debug = { render_ok: false, error: e.message || String(e), stack: (e.stack || '').split('\n') };
        }
      }
      const summary = summarizeForJson(parsed);
      return res.json({ parsed: summary, debug });
    }

    // PDF path
    const pdfBytes = await renderPdfFromParsed(parsed, options || {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName(filename.replace(ext, '.pdf'))}"`);
    return res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).type('application/json').send({
      error: err.message || String(err),
      stack: (err.stack || '').split('\n')
    });
  }
});

function safeName(s) { return s.replace(/["\r\n]/g, ''); }
function trunc(s, n) { if (!s) return s; s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; }

function summarizeForJson(parsed) {
  const msg = parsed?.message || {};
  const atts = (msg.attachments || []).map(a => ({
    filename: a.filename,
    content_type: a.content_type,
    is_inline: !!a.is_inline,
    has_data: !!a.data_base64
  }));
  return {
    meta: parsed?.meta || {},
    message: {
      from: msg.from || '', to: msg.to || '', cc: msg.cc || '',
      subject: msg.subject || '', date: msg.date || null,
      body_text: trunc(msg.body_text || '', 4000),
      html_length: msg.body_html ? String(msg.body_html).length : 0,
      attachments: atts
    }
  };
}

function normalizeAddresses(msg) {
  if (!msg) return;
  const clean = (v) => (v || '').toString().replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  msg.from = clean(msg.from);
  msg.to   = clean(msg.to);
  msg.cc   = clean(msg.cc);
}

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr?.toString(); err.stdout = stdout?.toString(); return reject(err); }
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
    data_base64: (a.contentId && a.content && /^image\/(png|jpe?g)$/i.test(a.contentType || ''))
      ? a.content.toString('base64') : undefined
  }));
  return {
    meta: { source: 'eml', has_html: !!mail.html, attachment_count: atts.length },
    message: {
      from: (mail.from && mail.from.text) || '',
      to, cc,
      subject: mail.subject || '',
      date: mail.date ? new Date(mail.date).toISOString() : null,
      body_html: mail.html || null,
      body_text: (mail.text || '').trim(),
      attachments: atts
    }
  };
}

// ------------------ PDF RENDER ------------------
async function renderPdfFromParsed(parsed, opts) {
  const mergeAttachments = !!opts.mergeAttachments;

  const pdfDoc = await PDFDocument.create();

  // Font with unicode fallback
  let font;
  try {
    const fontBytes = fs.readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    font = await pdfDoc.embedFont(fontBytes);
  } catch {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  const pageMargin = 54;
  const bodySize = 11;
  const smallSize = 10;
  const gap = 4;

  let page = pdfDoc.addPage();
  let { width, height } = page.getSize();
  const maxTextWidth = width - pageMargin * 2;

  let y = height - pageMargin;
  const msg = parsed.message || {};

  const headers = [
    ['From', msg.from || ''],
    ['To', msg.to || ''],
    ['Cc', msg.cc || ''],
    ['Date', msg.date || ''],
    ['Subject', msg.subject || '']
  ];
  for (const [label, value] of headers) {
    if (!value) continue;
    ({ page, y } = drawWrappedText(pdfDoc, page, font, smallSize, maxTextWidth, pageMargin, y, `${label}: ${value}`, gap));
    y -= 4;
  }
  y -= 8;

  const bodyText = (msg.body_text && String(msg.body_text).trim()) || '';
  if (bodyText) {
    ({ page, y } = drawWrappedText(pdfDoc, page, font, bodySize, maxTextWidth, pageMargin, y, bodyText, gap));
    y -= 8;
  }

  // Inline PNG/JPG images (scaled to column width and page height)
  const inlineImgs = (msg.attachments || []).filter(a => a.is_inline && a.data_base64 && /^image\/(png|jpe?g)$/i.test(a.content_type || ''));
  for (const att of inlineImgs) {
    const bytes = Buffer.from(att.data_base64, 'base64');
    let embedded;
    try {
      embedded = /png$/i.test(att.content_type) ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
    } catch {
      continue;
    }
    const imgW = embedded.width;
    const imgH = embedded.height;

    const maxW = maxTextWidth;
    const maxH = (height - pageMargin) - pageMargin;
    const scale = Math.min(1, maxW / imgW, maxH / imgH);
    const drawW = imgW * scale;
    const drawH = imgH * scale;

    if (y - drawH < pageMargin) {
      page = pdfDoc.addPage();
      ({ width, height } = page.getSize());
      y = height - pageMargin;
    }

    page.drawImage(embedded, { x: pageMargin, y: y - drawH, width: drawW, height: drawH });
    y -= (drawH + 10);
  }

  // Merge attached PDFs at end (optional)
  if (mergeAttachments) {
    const pdfAtts = (msg.attachments || []).filter(a => /^application\/pdf$/i.test(a.content_type || '') && a.data_base64);
    for (const a of pdfAtts) {
      try {
        const attDoc = await PDFDocument.load(Buffer.from(a.data_base64, 'base64'));
        const pages = await pdfDoc.copyPages(attDoc, attDoc.getPageIndices());
        pages.forEach(p => pdfDoc.addPage(p));
      } catch { /* ignore */ }
    }
  }

  return await pdfDoc.save();
}

function drawWrappedText(pdfDoc, page, font, size, maxWidth, marginX, y, text, gap) {
  const lineHeight = size + gap;
  const color = rgb(0, 0, 0);

  const paragraphs = String(text).replace(/\r/g, '').split(/\n/);
  for (let para of paragraphs) {
    if (!para) { y -= lineHeight; continue; }
    const words = para.split(/\s+/);

    let line = '';
    for (let w of words) {
      if (font.widthOfTextAtSize(w, size) > maxWidth) {
        if (line) ({ page, y } = flushLine(page, font, size, marginX, y, lineHeight, color, maxWidth, line)), line = '';
        let token = w;
        while (token.length) {
          let lo = 1, hi = token.length, cut = 1;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const chunk = token.slice(0, mid);
            if (font.widthOfTextAtSize(chunk, size) <= maxWidth) { cut = mid; lo = mid + 1; }
            else { hi = mid - 1; }
          }
          const chunk = token.slice(0, cut);
          ({ page, y } = flushLine(page, font, size, marginX, y, lineHeight, color, maxWidth, chunk));
          token = token.slice(cut);
        }
        continue;
      }

      const candidate = line ? (line + ' ' + w) : w;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        ({ page, y } = flushLine(page, font, size, marginX, y, lineHeight, color, maxWidth, line));
        line = w;
      }
    }
    if (line) ({ page, y } = flushLine(page, font, size, marginX, y, lineHeight, color, maxWidth, line));
    y -= gap;
  }
  return { page, y };
}

function flushLine(page, font, size, marginX, y, lineHeight, color, maxWidth, text = '') {
  if (y - lineHeight < marginX) {
    page = page.doc.addPage();
    y = page.getSize().height - marginX;
  }
  page.drawText(text, { x: marginX, y: y - lineHeight, size, font, color, maxWidth });
  y -= lineHeight;
  return { page, y };
}

app.listen(PORT, () => console.log(`listening on ${PORT}`));
