// Upload de fotos/plantas do CRM para o Vercel Blob (só com X-Admin-Key)
// Envie JSON: { nome: "sala.jpg", pasta: "imoveis/hl101", data: "<base64 ou dataURL>" }
import { put } from '@vercel/blob';
import { cors, body, ok, err } from './_lib.js';
import { sessao, pode } from './_auth.js';

const TIPOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'video/mp4': 'mp4' };

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return err(res, 405, 'Use POST.');
  const s = await sessao(req).catch(() => null);
  if (!pode(s, 'upload')) return err(res, 401, 'Chave de administrador inválida.');
  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) return err(res, 503, 'Armazenamento de fotos não conectado. Veja o LEIA-ME, passo 4.');
  try {
    const b = body(req);
    let data = String(b.data || ''), tipo = String(b.tipo || '');
    const m = data.match(/^data:([\w/+.-]+);base64,(.*)$/s);
    if (m) { tipo = m[1]; data = m[2]; }
    if (!TIPOS[tipo]) return err(res, 415, 'Formato não aceito. Use JPG, PNG, WEBP, PDF ou MP4.');
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) return err(res, 400, 'Arquivo vazio.');
    if (buf.length > 4 * 1024 * 1024) return err(res, 413, 'Arquivo acima de 4 MB. Reduza a foto antes de enviar.');
    const pasta = String(b.pasta || 'geral').replace(/[^\w\-/]/g, '-').replace(/\.\.+/g, '').slice(0, 80);
    const nome = String(b.nome || 'arquivo').replace(/\.[^.]*$/, '').replace(/[^\w\-]/g, '-').slice(0, 60) + '.' + TIPOS[tipo];
    const blob = await put(`${pasta}/${nome}`, buf, { access: 'public', contentType: tipo, addRandomSuffix: true });
    return ok(res, { url: blob.url });
  } catch (e) {
    console.error(e);
    return err(res, 500, 'Falha no upload: ' + (e.message || 'erro desconhecido'));
  }
}
