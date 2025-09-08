/* OrdoLux Email → PDF service (CJS) */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { simpleParser } = require('mailparser');
const { PDFDocument, rgb } = require('pdf-lib');
const { convert: htmlToText } = require('html-to-text');
const he = require('he');

const PORT = process.env.PORT || 8080;
const SECRET_HEADER = 'x-ordolux-secret'; // presence is enough

const app = express();
app.use(express.json({ limit: '50mb' }));

// ---------- utils ----------
const hasSecret = (req) => !!(req.header(SECRET_HEADER) || req.header('X-Ordolux-Secret'));

function addrToStr(addrObj) {
  if (!addrObj) return '';
  if (typeof addrObj === 'string') return addrObj;
  if (Array.isArray(addrObj)) {
    return addrObj.map(addrToStr).filter(Boolean).join('; ');
  }
  if (addrObj.text) return addrObj.text;
  if (addrObj.value && Array.isArray(addrObj.value)) {
    return addrObj.value.map(v => (v.name ? `${v.name} <${v.address}>` : v.address)).join('; ');
  }
  return '';
}

function tmpPathFor(filename) {
  const base = path.basename(filename || 'upload');
  const name = `${Date.now()}-${Math.random().toString(36).slice(2)}-${base}`;
  return path.join(os.tmpdir(), name);
}

function stripZWs(s) {
  // remove zero-width characters which sometimes sneak in
  return (s || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
}

// ---------- parsing ----------
async function parseEml(buffer) {
  const mail = await simpleParser(buffer, { skipHtmlToText: true });
  const atts = (mail.attachments || []).map(a => ({
    filename: a.filename || '',
    contentType: a.contentType || '',
    contentId: a.contentId || null,
    isInline: (a.contentDisposition || '').toLowerCase() === 'inline' || !!a.contentId,
    size: a.size || (a.content ? a.content.length : 0),
    // keep Buffer for rendering; do NOT include in /convert-json
    _content: a.content
  }));

  return {
    ok: true,
    meta: { source: 'eml', has_html: !!mail.html, attach_count: atts.length },
    message: {
      from: addrToStr(mail.from),
      to: addrToStr(mail.to),
      cc: addrToStr(mail.cc),
      subject: mail.subject || '',
      date: mail.date ? new Date(mail.date).toISOString() : null,
      text: mail.text || '',
      html: mail.html || '',
      attachments: atts
    }
  };
}

function runPythonMsg(pathToMsg) {
  return new Promise((resolve) => {
    execFile('/opt/pyenv/bin/python3', ['/app/msg_to_json.py', pathToMsg], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: `python failed: ${err.message}`, stderr: String(stderr) });
        return;
      }
      try {
        const j = JSON.parse(stdout);
        resolve(j);
      } catch (e) {
        resolve({ ok: false, error: 'invalid JSON from python', stdout });
      }
    });
  });
}

