import express from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import fetch from "node-fetch";
import { getDocument } from "pdfjs-dist";
import { createCanvas } from "canvas";
import * as ZXing from "@zxing/library";
import jsQR from "jsqr";
import Tesseract from "tesseract.js";

const app = express();
app.use(express.json({ limit: "30mb" }));
const upload = multer({ storage: multer.memoryStorage() });
const USE_OCR = (process.env.USE_OCR || "true") === "true";

// ---------------- Helpers ----------------
const onlyDigits = s => (s || "").replace(/\D/g, "");

function validaChave44(ch) {
  const k = onlyDigits(ch);
  if (k.length !== 44) return false;
  const validUF = new Set([11,12,13,14,15,16,17,21,22,23,24,25,26,27,28,29,31,32,33,35,41,42,43,50,51,52,53]);
  const cUF = +k.slice(0,2), mes = +k.slice(4,6), mod = k.slice(20,22);
  if (!validUF.has(cUF) || mes < 1 || mes > 12) return false;
  if (mod !== "55" && mod !== "65") return false;
  // Validação do dígito verificador
  const body = k.slice(0,43).split("").map(Number);
  let peso = 2, soma = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    soma += body[i] * peso;
    peso = (peso === 9) ? 2 : (peso + 1);
  }
  const resto = soma % 11;
  const dv = (resto === 0 || resto === 1) ? 0 : (11 - resto);
  return dv === Number(k[43]);
}

function pickChaveFromText(text) {
  if (!text) return null;
  const norm = text.replace(/\s+/g, " ");
  const re = /(?:chave\s*de\s*acesso[^0-9]*)?((?:\D*\d){44})/i;
  const m = norm.match(re);
  if (!m) return null;
  const k = onlyDigits(m[1]);
  return (k.length === 44 && validaChave44(k)) ? k : null;
}

function pickChaveFromURL(url) {
  if (!url) return null;
  const u = decodeURIComponent(url);
  const m1 = u.match(/[?&]chNFe=([0-9]{44})/i);
  if (m1 && validaChave44(m1[1])) return m1[1];
  const m2 = u.match(/([0-9]{44})/);
  if (m2 && validaChave44(m2[1])) return m2[1];
  return null;
}

async function extractFromText(pdfBuf) {
  const data = await pdfParse(pdfBuf);
  return pickChaveFromText(data.text);
}

async function renderPdfPages(pdfBuffer, dpi = 300) {
  const loadingTask = getDocument({ data: pdfBuffer });
  const pdf = await loadingTask.promise;
  const canvases = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const base = createCanvas(viewport.width, viewport.height);
    await page.render({ canvasContext: base.getContext("2d"), viewport }).promise;
    // Gira para tentar todas as orientações
    for (const angle of [0,90,180,270]) {
      if (angle === 0) { canvases.push(base); continue; }
      const c = createCanvas(base.height, base.width);
      const ctx = c.getContext("2d");
      ctx.translate(c.width/2, c.height/2);
      ctx.rotate(angle * Math.PI/180);
      ctx.drawImage(base, -base.width/2, -base.height/2);
      canvases.push(c);
    }
  }
  return canvases;
}

function tryDecodeQR(canvas) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0,0,canvas.width,canvas.height);
  const qr = jsQR(img.data, canvas.width, canvas.height);
  if (qr?.data) return pickChaveFromURL(qr.data) || pickChaveFromText(qr.data);
  return null;
}

function tryDecodeCode128(canvas) {
  try {
    const src = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    const bin = new ZXing.GlobalHistogramBinarizer(src);
    const bmp = new ZXing.BinaryBitmap(bin);
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS,[ZXing.BarcodeFormat.CODE_128]]]));
    const res = reader.decode(bmp);
    const k = onlyDigits(res.getText());
    return (k.length===44 && validaChave44(k)) ? k : null;
  } catch { return null; }
}

async function tryOCR(canvas) {
  if (!USE_OCR) return null;
  const png = canvas.toBuffer("image/png");
  const out = await Tesseract.recognize(png, "por", { tessedit_char_whitelist: "0123456789" });
  return pickChaveFromText(out.data?.text || "") || null;
}

async function extractKey(pdfBuf) {
  const t = await extractFromText(pdfBuf);
  if (t) return t;
  const canvases = await renderPdfPages(pdfBuf, 300);
  for (const c of canvases) {
    const qr = tryDecodeQR(c); if (qr) return qr;
    const b = tryDecodeCode128(c); if (b) return b;
  }
  if (USE_OCR) {
    for (const c of canvases) {
      const o = await tryOCR(c); if (o) return o;
    }
  }
  throw new Error("Chave não encontrada no PDF (texto/QR/Code128/OCR).");
}

function mapSerproToDashboard(json, chaveFallback) {
  const nfe = json?.NFe?.infNFe;
  const emit = nfe?.emit || json?.emitente || {};
  const dest = nfe?.dest || json?.destinatario || {};
  const ide  = nfe?.ide  || json?.ide || {};
  const tot  = nfe?.total?.ICMSTot || json?.total || {};
  return {
    chave_acesso: json?.chNFe || json?.chave || chaveFallback || null,
    numero: ide?.nNF || json?.numero || null,
    serie: ide?.serie || json?.serie || null,
    data_emissao: ide?.dhEmi || ide?.dEmi || null,
    cnpj_emitente: emit?.CNPJ || emit?.cnpj || null,
    nome_emitente: emit?.xNome || emit?.razaoSocial || null,
    cnpj_destinatario: dest?.CNPJ || dest?.cnpj || null,
    nome_destinatario: dest?.xNome || dest?.razaoSocial || null,
    valor_total: tot?.vNF || json?.valorTotal || null,
    modelo: ide?.mod || null,
    uf: ide?.cUF || null
  };
}

// ---------------- Rotas ----------------

// Upload de PDF
app.post("/extract-key", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) throw new Error("Arquivo PDF obrigatório (file).");
    const chave = await extractKey(req.file.buffer);
    res.json({ ok: true, chave });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Processar NF (extrair chave + consultar SERPRO)
app.post("/process", async (req, res) => {
  try {
    const { pdfUrl, chave: chaveInput, serproBaseUrl, serproToken, serproPathTemplate } = req.body || {};
    if (!serproBaseUrl || !serproToken) throw new Error("Informe serproBaseUrl e serproToken.");
    const pathTpl = serproPathTemplate || "nfe/:chave";

    let chave = onlyDigits(chaveInput || "");
    if (!chave) {
      if (!pdfUrl) throw new Error("Envie 'chave' ou 'pdfUrl'.");
      const pdfResp = await fetch(pdfUrl);
      if (!pdfResp.ok) throw new Error(`Falha ao baixar PDF (${pdfResp.status})`);
      const buf = Buffer.from(await pdfResp.arrayBuffer());
      chave = await extractKey(buf);
    }
    if (!validaChave44(chave)) throw new Error("Chave inválida.");

    const url = `${serproBaseUrl.replace(/\/+$/,"")}/${pathTpl.replace(":chave", chave)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${serproToken}`, Accept: "application/json" }});
    if (!resp.ok) {
      const t = await resp.text().catch(()=> "");
      throw new Error(`SERPRO ${resp.status}: ${t.slice(0,250)}`);
    }
    const json = await resp.json();
    const mapped = mapSerproToDashboard(json, chave);
    res.json({ ok: true, chave, nfe: mapped, raw: json });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NFE Extractor API (full) rodando na porta ${PORT}`));
