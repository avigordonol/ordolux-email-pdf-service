/* OrdoLux Email → PDF Service (CommonJS) */
'use strict';

const express = require('express');
const PDFDocument = require('pdfkit');
const { simpleParser } = require('mailparser');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const app = express();
app.use(express.json({ limit: '32mb' })); // plenty for a single email

// ---- helpers ---------------------------------------------------------------

function assertSecret(req) {
  const expected = process.env.SECRET || '';
  if (!expected) return; // no secret configured
  const got = req.headers['x-ordolux-secret'];
  if (got !== expected) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
}

function cleanAddr(s) {
  if (!s) return '';
  // Mail systems sometimes leave stray commas/angles; normalize light-touch
  return String(s)
    .replace(/\s{2,}/g, ' ')
    .replace(/<\s+/g, '<')
    .replace(/\s+>/g, '>')
    .trim();
}

function stripTags(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h\d>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitHtmlByImg(html) {
  // returns { runs: [{type:'text', html:'...'}|{type:'img', src, alt}] }
  const runs = [];
  if (!html) return { runs: [] };

  const re = /<img\b[^>]*>/gi;
  let last = 0;
  let m;

  while ((m = re.exec(html)) !== null) {
    const before = html.slice(last, m.index);
    if (before) runs.push({ type: 'text', html: before });

    const tag = m[0];
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '';
    const alt = /alt\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '';
    runs.push({ type: 'img', src, alt });

    last = m.index + tag.length;
  }
  const after = html.slice(last);
  if (after) runs.push({ type: 'text', html: after });

  return { runs };
}

function decodeDataUrl(dataUrl) {
  try {
    const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl);
    if (!m) return null;
    return Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
}

function fitWidth(doc, imgWidth, imgHeight, maxWidth) {
  const scale = Math.min(1, maxWidth / imgWidth);
  return { width: Math.round(imgWidth * scale), height: Math.round(imgHeight * scale) };
}

// ---- parsing ---------------------------------------------------------------

async function parseEML(buf) {
  const parsed = await simpleParser(buf);
  const headers = {
    from: parsed.from?.text || '',
    to: parsed.to?.text || '',
    cc: parsed.cc?.text || '',
    subject: parsed.subject || '',
    date: parsed.date ? parsed.date.toISOString() : ''
  };

  // Inline images map by CID
  const inlineMap = {};
  for (const a of parsed.attachments || []) {
    const cid = (a.contentId || '').replace(/[<>]/g, '').trim();
    if (!cid) continue;
    // treat as inline if contentId exists or contentDisposition = inline
    if (a.content && (a.contentDisposition === 'inline' || a.cid || cid)) {
      inlineMap[cid] = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content || []);
    }
  }

  return {
    kind: 'eml',
    headers,
    html: parsed.html || '',
    text: parsed.text || '',
    inlineMap
  };
}

function parseMSGfile(tmpPath) {
  const py = '/opt/pyenv/bin/python3';
  const res = spawnSync(py, [path.join(__dirname, 'msg_to_json.py'), tmpPath], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });

  if (res.error) {
    const e = new Error(`Python spawn error: ${res.error.message}`);
    e.status = 500;
    throw e;
  }
  if (res.status !== 0 && res.stdout.trim() === '') {
    const e = new Error(`Python failed: ${res.stderr || 'no stderr'}`);
    e.status = 500;
    throw e;
  }

  let data;
  try {
    data = JSON.parse(res.stdout || '{}');
  } catch (e) {
    const err = new Error(`Python JSON parse failed: ${e.message}`);
    err.status = 500;
    throw err;
  }

  const h = data.headers || {};
  const headers = {
    from: cleanAddr(h.from),
    to: cleanAddr(h.to),
    cc: cleanAddr(h.cc),
    subject: h.subject || '',
    date: h.date || ''
  };

  // Build inlineMap from attachments w/ contentId
  const inlineMap = {};
  for (const a of data.attachments || []) {
    const cid = String(a.contentId || '').replace(/[<>]/g, '').trim();
    if (!cid) continue;
    try {
      inlineMap[cid] = Buffer.from(a.dataBase64 || '', 'base64');
    } catch { /* ignore */ }
  }

  return {
    kind: 'msg',
    headers,
    html: data.body?.html || '',
    text: data.body?.text || '',
    inlineMap
  };
}

// ---- PDF generation --------------------------------------------------------

function renderHeader(doc, headers) {
  doc.fontSize(16).text(headers.subject || '(no subject)', { underline: false });
  doc.moveDown(0.4);

  doc.fontSize(10);
  if (headers.from) doc.text(`From: ${cleanAddr(headers.from)}`);
  if (headers.to)   doc.text(`To:   ${cleanAddr(headers.to)}`);
  if (headers.cc)   doc.text(`Cc:   ${cleanAddr(headers.cc)}`);
  if (headers.date) doc.text(`Date: ${headers.date}`);
  doc.moveDown(0.8);

  doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#AAAAAA').stroke();
  doc.strokeColor('black');
  doc.moveDown(0.8);
}

