//
// OrdoLux Email → PDF microservice
// POST /convert  { filename, content_base64 } -> { ok, pdf_base64, filename, meta }
// Health: GET /healthz -> { ok: true }
import express from "express";
import crypto from "crypto";
import { simpleParser } from "mailparser";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;
const MAX_BYTES = Number(process.env.MAX_BYTES || 26214400);
const SHARED_SECRET = process.env.SHARED_SECRET || "";

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/convert", express.raw({ type: "application/json", limit: `${Math.floor(MAX_BYTES * 1.5)}b` }), async (req, res) => {
  try {
    const raw = req.body;
    if (!raw || !Buffer.isBuffer(raw)) return res.status(400).json({ ok:false, error:"Expected application/json body" });
    const sig = req.header("x-ordolux-signature") || "";
    if (!verifyHmac(raw, sig, SHARED_SECRET)) return res.status(401).json({ ok:false, error:"Invalid signature" });

    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); }
    catch { return res.status(400).json({ ok:false, error:"Invalid JSON" }); }

    const { filename, content_base64 } = payload || {};
    if (!filename || !content_base64) return res.status(400).json({ ok:false, error:"filename and content_base64 required" });
    const buf = Buffer.from(content_base64, "base64");
    if (!buf.length) return res.status(400).json({ ok:false, error:"Empty content_base64" });
    if (buf.length > MAX_BYTES) return res.status(413).json({ ok:false, error:"File too large" });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ordolux-"));
    try {
      const ext = path.extname(filename).toLowerCase();
      const inPath = path.join(tmp, "input" + ext);
      fs.writeFileSync(inPath, buf);

      // 1) Ensure EML
      let emlPath = inPath;
      if (ext === ".msg") {
        emlPath = path.join(tmp, "mail.eml");
        await run("msgconvert", ["--outfile", emlPath, inPath], 60000);
        if (!fs.existsSync(emlPath)) throw new Error("msgconvert failed");
      } else if (ext !== ".eml") {
        throw new Error("Unsupported file type (use .msg or .eml)");
      }

      // 2) Parse MIME
      const parsed = await simpleParser(fs.readFileSync(emlPath));
      const subject = parsed.subject || "(no subject)";
      const from = parsed.from?.text || "";
      const to = parsed.to?.text || "";
      const cc = parsed.cc?.text || "";
      const date = parsed.date ? new Date(parsed.date).toUTCString() : "";

      // 3) Render cover to PDF
      let bodyHtml = parsed.html || "";
      if (!bodyHtml) {
        const text = parsed.text || "";
        bodyHtml = `<pre style="white-space:pre-wrap;font-family:system-ui,Segoe UI,Arial;font-size:12pt;line-height:1.4">${escapeHtml(text)}</pre>`;
      }
      const coverHtml = path.join(tmp, "cover.html");
      fs.writeFileSync(coverHtml, wrapHtml(subject, from, to, cc, date, bodyHtml), "utf8");
      const coverPdf = path.join(tmp, "cover.pdf");
      await run("wkhtmltopdf", [
        "--disable-external-links","--disable-local-file-access","--print-media-type",
        "--page-size","A4","--margin-top","10mm","--margin-bottom","12mm","--margin-left","12mm","--margin-right","12mm",
        coverHtml, coverPdf
      ], 60000);
      const pdfs = [coverPdf];

      // 4) Attachments -> PDF
      const atts = Array.isArray(parsed.attachments) ? parsed.attachments : [];
      for (let i = 0; i < atts.length; i++) {
        const a = atts[i];
        if (!a?.content?.length) continue;
        const attName = (a.filename || `attachment_${i+1}`).replace(/[^\w\s.-]/g, "_");
        const attPath = path.join(tmp, attName);
        fs.writeFileSync(attPath, a.content);
        const outPdf = path.join(tmp, `att_${i+1}.pdf`);

        const mime = (a.contentType || "").toLowerCase();
        const aExt = path.extname(attName).toLowerCase();

        if (mime === "application/pdf" || aExt === ".pdf") { fs.copyFileSync(attPath, outPdf); pdfs.push(outPdf); continue; }
        if (mime.startsWith("image/") || [".png",".jpg",".jpeg",".gif",".tif",".tiff",".bmp",".webp"].includes(aExt)) {
          await run("convert", [attPath, outPdf], 30000);
          if (fs.existsSync(outPdf)) pdfs.push(outPdf);
          continue;
        }
        if (mime === "text/html" || aExt === ".html" || aExt === ".htm") {
          await run("wkhtmltopdf", [
            "--disable-external-links","--disable-local-file-access","--print-media-type",
            "--page-size","A4","--margin-top","10mm","--margin-bottom","12mm","--margin-left","12mm","--margin-right","12mm",
            attPath, outPdf
          ], 45000);
          if (fs.existsSync(outPdf)) pdfs.push(outPdf);
          continue;
        }
        if (mime.startsWith("text/") || [".txt",".csv",".md"].includes(aExt)) {
          const htmlTmp = path.join(tmp, `att_${i+1}.html`);
          const txt = fs.readFileSync(attPath, "utf8");
          fs.writeFileSync(htmlTmp, `<pre style="white-space:pre-wrap;font-family:system-ui,Segoe UI,Arial;font-size:11pt;line-height:1.4">${escapeHtml(txt)}</pre>`, "utf8");
          await run("wkhtmltopdf", ["--disable-external-links","--disable-local-file-access","--print-media-type","--page-size","A4", htmlTmp, outPdf], 30000);
          if (fs.existsSync(outPdf)) pdfs.push(outPdf);
          continue;
        }
        if (
          ["application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document",
           "application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
           "application/vnd.ms-powerpoint","application/vnd.openxmlformats-officedocument.presentationml.presentation"].includes(mime) ||
          [".doc",".docx",".xls",".xlsx",".ppt",".pptx",".rtf",".odt",".ods",".odp"].includes(aExt)
        ) {
          await run("libreoffice", ["--headless","--convert-to","pdf","--outdir", tmp, attPath], 90000);
          const loOut = path.join(tmp, path.basename(attPath, aExt) + ".pdf");
          if (fs.existsSync(loOut)) { pdfs.push(loOut); continue; }
        }
        if (mime === "message/rfc822" || aExt === ".eml") {
          const nestedPdf = await emlBufferToPdf(a.content, tmp, `nested_${i+1}`);
          if (nestedPdf && fs.existsSync(nestedPdf)) pdfs.push(nestedPdf);
          continue;
        }
        if (aExt === ".msg") {
          const nestedMsg = path.join(tmp, `nested_${i+1}.msg`);
          const nestedEml = path.join(tmp, `nested_${i+1}.eml`);
          fs.writeFileSync(nestedMsg, a.content);
          await run("msgconvert", ["--outfile", nestedEml, nestedMsg], 45000);
          const nestedPdf = await emlBufferToPdf(fs.readFileSync(nestedEml), tmp, `nested_${i+1}`);
          if (nestedPdf && fs.existsSync(nestedPdf)) pdfs.push(nestedPdf);
          continue;
        }
      }

      const merged = path.join(tmp, "merged.pdf");
      if (pdfs.length === 1) fs.copyFileSync(coverPdf, merged);
      else {
        await run("pdfunite", [...pdfs, merged], 30000);
        if (!fs.existsSync(merged)) throw new Error("pdfunite failed");
      }

      const out64 = fs.readFileSync(merged).toString("base64");
      const outName = subjectToName(subject) + ".pdf";
      try { fs.rmSync(tmp, { recursive:true, force:true }); } catch {}
      return res.json({ ok:true, filename: outName, pdf_base64: out64, meta: { subject, from, to, cc, date, attachments: atts.length } });
    } catch (e) {
      try { fs.rmSync(tmp, { recursive:true, force:true }); } catch {}
      throw e;
    }
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

