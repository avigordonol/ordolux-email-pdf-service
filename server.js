// OrdoLux Email→PDF microservice (no msgreader; uses msgconvert for .msg)
// - Accepts { fileBase64?, fileUrl?, filename?, options?{mergeAttachments} }
// - Auth: X-Ordolux-Secret must equal process.env.SHARED_SECRET
// - Returns application/pdf (email cover page; merges PDF attachments if asked)

import express from 'express';
import { simpleParser } from 'mailparser';
import { jsPDF } from 'jspdf';
import { PDFDocument } from 'pdf-lib';
import he from 'he';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);
const app = express();
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '50mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/convert', async (req, res) => {
  try {
    // Auth
    const sent = req.header('X-Ordolux-Secret') || '';
    if (!SHARED_SECRET || sent !== SHARED_SECRET) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }

    const body = req.body || {};
    const fileBase64 = body.fileBase64 || null;
    const fileUrl = body.fileUrl || null;
    const filename = (body.filename || 'Email.eml').trim();
    const options = body.options || {};

    if (!fileBase64 && !fileUrl) {
      return res.status(400).json({ ok: false, error: 'Provide fileBase64 or fileUrl' });
    }

    // Fetch/Decode bytes
    let bytes;
    if (fileBase64) {
      bytes = Buffer.from(fileBase64, 'base64');
    } else {
      const r = await fetch(fileUrl);
      if (!r.ok) return res.status(400).json({ ok: false, error: `download ${r.status}` });
      bytes = Buffer.from(await r.arrayBuffer());
    }

    // If .msg, convert to .eml via msgconvert; else treat as .eml
    let emlBuffer;
    if (/\.msg$/i.test(filename)) {
      emlBuffer = await msgToEml(bytes);
    } else {
      emlBuffer = bytes;
    }

    // Parse email
    const parsed = await simpleParser(emlBuffer);
    const title = parsed.subject || '(no subject)';
    const meta = {
      From: parsed.from?.text || '',
      To: parsed.to?.text || '',
      Cc: parsed.cc?.text || '',
      Date: parsed.date ? parsed.date.toISOString() : ''
    };

    let bodyText = (parsed.text || '').trim();
    if (!bodyText && parsed.html) bodyText = htmlToText(parsed.html);

    // Build cover PDF for the email body
    const coverBytes = renderEmailPDF({
      title,
      meta,
      bodyText: bodyText || '(no body)'
    });

    // If asked, merge any PDF attachments after the cover
    let outBytes = coverBytes;
    if (options.mergeAttachments && Array.isArray(parsed.attachments) && parsed.attachments.length) {
      outBytes = await mergePdfAndPdfAttachments(coverBytes, parsed.attachments);
    }

    res.setHeader('Content-Type', 'application/pdf');
    return res.send(Buffer.from(outBytes));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log('Email→PDF listening on :' + PORT);
});

// ---- helpers ----

async function msgToEml(msgBytes) {
  const id = Math.random().toString(36).slice(2);
  const inPath = `/tmp/${id}.msg`;
  const outPath = `/tmp/${id}.eml`;
  await fs.writeFile(inPath, msgBytes);
  try {
    // msgconvert comes from libemail-outlook-message-perl
    await execFileP('msgconvert', ['--outfile', outPath, inPath], { timeout: 30_000 });
    const eml = await fs.readFile(outPath);
    return eml;
  } finally {
    // best-effort cleanup
    await fs.rm(inPath, { force: true }).catch(() => {});
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n• ');
  s = s.replace(/<[^>]+>/g, '');
  s = he.decode(s);
  s = s.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function renderEmailPDF({ title, meta, bodyText }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const m = 40, width = 595.28 - m * 2;
  let y = m;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  y = addWrapped(doc, title, m, y, width, 20);

  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  for (const key of ['From', 'To', 'Cc', 'Date']) {
    const v = meta[key];
    if (v && String(v).trim()) y = addWrapped(doc, key + ': ' + v, m, y, width, 16);
  }
  doc.setLineWidth(0.5); doc.line(m, y + 5, m + width, y + 5); y += 20;

  doc.setFontSize(12);
  y = addWrapped(doc, String(bodyText || '').slice(0, 800000), m, y, width, 16);
  return doc.output('arraybuffer');
}

function addWrapped(doc, text, x, y, maxWidth, lineHeight) {
  const parts = doc.splitTextToSize(text || '', maxWidth);
  for (let i = 0; i < parts.length; i++) {
    if (y > 800) { doc.addPage(); y = 40; }
    doc.text(parts[i], x, y);
    y += lineHeight;
  }
  return y;
}

async function mergePdfAndPdfAttachments(coverArrayBuffer, attachments) {
  const out = await PDFDocument.create();

  // add the cover first
  const coverDoc = await PDFDocument.load(coverArrayBuffer);
  const coverPages = await out.copyPages(coverDoc, coverDoc.getPageIndices());
  coverPages.forEach(p => out.addPage(p));

  // append any PDF attachments
  for (const a of attachments) {
    const ct = String(a.contentType || '').toLowerCase().trim();
    if (ct === 'application/pdf' && a.content && a.content.length) {
      try {
        const attDoc = await PDFDocument.load(a.content);
        const pages = await out.copyPages(attDoc, attDoc.getPageIndices());
        pages.forEach(p => out.addPage(p));
      } catch (_e) {
        // ignore broken PDFs
      }
    }
  }
  return out.save();
}
