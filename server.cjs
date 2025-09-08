// OrdoLux Email→PDF – robust build (PDFKit + DejaVu, JSON debug, inline images)
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { simpleParser } = require('mailparser');
const he = require('he');
const PDFDocument = require('pdfkit');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.ORDOLUX_SECRET || null;
const PY = '/opt/pyenv/bin/python3';
const PY_SCRIPT = path.join(__dirname, 'msg_to_json.py');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const app = express();
app.use(express.json({ limit: '100mb' }));

function auth(req, res) {
  if (!SECRET) return true;
  const got = req.header('x-ordolux-secret');
  if (got === SECRET) return true;
  res.status(401).json({ ok: false, error: 'unauthorized' });
  return false;
}

app.get('/healthz', (_req, res) =>
  res.json({ ok: true, name: 'ordolux-email-pdf', ts: new Date().toISOString() })
);

// ---------- helpers ----------
function cleanHeader(s) {
  return (s || '').replace(/\t+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
function normalizeCid(s) {
  return (s || '').replace(/[<>\s]/g, '').toLowerCase();
}
function stripTags(html) {
  return (html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<o:[\s\S]*?<\/o:[^>]+>/gi, '')
    .replace(/<w:[\s\S]*?<\/w:[^>]+>/gi, '')
    .replace(/<\/?([a-zA-Z0-9]+)(\s[^>]*)?>/g, ' ');
}
function splitHtmlToTokens(html) {
  let h = html || '';
  // normalize common outlook quirks
  h = h.replace(/\u200B/g, ''); // zero-width
  h = h.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/p>/gi, '\n\n');

  const tokens = [];
  const rx = /<img[^>]+src=["']cid:([^"']+)["'][^>]*>/ig;
  let last = 0, m;
  while ((m = rx.exec(h)) !== null) {
    const pre = h.slice(last, m.index);
    const txt = he.decode(stripTags(pre)).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    if (txt) tokens.push({ type: 'text', text: txt });
    tokens.push({ type: 'img', cid: normalizeCid(m[1]) });
    last = rx.lastIndex;
  }
  const tail = h.slice(last);
  const tailTxt = he.decode(stripTags(tail)).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (tailTxt) tokens.push({ type: 'text', text: tailTxt });

  return tokens.length ? tokens : [{ type: 'text', text: he.decode(stripTags(html || '')) }];
}

async function parseMSG(tmpPath) {
  const out = await new Promise((resolve, reject) => {
    execFile(PY, [PY_SCRIPT, tmpPath], { timeout: 30000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout.toString('utf8'))); }
      catch (e) { reject(e); }
    });
  });
  if (!out || !out.ok) throw new Error(out && out.error ? out.error : 'msg parse failed');

  const m = out.message || {};
  const a = Array.isArray(m.attachments) ? m.attachments : [];
  return {
    from: cleanHeader(m.from),
    to: cleanHeader(m.to),
    cc: cleanHeader(m.cc),
    subject: cleanHeader(m.subject),
    date: m.date || null,
    html: m.body_html || null,
    text: m.body_text || null,
    attachments: a.map(x => ({
      filename: x.filename || 'attachment',
      contentType: x.contentType || 'application/octet-stream',
      contentId: normalizeCid(x.contentId || ''),
      isInline: !!x.isInline,
      dataB64: x.dataB64 || null
    }))
  };
}

async function parseEML(buffer) {
  const mail = await simpleParser(buffer);
  const addrStr = (addr) => {
    if (!addr) return '';
    if (typeof addr === 'string') return cleanHeader(addr);
    if (addr.value && Array.isArray(addr.value)) {
      return addr.value.map(v => v.name ? `${v.name} <${v.address}>` : v.address).join(', ');
    }
    return cleanHeader(String(addr));
  };
  const atts = (mail.attachments || []).map(a => ({
    filename: a.filename || 'attachment',
    contentType: a.contentType || 'application/octet-stream',
    contentId: normalizeCid(a.cid || a.contentId || ''),
    isInline: !!(a.cid || a.contentId),
    dataB64: a.content ? Buffer.from(a.content).toString('base64') : null
  }));
  return {
    from: addrStr(mail.from),
    to: addrStr(mail.to),
    cc: addrStr(mail.cc),
    subject: cleanHeader(mail.subject || ''),
    date: mail.date ? new Date(mail.date).toISOString() : null,
    html: mail.html || null,
    text: mail.text || null,
    attachments: atts
  };
}