function verifyHmac(raw, headerValue, secret) {
  if (!secret) return true;
  if (!headerValue) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerValue)); }
  catch { return false; }
}
function run(cmd, args, timeoutMs=30000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore","pipe","pipe"] });
    let stderr = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stderr.on("data", d => { stderr += d.toString(); });
    p.on("exit", code => { clearTimeout(t); code===0 ? resolve(0) : reject(new Error(`${cmd} exited ${code}: ${stderr}`)); });
  });
}
function escapeHtml(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;").replace(/'/g,"&#39;");}
function wrapHtml(subject, from, to, cc, date, bodyHtml){
  return `<!doctype html><html><head><meta charset="utf-8">
  <style>body{font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:12pt;color:#111;margin:0;padding:24px;}
  h1{font-size:16pt;margin:0 0 8px 0}.meta{font-size:10pt;color:#333;margin:0 0 12px 0}.meta div{margin:2px 0}
  hr{border:0;border-top:1px solid #ccc;margin:12px 0}img{max-width:100%;height:auto}</style></head>
  <body><h1>${escapeHtml(subject)}</h1><div class="meta">
  ${from?`<div><b>From:</b> ${escapeHtml(from)}</div>`:""}
  ${to?`<div><b>To:</b> ${escapeHtml(to)}</div>`:""}
  ${cc?`<div><b>Cc:</b> ${escapeHtml(cc)}</div>`:""}
  ${date?`<div><b>Date:</b> ${escapeHtml(date)}</div>`:""}
  </div><hr/><div class="body">${bodyHtml||""}</div></body></html>`;
}
function subjectToName(subj){
  const base = String(subj||"Email").replace(/[^\w\s.-]/g," ").replace(/\s+/g,"_").replace(/_+/g,"_").slice(0,80);
  return base || "Email";
}
async function emlBufferToPdf(buf, tmpDir, key){
  const p = await simpleParser(buf);
  let bodyHtml = p.html || "";
  if (!bodyHtml) {
    const text = p.text || "";
    bodyHtml = `<pre style="white-space:pre-wrap;font-family:system-ui,Segoe UI,Arial;font-size:12pt;line-height:1.4">${escapeHtml(text)}</pre>`;
  }
  const htmlPath = path.join(tmpDir, `${key}.html`);
  fs.writeFileSync(htmlPath, wrapHtml(p.subject||"(no subject)", p.from?.text||"", p.to?.text||"", p.cc?.text||"", p.date?new Date(p.date).toUTCString():"", bodyHtml), "utf8");
  const pdfPath = path.join(tmpDir, `${key}.pdf`);
  await run("wkhtmltopdf", ["--disable-external-links","--disable-local-file-access","--print-media-type","--page-size","A4", htmlPath, pdfPath], 45000);
  return pdfPath;
}

app.listen(PORT, () => console.log("OrdoLux converter on :" + PORT));
