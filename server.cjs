/* OrdoLux Email→PDF service (Express + PDFKit)
   - Accepts { fileBase64, filename, options:{ mergeAttachments } }
   - Supports EML (Node mailparser) and MSG (Python extract_msg) 
   - Inlines images referenced via cid: in HTML (now shown instead of markers)
*/
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const PDFDocument = require('pdfkit');
const he = require('he');
const { htmlToText } = require('html-to-text');
const { spawnSync } = require('child_process');

const SHARED_SECRET = process.env.SHARED_SECRET || "";
const PYTHON_BIN = process.env.PYTHON_BIN || "/opt/pyenv/bin/python3";

const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/healthz', (req, res) => {
  if (SHARED_SECRET && req.get('X-Ordolux-Secret') !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  res.json({ ok: true });
});

function tmpPath(name) {
  const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `upl-${id}-${name}`);
}

function normCid(s) {
  if (!s) return '';
  return String(s).trim().toLowerCase().replace(/^cid:/, '').replace(/[<>'"\s]/g, '').split(/[?#]/)[0];
}

async function parseEML(buffer) {
  const parsed = await simpleParser(buffer);
  const subject = parsed.subject || '';
  const from = parsed.from ? parsed.from.text : '';
  const to = parsed.to ? parsed.to.text : '';
  const cc = parsed.cc ? parsed.cc.text : '';
  const date = parsed.date ? new Date(parsed.date).toISOString() : null;
  let html = parsed.html || (parsed.textAsHtml || '');
  if (!html) {
    html = `<div>${(parsed.text || '').replace(/\n/g, '<br>')}</div>`;
  }

  // Replace <img src="cid:..."> with [[IMG:cid]]
  const used = [];
  html = html.replace(/<img\b[^>]*src=['"]cid:([^'">]+)['"][^>]*>/gi, (_m, cid) => {
    const c = normCid(cid);
    used.push(c);
    return `[[IMG:${c}]]`;
  });

  const inline = [];
  const attachments = [];
  for (const a of parsed.attachments || []) {
    const base = {
      filename: a.filename || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
    };
    const buf = a.content ? Buffer.from(a.content) : null;
    if (buf && /^image\//i.test(base.contentType) && a.contentId && used.includes(normCid(a.contentId))) {
      inline.push({
        ...base,
        cid: normCid(a.contentId),
        dataBase64: buf.toString('base64'),
      });
    } else if (buf) {
      attachments.push({
        ...base,
        dataBase64: buf.toString('base64'),
      });
    }
  }
  return { subject, from, to, cc, date, html_marked: html, inline, attachments };
}

function parseMSG(filePath) {
  const out = spawnSync(PYTHON_BIN, [path.join(__dirname, 'msg_to_json.py'), filePath], {
    encoding: 'utf8',
  });
  if (out.status !== 0) {
    throw new Error(out.stdout || out.stderr || `msg_to_json exit ${out.status}`);
  }
  return JSON.parse(out.stdout);
}

function buildInlineMap(inlineList) {
  const m = {};
  for (const item of inlineList || []) {
    const key1 = item.cid ? normCid(item.cid) : null;
    const fn = item.filename ? item.filename.toLowerCase() : null;
    const buf = Buffer.from(item.dataBase64, 'base64');
    if (key1) m[key1] = { buf, contentType: item.contentType, filename: item.filename };
    if (fn && !m[fn]) m[fn] = { buf, contentType: item.contentType, filename: item.filename };
    if (fn && fn.includes('.')) {
      const base = fn.split('@')[0];
      if (!m[base]) m[base] = { buf, contentType: item.contentType, filename: item.filename };
    }
  }
  return m;
}

function renderEmailToPDF(email, options) {
  const { mergeAttachments = false } = options || {};
  const doc = new PDFDocument({ autoFirstPage: true, margin: 56 });
  const chunks = [];
  doc.on('data', (d) => chunks.push(d));

  // Header (no OrdoLux brand – just clean email header)
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  const headLine = (label, val) => {
    if (!val) return;
    doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
    doc.font('Helvetica').fontSize(10).text(he.decode(String(val)), { width });
  };

  doc.font('Helvetica-Bold').fontSize(18).text(he.decode(email.subject || '(no subject)'), { width });
  doc.moveDown(0.2);
  headLine('From', email.from);
  headLine('To',   email.to);
  headLine('Cc',   email.cc);
  headLine('Date', email.date ? new Date(email.date).toString() : null);
  doc.moveDown(0.5);
  doc.moveTo(doc.x, doc.y).lineTo(doc.x + width, doc.y).strokeColor('#000000').opacity(0.2).stroke().opacity(1);
  doc.moveDown(0.6);

  // Body with inline images
  const inlineMap = buildInlineMap(email.inline || []);
  const htmlMarked = email.html_marked || email.html || email.text || '';
  const textWithMarkers = htmlToText(htmlMarked, {
    wordwrap: false,
    preserveNewlines: true,
    selectors: [
      { selector: 'a', options: { ignoreHref: true }},
      { selector: 'img', format: 'skip' }
    ]
  });

  const re = /\[\[IMG:([^\]]+)\]\]/g;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(textWithMarkers)) !== null) {
    const txt = textWithMarkers.slice(lastIndex, m.index);
    if (txt) {
      doc.font('Helvetica').fontSize(11).text(txt, { width });
    }
    const cid = normCid(m[1]);
    const candKeys = [cid, cid.split('@')[0]];
    let img = null;
    for (const k of candKeys) {
      if (inlineMap[k]) { img = inlineMap[k]; break; }
    }
    if (!img) {
      // No match – just drop a small gap where the image would be
      doc.moveDown(0.4);
    } else {
      // Fit image to page width, reasonable height
      doc.moveDown(0.2);
      const maxW = width;
      const maxH = 180;
      try {
        doc.image(img.buf, { fit: [maxW, maxH], align: 'left', valign: 'top' });
      } catch {
        // Not an image the decoder likes – skip
      }
      doc.moveDown(0.4);
    }
    lastIndex = re.lastIndex;
  }
  const tail = textWithMarkers.slice(lastIndex);
  if (tail) {
    doc.font('Helvetica').fontSize(11).text(tail, { width });
  }

  // (Optional) append image attachments as full-width pages
  if (mergeAttachments && Array.isArray(email.attachments)) {
    for (const a of email.attachments) {
      const ct = (a.contentType || '').toLowerCase();
      if (/^image\//.test(ct)) {
        const buf = Buffer.from(a.dataBase64, 'base64');
        doc.addPage();
        const maxW = width;
        const maxH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
        try {
          doc.image(buf, doc.page.margins.left, doc.page.margins.top, { fit: [maxW, maxH] });
        } catch { /* ignore bad images */ }
      }
    }
  }

  doc.end();
  return Buffer.concat(chunks);
}

app.post('/convert', async (req, res) => {
  try {
    if (SHARED_SECRET && req.get('X-Ordolux-Secret') !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const { fileBase64, filename, options } = req.body || {};
    if (!fileBase64 || !filename) {
      return res.status(422).json({ ok: false, error: 'fileBase64 and filename are required' });
    }

    const buf = Buffer.from(fileBase64, 'base64');
    const tmp = tmpPath(filename.replace(/[^\w.\-]+/g, '_'));
    fs.writeFileSync(tmp, buf);

    const ext = path.extname(filename).toLowerCase();
    let email;
    if (ext === '.eml') {
      email = await parseEML(buf);
    } else if (ext === '.msg') {
      email = parseMSG(tmp);
    } else {
      return res.status(415).json({ ok: false, error: `unsupported file type: ${ext}` });
    }

    const pdf = renderEmailToPDF(email, options || {});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(filename, ext)}.pdf"`);
    return res.status(200).end(pdf);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`OrdoLux email→PDF listening on :${PORT}`));