function renderBodyWithInlineImages(doc, html, text, inlineMap) {
  // Prefer HTML so we can place inline images.
  const hasHtml = !!(html && html.trim());
  if (!hasHtml) {
    const body = (text && text.trim()) ? text : '(no body)';
    doc.fontSize(12).text(body, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
    return;
  }

  const { runs } = splitHtmlByImg(html);

  for (const run of runs) {
    if (run.type === 'text') {
      const t = stripTags(run.html);
      if (t) {
        doc.fontSize(12).text(t, {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right
        });
      }
    } else if (run.type === 'img') {
      const src = run.src || '';
      let buf = null;

      if (/^cid:/i.test(src)) {
        const cid = src.slice(4).replace(/[<>]/g, '').trim();
        if (inlineMap[cid]) buf = inlineMap[cid];
      } else if (/^data:/i.test(src)) {
        buf = decodeDataUrl(src);
      } else {
        // remote http(s) images: skip (no outbound fetch in this service)
      }

      // draw image if we have it
      if (buf && buf.length > 0) {
        try {
          const x = doc.x;
          const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
          // Let PDFKit figure out intrinsic size; we draw with fit:[maxW, maxW]
          doc.moveDown(0.3);
          doc.image(buf, { fit: [maxW, maxW], align: 'left' });
          doc.moveDown(0.6);
        } catch (e) {
          // If PDFKit can’t decode, don’t crash
          doc.fillColor('#666666').fontSize(10).text(`[inline image could not be decoded]`, { continued: false });
          doc.fillColor('black');
          doc.moveDown(0.4);
        }
      } else {
        // No buffer found; place a small placeholder (no crash)
        if (run.alt) {
          doc.fillColor('#666666').fontSize(10).text(`[inline image: ${run.alt}]`);
          doc.fillColor('black');
        }
      }
    }
  }
}

// Create PDF to a Buffer (so we can fail gracefully before sending)
function buildPdfBuffer(parsed) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, left: 50, right: 50, bottom: 50 }
    });

    doc.on('data', d => chunks.push(d));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    renderHeader(doc, parsed.headers || {});
    renderBodyWithInlineImages(doc, parsed.html, parsed.text, parsed.inlineMap || {});

    doc.end();
  });
}

// ---- routes ----------------------------------------------------------------

app.get('/healthz', (req, res) => {
  res.json({ ok: true, t: new Date().toISOString() });
});

app.post('/convert', async (req, res, next) => {
  try {
    assertSecret(req);

    const { fileBase64, filename, options } = req.body || {};
    if (!fileBase64 || !filename) {
      const err = new Error('fileBase64 and filename are required');
      err.status = 422;
      throw err;
    }

    const buf = Buffer.from(fileBase64, 'base64');
    const ext = path.extname(String(filename)).toLowerCase();

    let parsed;
    if (ext === '.eml') {
      parsed = await parseEML(buf);
    } else if (ext === '.msg') {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordolux-'));
      const p = path.join(tmp, path.basename(filename));
      fs.writeFileSync(p, buf);
      try {
        parsed = parseMSGfile(p);
      } finally {
        try { fs.unlinkSync(p); } catch {}
        try { fs.rmdirSync(tmp); } catch {}
      }
    } else {
      const err = new Error('Unsupported file type. Send .eml or .msg');
      err.status = 415;
      throw err;
    }

    const pdf = await buildPdfBuffer(parsed);

    // If the client asked for JSON explicitly, return a JSON envelope with base64 PDF
    const wantsJson = /\bapplication\/json\b/i.test(req.headers.accept || '');
    if (wantsJson) {
      res.json({ ok: true, filename: (filename.replace(/\.[^.]+$/, '') || 'email') + '.pdf', pdfBase64: pdf.toString('base64') });
    } else {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${(filename.replace(/\.[^.]+$/, '') || 'email')}.pdf"`);
      res.send(pdf);
    }
  } catch (e) {
    next(e);
  }
});

// Uniform JSON errors (even when the original request asked for PDF)
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const body = {
    ok: false,
    status,
    error: err.message || 'Internal Server Error'
  };
  // Optionally surface a short stack in non-prod
  if (process.env.NODE_ENV !== 'production' && err.stack) body.stack = err.stack.split('\n').slice(0, 5).join('\n');

  res.status(status);
  // if the client was asking for a PDF, still return JSON so you can read it in PowerShell
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
});

// ---- bootstrap -------------------------------------------------------------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`OrdoLux Email→PDF listening on :${port}`);
});