async function parseMsg(buffer, filename) {
  const tmp = tmpPathFor(filename || 'email.msg');
  fs.writeFileSync(tmp, buffer);
  try {
    const parsed = await runPythonMsg(tmp);
    if (!parsed.ok) return parsed;

    // turn base64 back to Buffer for image rendering
    const atts = (parsed.message.attachments || []).map(a => ({
      filename: a.filename || '',
      contentType: a.contentType || '',
      contentId: a.contentId || null,
      isInline: !!a.isInline,
      size: a.size || 0,
      _content: a.base64 ? Buffer.from(a.base64, 'base64') : undefined
    }));

    return {
      ok: true,
      meta: { source: 'msg', has_html: !!parsed.message.html, attach_count: atts.length },
      message: {
        from: parsed.message.from || '',
        to: parsed.message.to || '',
        cc: parsed.message.cc || '',
        subject: parsed.message.subject || '',
        date: parsed.message.date || null,
        text: parsed.message.text || '',
        html: parsed.message.html || '',
        attachments: atts
      }
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function parseUpload(fileBase64, filename) {
  const buf = Buffer.from(fileBase64, 'base64');
  const lower = (filename || '').toLowerCase();

  if (lower.endsWith('.eml')) return await parseEml(buf);
  if (lower.endsWith('.msg')) return await parseMsg(buf, filename);

  // Heuristic by magic header: .msg (OLE) starts with D0 CF 11 E0 A1 B1 1A E1
  if (buf.length > 8 && buf[0] === 0xD0 && buf[1] === 0xCF) return await parseMsg(buf, filename);
  // Otherwise assume MIME
  return await parseEml(buf);
}

// ---------- rendering ----------
async function renderPdf(parsed) {
  const pdf = await PDFDocument.create();
  let page = pdf.addPage();
  const { width: PW0, height: PH0 } = page.getSize();

  // Embed Unicode font (avoids "WinAnsi cannot encode" errors)
  const fontBytes = fs.readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  const boldBytes = fs.readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
  const font = await pdf.embedFont(fontBytes, { subset: false });
  const fontBold = await pdf.embedFont(boldBytes, { subset: false });

  const margin = 50;
  let y = PH0 - margin;

  function ensureRoom(h) {
    const { width, height } = page.getSize();
    if (y - h < margin) {
      page = pdf.addPage();
      y = page.getSize().height - margin;
    }
    return { width: page.getSize().width, height: page.getSize().height };
  }

  function drawLabelValue(label, value) {
    const size = 12;
    const gap = 6;
    ensureRoom(size * 1.4);
    page.drawText(label, { x: margin, y, size, font: fontBold, color: rgb(0, 0, 0) });
    const labelW = fontBold.widthOfTextAtSize(label, size);
    page.drawText(stripZWs(value || ''), { x: margin + labelW + 6, y, size, font, color: rgb(0, 0, 0) });
    y -= size + gap;
  }

  const m = parsed.message;
  drawLabelValue('From: ', he.decode(m.from || ''));
  drawLabelValue('To: ', he.decode(m.to || ''));
  if (m.cc) drawLabelValue('Cc: ', he.decode(m.cc || ''));
  drawLabelValue('Subject: ', he.decode(m.subject || ''));
  if (m.date) drawLabelValue('Date: ', new Date(m.date).toLocaleString('en-GB', { hour12: false }));

  // separator
  ensureRoom(20);
  page.drawLine({ start: { x: margin, y: y }, end: { x: page.getSize().width - margin, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 14;

  // Body text
  const html = m.html && m.html.trim().length ? m.html : null;
  const text = html ? htmlToText(html, { wordwrap: false, selectors: [{ selector: 'img', format: 'skip' }] }) : (m.text || '');
  const body = stripZWs(he.decode(text || '')).replace(/\r\n/g, '\n');

  function drawWrapped(str, size = 12, lineGap = 4) {
    const maxW = page.getSize().width - margin * 2;
    const lineH = size + lineGap;
    const paras = (str || '').split('\n');

    for (const para of paras) {
      let remaining = para.trim();
      if (!remaining) { y -= lineH; ensureRoom(lineH); continue; }

      while (remaining.length) {
        ensureRoom(lineH);
        // Greedy wrap
        let low = 1, high = remaining.length, best = 1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const slice = remaining.slice(0, mid);
          const w = font.widthOfTextAtSize(slice, size);
          if (w <= maxW) { best = mid; low = mid + 1; } else { high = mid - 1; }
        }
        const line = remaining.slice(0, best);
        page.drawText(line, { x: margin, y, size, font, color: rgb(0, 0, 0) });
        y -= lineH;
        remaining = remaining.slice(best);
        // Trim leading spaces for next line
        remaining = remaining.replace(/^\s+/, '');
      }
      y -= lineGap; // extra gap between paragraphs
    }
  }

  if (body && body.trim().length) {
    drawWrapped(body, 12, 4);
  } else {
    drawWrapped('(no body text)', 12, 4);
  }

  // Inline images (scaled)
  const imgAtts = (m.attachments || []).filter(a =>
    a && a.isInline && a._content && /image\/(png|jpe?g)/i.test(a.contentType || '')
  );

  if (imgAtts.length) {
    y -= 10;
    ensureRoom(18);
    page.drawText('Inline images', { x: margin, y, size: 12, font: fontBold });
    y -= 16;
  }

  for (const a of imgAtts) {
    let img;
    try {
      if (/image\/png/i.test(a.contentType)) img = await pdf.embedPng(a._content);
      else img = await pdf.embedJpg(a._content);
    } catch {
      continue;
    }
    const maxW = page.getSize().width - margin * 2;
    const scale = Math.min(1, maxW / img.width);
    const w = img.width * scale;
    const h = img.height * scale;
    ensureRoom(h + 10);
    page.drawImage(img, { x: margin, y: y - h, width: w, height: h });
    y -= h + 10;
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}

// ---------- routes ----------
app.get('/healthz', (req, res) => {
  res.json({ ok: true, name: 'ordolux-email-pdf', version: '1.4.0', ts: new Date().toISOString() });
});

app.get('/routes', (req, res) => {
  if (!hasSecret(req)) return res.status(401).json({ ok: false, error: `missing ${SECRET_HEADER}` });
  res.json({
    ok: true,
    routes: ['GET /healthz', 'GET /routes', 'POST /echo', 'POST /convert-json', 'POST /convert'],
    expects_header: 'X-Ordolux-Secret'
  });
});

app.post('/echo', (req, res) => {
  if (!hasSecret(req)) return res.status(401).json({ ok: false, error: `missing ${SECRET_HEADER}` });
  const b = req.body || {};
  res.json({
    ok: true,
    keys: Object.keys(b || {}),
    has_fileBase64: !!b.fileBase64
  });
});

app.post('/convert-json', async (req, res) => {
  if (!hasSecret(req)) return res.status(401).json({ ok: false, error: `missing ${SECRET_HEADER}` });
  try {
    const { fileBase64, filename } = req.body || {};
    if (!fileBase64) return res.status(400).json({ ok: false, error: 'fileBase64 missing' });
    const parsed = await parseUpload(fileBase64, filename || '');
    if (!parsed.ok) return res.status(422).json(parsed);

    // For JSON response, don't include raw attachment bytes
    const safeAtts = (parsed.message.attachments || []).map(a => ({
      filename: a.filename, contentType: a.contentType, contentId: a.contentId,
      isInline: a.isInline, size: a.size
    }));
    res.json({
      ok: true,
      parsed: {
        meta: parsed.meta,
        message: {
          from: parsed.message.from,
          to: parsed.message.to,
          cc: parsed.message.cc,
          subject: parsed.message.subject,
          date: parsed.message.date,
          text_length: (parsed.message.text || '').length,
          html_length: (parsed.message.html || '').length,
          attach_count: safeAtts.length
        }
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/convert', async (req, res) => {
  if (!hasSecret(req)) return res.status(401).json({ ok: false, error: `missing ${SECRET_HEADER}` });
  try {
    const { fileBase64, filename } = req.body || {};
    if (!fileBase64) return res.status(400).json({ ok: false, error: 'fileBase64 missing' });
    const parsed = await parseUpload(fileBase64, filename || '');
    if (!parsed.ok) return res.status(422).json(parsed);

    const pdfBuf = await renderPdf(parsed);
    res.set('Content-Type', 'application/pdf');
    res.send(pdfBuf);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});
