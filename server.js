/* CommonJS server with .eml + .msg support.
   - EML: parsed with mailparser
   - MSG: parsed via /opt/pyenv/bin/python msg_to_json.py (extract_msg)
   - Renders a cover PDF with PDFKit, and merges any PDF attachments using pdf-lib
*/
const express = require('express');
const { simpleParser } = require('mailparser');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFLib } = require('pdf-lib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || ''; // you already set this in Railway

app.use(express.json({ limit: '30mb' }));

app.get('/healthz', (req, res) => {
  const ok = req.header('X-Ordolux-Secret') === SHARED_SECRET;
  res.status(ok ? 200 : 401).json({ ok });
});

app.post('/convert', async (req, res) => {
  try {
    if (req.header('X-Ordolux-Secret') !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const { fileBase64, filename, options = {} } = req.body || {};
    if (!fileBase64 || !filename) {
      return res.status(422).json({ ok: false, error: 'Missing fileBase64 or filename' });
    }

    const bytes = Buffer.from(fileBase64, 'base64');
    const isEML = /\.eml$/i.test(filename);
    const isMSG = /\.msg$/i.test(filename);

    let cover = null;           // { title, headers (obj), bodyText }
    let pdfAttachments = [];    // [{ filename, bytes }]

    if (isEML) {
      // Parse with mailparser
      const parsed = await simpleParser(bytes);
      cover = {
        title: parsed.subject || '(no subject)',
        headers: {
          From: parsed.from && parsed.from.text || '',
          To: parsed.to && parsed.to.text || '',
          Cc: parsed.cc && parsed.cc.text || '',
          Date: parsed.date ? parsed.date.toISOString() : ''
        },
        bodyText: (parsed.text || parsed.html || '').toString()
      };
      // If there are PDFs attached and merge requested, collect them
      if (options.mergeAttachments && parsed.attachments && parsed.attachments.length) {
        for (const a of parsed.attachments) {
          if ((a.contentType || '').toLowerCase() === 'application/pdf') {
            pdfAttachments.push({ filename: a.filename || 'attachment.pdf', bytes: Buffer.from(a.content) });
          }
        }
      }
    } else if (isMSG) {
      // Hand off to Python helper (extract_msg)
      const py = spawn('/opt/pyenv/bin/python', ['-u', 'msg_to_json.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const payload = JSON.stringify({ fileBase64 });
      py.stdin.write(payload); py.stdin.end();

      let out = '', err = '';
      py.stdout.on('data', d => out += d.toString());
      py.stderr.on('data', d => err += d.toString());
      const code = await new Promise(resolve => py.on('close', resolve));

      if (code !== 0) {
        return res.status(500).json({ ok: false, error: 'Python exited ' + code, stderr: err });
      }
      let j;
      try { j = JSON.parse(out); } catch (e) {
        return res.status(500).json({ ok: false, error: 'Bad JSON from python', out });
      }
      if (!j.ok) return res.status(422).json({ ok: false, error: j.error || 'MSG parse failed' });

      const m = j.message || {};
      cover = {
        title: m.subject || '(no subject)',
        headers: { From: m.from || '', To: m.to || '', Cc: m.cc || '', Date: m.date || '' },
        bodyText: m.bodyText || ''
      };
      if (options.mergeAttachments && Array.isArray(m.attachments)) {
        for (const a of m.attachments) {
          if ((a.content_type || '').toLowerCase() === 'application/pdf' && a.base64) {
            pdfAttachments.push({ filename: a.filename || 'attachment.pdf', bytes: Buffer.from(a.base64, 'base64') });
          }
        }
      }
    } else {
      return res.status(422).json({ ok: false, error: 'Unsupported file type (use .eml or .msg)' });
    }

    // Render the cover email to a PDF buffer
    const coverPdf = await renderCoverPdf(cover);

    // Merge attachments (PDF only) after the cover
    const merged = await mergePdfs(coverPdf, pdfAttachments);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeName(filename)}.pdf"`);
    return res.status(200).send(Buffer.from(merged));
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.listen(PORT, () => console.log('listening on', PORT));

function safeName(n) {
  return String(n || 'email').replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_');
}
function renderCoverPdf({ title, headers, bodyText }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', d => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text(title || '(no subject)');
    doc.moveDown(0.5);
    doc.fontSize(11).font('Helvetica');
    const order = ['From','To','Cc','Date'];
    order.forEach(k => {
      const v = headers && headers[k] ? String(headers[k]) : '';
      if (v.trim()) doc.text(`${k}: ${v}`);
    });
    doc.moveDown(0.5);
    doc.moveTo(doc.x, doc.y).lineTo(555, doc.y).strokeColor('#888').stroke();
    doc.moveDown(0.75);

    const body = (bodyText || '').toString();
    doc.fontSize(12).fillColor('#000').text(body.length ? body : '(no body)', { align: 'left' });

    doc.end();
  });
}
async function mergePdfs(coverPdfBuf, attachmentList) {
  // Start with the cover
  let outDoc = await PDFLib.load(coverPdfBuf);
  for (const att of (attachmentList || [])) {
    try {
      const attDoc = await PDFLib.load(att.bytes);
      const pages = await outDoc.copyPages(attDoc, attDoc.getPageIndices());
      pages.forEach(p => outDoc.addPage(p));
    } catch (e) {
      // skip bad PDFs but continue
      console.error('skip bad attachment', att.filename, e.message);
    }
  }
  return await outDoc.save();
}
