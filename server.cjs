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
      if
