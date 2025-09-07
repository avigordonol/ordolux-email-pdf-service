// OrdoLux Email→PDF microservice (Railway)
// - Accepts fileBase64 or fileUrl
// - Auth: X-Ordolux-Secret OR HMAC of raw JSON (X-Ordolux-Signature / X-Ordolux-Signature-Base)
// - Returns a real PDF (stub content for now) so upload + piping works

import express from 'express';
import crypto from 'crypto';
import { jsPDF } from 'jspdf';

const app = express();
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const PORT = process.env.PORT || 8080;

// Capture raw body for HMAC and raise size limit (big .msg base64)
app.use(express.json({
  limit: '50mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

// ---------------- Auth helpers ----------------
function verifyAuth(req) {
  // Option A: exact shared secret
  const headerSecret = req.get('x-ordolux-secret') || '';
  if (headerSecret && SHARED_SECRET && headerSecret === SHARED_SECRET) return true;

  // Option B: HMAC of raw JSON body
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const gotHex = req.get('x-ordolux-signature') || '';        // sha256=<hex>
  const gotB64 = req.get('x-ordolux-signature-base') || '';   // sha256_b64=<base64>

  if (!SHARED_SECRET || (!gotHex && !gotB64)) return false;

  const digest = crypto.createHmac('sha256', SHARED_SECRET).update(raw).digest();
  const expectHex = 'sha256=' + digest.toString('hex');
  const expectB64 = 'sha256_b64=' + digest.toString('base64');

  const b = s => Buffer.from(String(s));
  try { if (gotHex && crypto.timingSafeEqual(b(expectHex), b(gotHex))) return true; } catch {}
  try { if (gotB64 && crypto.timingSafeEqual(b(expectB64), b(gotB64))) return true; } catch {}
  return false;
}

// ---------------- Routes ----------------
app.get('/healthz', (req, res) => {
  if (!SHARED_SECRET) return res.status(500).json({ ok: false, error: 'SHARED_SECRET not set' });
  const ok = (req.get('x-ordolux-secret') || '') === SHARED_SECRET;
  if (!ok) return res.status(401).json({ ok: false, error: 'Unauthorised' });
  return res.json({ ok: true });
});

app.post('/convert', async (req, res) => {
  try {
    if (!verifyAuth(req)) {
      return res.status(401).json({ ok: false, error: 'Invalid signature' });
    }

    const { fileBase64, fileUrl, filename = 'Email.msg', options = {} } = req.body || {};
    let emailBytes;

    if (fileBase64) {
      try {
        emailBytes = Buffer.from(String(fileBase64), 'base64');
      } catch {
        return res.status(400).json({ ok: false, error: 'bad fileBase64' });
      }
    } else if (fileUrl) {
      const r = await fetch(fileUrl);
      if (!r.ok) return res.status(400).json({ ok: false, error: `cannot fetch fileUrl (${r.status})` });
      const ab = await r.arrayBuffer();
      emailBytes = new Uint8Array(ab);
    } else {
      return res.status(400).json({ ok: false, error: 'fileUrl or fileBase64 is required' });
    }

    if (!emailBytes || !emailBytes.length) {
      return res.status(400).json({ ok: false, error: 'empty input bytes' });
    }

    // ======== TODO: plug in your real .msg/.eml → PDF converter here ========
    // For now we return a valid “stub” PDF so upload and piping work end-to-end.

    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const m = 40;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('OrdoLux Email→PDF (stub PDF)', m, m + 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    let y = m + 36;
    const lines = [
      'This confirms your service accepted the payload and can stream a PDF back.',
      'Swap the stub block for your actual converter once ready.',
      `Filename: ${filename}`,
      `Input bytes: ${emailBytes.length}`,
      `Options: ${JSON.stringify(options)}`
    ];
    lines.forEach(s => { doc.text(s, m, y); y += 16; });

    const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
    res.setHeader('Content-Type', 'application/pdf');
    return res.status(200).send(pdfBuffer);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Fallback
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`OrdoLux email-pdf service listening on :${PORT}`);
});