async function parseUploaded(filename, fileB64) {
  const lower = (filename || '').toLowerCase();
  const bin = Buffer.from(fileB64, 'base64');
  if (lower.endsWith('.eml')) return await parseEML(bin);

  const tmp = path.join(os.tmpdir(), `upl-${Date.now()}-${Math.random().toString(36).slice(2)}.msg`);
  await fsp.writeFile(tmp, bin);
  try { return await parseMSG(tmp); }
  finally { try { await fsp.unlink(tmp); } catch {} }
}

function newDoc() {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 54, left: 54, right: 54, bottom: 54 }
  });
  doc.registerFont('Body', FONT_PATH);
  doc.font('Body').fontSize(11);
  return doc;
}
function width(doc) { return doc.page.width - doc.page.margins.left - doc.page.margins.right; }
function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}
function hr(doc) {
  const x1 = doc.page.margins.left;
  const x2 = doc.page.width - doc.page.margins.right;
  doc.moveTo(x1, doc.y).lineTo(x2, doc.y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.moveDown(0.8);
}
function drawKV(doc, k, v) {
  if (!v) return;
  doc.font('Body').fontSize(11).text(`${k}: ${v}`, { width: width(doc) });
}
function drawImage(doc, buf) {
  const maxW = width(doc);
  const maxH = 420;
  ensureSpace(doc, 50);
  try { doc.image(buf, { fit: [maxW, maxH], align: 'left' }); } catch {}
  doc.moveDown(0.5);
}

async function renderPdf(parsed, mergeAttachments) {
  const doc = newDoc();

  // Header
  drawKV(doc, 'Subject', parsed.subject);
  drawKV(doc, 'From', parsed.from);
  drawKV(doc, 'To', parsed.to);
  drawKV(doc, 'Cc', parsed.cc);
  drawKV(doc, 'Date', parsed.date);
  doc.moveDown(0.6);
  hr(doc);

  // Build cid map from attachments
  const cidMap = new Map();
  (parsed.attachments || []).forEach(a => {
    if (a.dataB64 && a.contentId) cidMap.set(a.contentId, Buffer.from(a.dataB64, 'base64'));
  });

  // Tokenize body
  const tokens = parsed.html ? splitHtmlToTokens(parsed.html) :
                [{ type: 'text', text: parsed.text || '' }];

  for (const t of tokens) {
    if (t.type === 'text') {
      const s = (t.text || '').replace(/\u200B/g, '').replace(/\u00A0/g, ' ').replace(/\r/g, '').trim();
      if (s) { doc.text(s, { width: width(doc) }); doc.moveDown(0.6); }
    } else if (t.type === 'img') {
      const buf = cidMap.get(normalizeCid(t.cid));
      if (buf) drawImage(doc, buf);
    }
  }

  // Remaining images (append)
  if (mergeAttachments) {
    const used = new Set(tokens.filter(x => x.type === 'img').map(x => normalizeCid(x.cid)));
    for (const a of parsed.attachments || []) {
      const isImage = (a.contentType || '').startsWith('image/');
      const cid = normalizeCid(a.contentId);
      if (isImage && a.dataB64 && (!cid || !used.has(cid))) {
        drawImage(doc, Buffer.from(a.dataB64, 'base64'));
      }
    }
  }

  const chunks = [];
  return await new Promise((resolve, reject) => {
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ---------- routes ----------
app.post('/convert-json', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const { fileBase64, filename } = req.body || {};
    if (!fileBase64 || !filename) return res.status(422).json({ ok: false, error: 'missing fileBase64 or filename' });

    const parsed = await parseUploaded(filename, fileBase64);
    return res.json({
      ok: true,
      parsed: {
        message: {
          from: parsed.from, to: parsed.to, cc: parsed.cc,
          subject: parsed.subject, date: parsed.date,
          text_length: (parsed.text || '').length,
          html_length: (parsed.html || '').length,
          attach_count: (parsed.attachments || []).length
        }
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/convert', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const { fileBase64, filename, options } = req.body || {};
    if (!fileBase64 || !filename) return res.status(422).json({ ok: false, error: 'missing fileBase64 or filename' });

    const mergeAttachments = !!(options && options.mergeAttachments);
    const parsed = await parseUploaded(filename, fileBase64);
    const pdf = await renderPdf(parsed, mergeAttachments);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${path.basename(filename, path.extname(filename))}.pdf"`);
    return res.send(pdf);
  } catch (e) {
    // Always return JSON on error (even if Accept: pdf), so callers can read it
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));

app.listen(PORT, () => console.log(`OrdoLux email→pdf listening on :${PORT}`));
