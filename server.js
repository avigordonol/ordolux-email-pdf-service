/* OrdoLux Email → PDF microservice (CommonJS) */

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { simpleParser } = require('mailparser');
const PDFDocument = require('pdfkit');
const { htmlToText } = require('html-to-text');

const PORT = process.env.PORT || 8080;
const SHARED_SECRET = process.env.SHARED_SECRET || ''; // set in Railway if you want
const PYTHON = '/opt/pyenv/bin/python3';               // python inside venv

const app = express();
app.use(express.json({ limit: '50mb' }));

function guard(req, res, next) {
  if (SHARED_SECRET && req.get('X-Ordolux-Secret') !== SHARED_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

app.get('/healthz', guard, (_req, res) => res.status(200).send('ok'));

// ---------- helpers ----------

function safeName(name = '') {
  return String(name).replace(/[^\w.\-]+/g, '_');
}

function formatAddrs(list) {
  if (!list || !list.length) return '';
  return list
    .map(a => {
      const name = (a.name || '').toString().replace(/\s+/g, ' ').trim();
      const addr = (a.address || a.email || '').toString().trim();
      if (name && addr) return `${name} <${addr}>`;
      return addr || name;
    })
    .join('; ');
}

async function parseEml(buffer) {
  const mail = await simpleParser(buffer);
  const atts = (mail.attachments || []).map(a => ({
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    contentId: (a.cid || '').toLowerCase(),
    inline: !!a.cid,
    data: a.content
  }));
  return {
    kind: 'eml',
    subject: mail.subject || '',
    from: mail.from?.value || [],
    to: mail.to?.value || [],
    cc: mail.cc?.value || [],
    date: mail.date ? mail.date.toISOString() : '',
    html: typeof mail.html === 'string' ? mail.html : (mail.html?.toString('utf8') || ''),
    text: mail.text || '',
    attachments: atts
  };
}

async function parseMsg(buffer) {
  const tmp = path.join(
    os.tmpdir(),
    'upl-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.msg'
  );
  await fs.promises.writeFile(tmp, buffer);
  try {
    const out = execFileSync(PYTHON, ['/app/msg_to_json.py', tmp], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    });
    const j = JSON.parse(out);
    j.attachments = (j.attachments || []).map(a => ({
      ...a,
      data: Buffer.from(a.data, 'base64'),
      contentId: (a.contentId || '').toLowerCase()
    }));
    return { kind: 'msg', ...j };
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

function renderHtmlWithCidImages(doc, html, cidMap) {
  // Render text without dumping insanely long hrefs (SafeLinks)
  const opts = {
    wordwrap: 120,
    preserveNewlines: true,
    selectors: [
      { selector: 'a', options: { ignoreHref: true, noLinkBrackets: true } },
      { selector: 'img', format: 'skip' } // images inserted separately
    ]
  };

  // Insert inline CID images in place
  const re = /<img[^>]+src=["']cid:([^"']+)["'][^>]*>/gi;
  let idx = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    const before = html.slice(idx, m.index);
    const txt = htmlToText(before, opts);
    if (txt.trim()) doc.fontSize(11).text(txt).moveDown(0.3);

    const cid = m[1].trim().toLowerCase().replace(/[<>]/g, '');
    const buf = cidMap.get(cid) || cidMap.get(`<${cid}>`);
    if (buf) {
      try {
        const maxW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        doc.image(buf, { fit: [maxW, 260] }).moveDown(0.5);
      } catch (_) {}
    }
    idx = re.lastIndex;
  }
  const rest = html.slice(idx);
  const restTxt = htmlToText(rest, opts);
  if (restTxt.trim()) doc.fontSize(11).text(restTxt);
}

async function buildPdf(parsed, { includeBrand = false } = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const chunks = [];
  doc.on('data', d => chunks.push(d));
  const done = new Promise(r => doc.on('end', r));

  // Unicode fonts
  const REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  if (fs.existsSync(REG)) doc.font(REG);

  // Branding removed by default (set includeBrand=true to show)
  if (includeBrand) {
    doc.font(fs.existsSync(BOLD) ? BOLD : REG).fontSize(9).fillColor('#666')
      .text('OrdoLux Email → PDF', { align: 'right' })
      .moveDown(0.2)
      .fillColor('black');
  }

  // Subject
  if (parsed.subject) {
    doc.font(fs.existsSync(BOLD) ? BOLD : REG).fontSize(16).text(parsed.subject);
    doc.moveDown(0.3);
  }

  // Headers
  doc.fontSize(9);
  doc.font(fs.existsSync(BOLD) ? BOLD : REG).text('From: ', { continued: true })
     .font(REG).text(formatAddrs(parsed.from));
  if (parsed.to?.length) {
    doc.font(fs.existsSync(BOLD) ? BOLD : REG).text('To: ', { continued: true })
       .font(REG).text(formatAddrs(parsed.to));
  }
  if (parsed.cc?.length) {
    doc.font(fs.existsSync(BOLD) ? BOLD : REG).text('Cc: ', { continued: true })
       .font(REG).text(formatAddrs(parsed.cc));
  }
  if (parsed.date) {
    const d = new Date(parsed.date);
    doc.font(fs.existsSync(BOLD) ? BOLD : REG).text('Date: ', { continued: true })
       .font(REG).text(d.toString());
  }

  // Divider
  const x1 = doc.page.margins.left;
  const x2 = doc.page.width - doc.page.margins.right;
  doc.moveDown(0.5).lineWidth(0.5).strokeColor('#888')
     .moveTo(x1, doc.y).lineTo(x2, doc.y).stroke().moveDown(0.6);

  // Inline images map
  const cidMap = new Map();
  (parsed.attachments || []).forEach(a => {
    if (a.inline && a.contentId) cidMap.set(a.contentId.replace(/[<>]/g, ''), a.data);
  });

  // Body: prefer HTML for proper punctuation/encoding + images
  if (parsed.html && parsed.html.trim()) {
    renderHtmlWithCidImages(doc, parsed.html, cidMap);
  } else if (parsed.text && parsed.text.trim()) {
    doc.font(REG).fontSize(11).text(parsed.text);
  } else {
    doc.font(REG).fontSize(11).fillColor('#666').text('(no message body)').fillColor('black');
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

// ---------- route ----------

app.post('/convert', guard, async (req, res) => {
  try {
    const { fileBase64, filename, options = {} } = req.body || {};
    if (!fileBase64 || !filename) {
      return res.status(422).json({ error: 'fileBase64 and filename are required' });
    }
    const buf = Buffer.from(fileBase64, 'base64');
    const lower = String(filename).toLowerCase();

    let parsed;
    if (lower.endsWith('.eml')) parsed = await parseEml(buf);
    else if (lower.endsWith('.msg')) parsed = await parseMsg(buf);
    else return res.status(415).json({ error: 'Only .eml or .msg files are supported' });

    const pdf = await buildPdf(parsed, { includeBrand: false });

    const wantsJson = (req.get('Accept') || '').includes('application/json');
    if (wantsJson) return res.json({ ok: true, filename, bytes: pdf.length });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName(filename)}.pdf"`);
    res.end(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`OrdoLux email→pdf listening on :${PORT}`));
