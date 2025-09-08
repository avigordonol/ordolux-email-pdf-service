/* OrdoLux Email→PDF service (CommonJS)
   - .eml parsed with mailparser
   - .msg parsed via Python (extract_msg)
   - PDF via PDFKit + DejaVuSans (Unicode-safe)
   - Inline images (cid) rendered and scaled
   - /convert-json returns concise summary (no giant HTML)
*/
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const PDFDocument = require('pdfkit');           // <- PDFKIT (not pdf-lib)
const he = require('he');
const { simpleParser } = require('mailparser');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.ORDOLUX_SECRET || null; // if set, we enforce it
const PY = '/opt/pyenv/bin/python3';
const PY_SCRIPT = path.join(__dirname, 'msg_to_json.py');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const app = express();
app.use(express.json({ limit: '100mb' }));

function requireSecret(req, res) {
  if (!SECRET) return true;
  const got = req.header('x-ordolux-secret');
  if (got && got === SECRET) return true;
  res.status(401).json({ ok: false, error: 'unauthorized' });
  return false;
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'ordolux-email-pdf', ts: new Date().toISOString() });
});

// -------------------- helpers --------------------
function stripTags(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, '')
    .replace(/<w:[\s\S]*?<\/w:[^>]+>/gi, '')
    .replace(/<\/?([a-zA-Z0-9]+)(\s[^>]*)?>/g, ' ');
}

function normalizeCid(s) {
  return (s || '').replace(/[<>\s]/g, '').toLowerCase();
}

function normalizeHeader(s) {
  if (!s) return '';
  return String(s).replace(/\t+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function splitHtmlToTokens(html) {
  // Replace hard breaks with \n to improve wrapping
  let clean = html || '';
  clean = clean.replace(/\u200B/g, ''); // zero-width
  clean = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  clean = clean.replace(/<br\s*\/?>/gi, '\n');
  clean = clean.replace(/<\/p>/gi, '\n\n');

  const tokens = [];
  const imgRe = /<img[^>]+src=["']cid:([^"']+)["'][^>]*>/ig;
  let last = 0, m;
  while ((m = imgRe.exec(clean)) !== null) {
    const before = clean.slice(last, m.index);
    const text = he.decode(stripTags(before)).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
    if (text) tokens.push({ type: 'text', text });
    tokens.push({ type: 'img', cid: normalizeCid(m[1]) });
    last = imgRe.lastIndex;
  }
  const tail = clean.slice(last);
  const textTail = he.decode(stripTags(tail)).replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (textTail) tokens.push({ type: 'text', text: textTail });
  return tokens.length ? tokens : [{ type: 'text', text: he.decode(stripTags(html)) }];
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
    from: normalizeHeader(m.from),
    to: normalizeHeader(m.to),
    cc: normalizeHeader(m.cc),
    subject: normalizeHeader(m.subject),
    date: m.date || null,
    html: m.body_html || null,
    text: m.body_text || null,
    attachments: a.map(x => ({
      filename: x.filename || 'attachment',
      contentType: x.contentType || 'application/octet-stream',
      contentId: normalizeCid(x.contentId),
      isInline: !!x.isInline,
      dataB64: x.dataB64
    }))
  };
}

async function parseEML(buffer) {
  const mail = await simpleParser(buffer);
  const addrToString = (addr) => {
    if (!addr) return '';
    if (typeof addr === 'string') return normalizeHeader(addr);
    if (addr.value && Array.isArray(addr.value)) {
      return addr.value.map(v => v.name ? `${v.name} <${v.address}>` : v.address).join(', ');
    }
    return normalizeHeader(String(addr));
  };

  const atts = (mail.attachments || []).map(a => ({
    filename: a.filename || 'attachment',
    contentType: a.contentType || 'application/octet-stream',
    contentId: normalizeCid(a.cid || a.contentId || ''),
    isInline: !!(a.cid || a.contentId),
    dataB64: a.content ? Buffer.from(a.content).toString('base64') : null
  }));

  return {
    from: addrToString(mail.from),
    to: addrToString(mail.to),
    cc: addrToString(mail.cc),
    subject: normalizeHeader(mail.subject || ''),
    date: mail.date ? new Date(mail.date).toISOString() : null,
    html: mail.html || null,
    text: mail.text || null,
    attachments: atts
  };
}

async function parseUploadedEmail(filename, fileB64) {
  const ext = (filename || '').toLowerCase().trim();
  const bin = Buffer.from(fileB64, 'base64');

  if (ext.endsWith('.eml')) {
    return await parseEML(bin);
  }

  // .msg (or unknown) → Python helper
  const tmp = path.join(os.tmpdir(), `upl-${Date.now()}-${Math.random().toString(36).slice(2)}.msg`);
  await fsp.writeFile(tmp, bin);
  try {
    return await parseMSG(tmp);
  } finally {
    try { await fsp.unlink(tmp); } catch {}
  }
}

function beginDoc() {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 54, left: 54, right: 54, bottom: 54 }
  });
  doc.registerFont('Body', FONT_PATH);
  doc.font('Body').fontSize(11);
  return doc;
}

