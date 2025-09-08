// OrdoLux Email→PDF – stable PDFKit build with diagnostics
const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { simpleParser } = require('mailparser');
const he = require('he');
const PDFDocument = require('pdfkit');
const pkg = require('./package.json');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.ORDOLUX_SECRET || null;
const PY = '/opt/pyenv/bin/python3';
const PY_SCRIPT = path.join(__dirname, 'msg_to_json.py');
const FONT_PATH = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const app = express();

// JSON body parser with explicit error handler
app.use(express.json({ limit: '100mb' }));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'payload too large' });
  }
  if (err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: 'invalid JSON body' });
  }
  next();
});

function auth(req, res) {
  if (!SECRET) return true;
  const got = req.header('x-ordolux-secret');
  if (got === SECRET) return true;
  res.status(401).json({