function drawKV(doc, k, v) {
  if (!v) return;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.font('Body').fontSize(11).text(`${k}: ${v}`, { width: w });
}

function ensureSpace(doc, needed) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

function drawImage(doc, buf) {
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxH = 420; // keep images reasonable
  ensureSpace(doc, 50);
  try {
    doc.image(buf, {
      fit: [w, maxH],
      align: 'left'
    });
  } catch {
    // ignore corrupt image
  }
  doc.moveDown(0.5);
}

async function renderPdfFromParsed(parsed, mergeAttachments) {
  const doc = beginDoc();

  // Header
  drawKV(doc, 'Subject', parsed.subject);
  drawKV(doc, 'From', parsed.from);
  drawKV(doc, 'To', parsed.to);
  drawKV(doc, 'Cc', parsed.cc);
  drawKV(doc, 'Date', parsed.date);
  doc.moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#999').lineWidth(0.5).stroke();
  doc.moveDown(0.8);

  // Build inline CID map
  const cidMap = new Map();
  (parsed.attachments || []).forEach(a => {
    if (a.dataB64 && a.contentId) cidMap.set(a.contentId, Buffer.from(a.dataB64, 'base64'));
  });

  // Tokens (text + inline images)
  const tokens = parsed.html ? splitHtmlToTokens(parsed.html) : [{ type: 'text', text: parsed.text || '' }];

  const bodyWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (const t of tokens) {
    if (t.type === 'text') {
      const s = (t.text || '')
        .replace(/\u200B/g, '')      // zero width
        .replace(/\u00A0/g, ' ')     // nbsp
        .replace(/\r/g, '')
        .trim();
      if (s) {
        doc.text(s, { width: bodyWidth });
        doc.moveDown(0.6);
      }
    } else if (t.type === 'img') {
      const buf = cidMap.get(normalizeCid(t.cid)) || null;
      if (buf) drawImage(doc, buf);
    }
  }

  // Any remaining inline images that weren't referenced (append at end)
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

  // Finalize → Buffer
  const chunks = [];
  return await new Promise((resolve, reject) => {
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// -------------------- routes --------------------
app.post('/convert-json', async (req, res) => {
  if (!requireSecret(req, res)) return;
  try {
    const { fileBase64, filename } = req.body || {};
    if (!fileBase64 || !filename) {
      return res.status(422).json({ ok: false, error: 'missing fileBase64 or filename' });
    }
    const parsed = await parseUploadedEmail(filename, fileBase64);
    const htmlLen = parsed.html ? parsed.html.length : 0;
    const textLen = parsed.text ? parsed.text.length : 0;
    const attCount = (parsed.attachments || []).length;
    const cids = (parsed.attachments || [])
      .map(a => a.contentId)
      .filter(Boolean);

    res.json({
      ok: true,
      parsed: {
        message: {
          from: parsed.from,
          to: parsed.to,
          cc: parsed.cc,
          subject: parsed.subject,
          date: parsed.date,
          text_length: textLen,
        html_length: htmlLen,
          attach_count: attCount
        },
        cids
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/convert', async (req, res) => {
  if (!requireSecret(req, res)) return;
  const wantsJson = (req.get('accept') || '').includes('application/json');

  try {
    const { fileBase64, filename, options } = req.body || {};
    if (!fileBase64 || !filename) {
      const obj = { ok: false, error: 'missing fileBase64 or filename' };
      return res.status(422).json(obj);
    }
    const mergeAttachments = !!(options && options.mergeAttachments);
    const parsed = await parseUploadedEmail(filename, fileBase64);
    const pdf = await renderPdfFromParsed(parsed, mergeAttachments);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${path.basename(filename, path.extname(filename))}.pdf"`);
    res.send(pdf);
  } catch (e) {
    const obj = { ok: false, error: String(e), hint: 'Try /convert-json to inspect summary; Unicode-safe font is enabled.' };
    return res.status(500).json(obj);
  }
});

app.listen(PORT, () => {
  console.log(`OrdoLux email→pdf listening on :${PORT}`);
});
