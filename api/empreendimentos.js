// Empreendimentos públicos do site: vêm do CRM (página Empreendimentos).
// Só os marcados para aparecer no site, na ordem escolhida no CRM.
import { sql, ensureSchema, cors, ok, err, fail } from './_lib.js';

const https = (u) => typeof u === 'string' && /^https:\/\//.test(u);
const fotoUrl = (f) => (typeof f === 'string' ? f : f && f.url);
function linhas(v) {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v || '').split(/\n|,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
}
function pares(v) {
  if (Array.isArray(v)) return v.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [String(p[0]), String(p[1])]);
  return String(v || '').split('\n').map((l) => l.split('|').map((s) => s.trim())).filter((p) => p.length >= 2 && p[0] && p[1]).map((p) => [p[0], p.slice(1).join(' | ')]);
}
function coords(v) {
  if (Array.isArray(v) && v.length === 2) return v.map(Number);
  const m = String(v || '').match(/(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
}
function video(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^https:\/\/.+\.mp4(\?|$)/i.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(s) ? s : '';
}
function ordenarFotos(lista) {
  return (Array.isArray(lista) ? lista : []).slice()
    .sort((a, b) => (b && b.principal ? 1 : 0) - (a && a.principal ? 1 : 0))
    .map(fotoUrl).filter(https);
}

export function paraSite(e) {
  const destaques = (Array.isArray(e.destaques) ? e.destaques : pares(e.destaques).map((p) => ({ n: p[0], l: p[1] })))
    .filter((d) => d && d.n).map((d) => ({ n: String(d.n), l: String(d.l || '') }));
  return {
    id: String(e.id),
    nome: String(e.nome || 'Empreendimento'),
    cidade: String(e.cidade || '').replace(/-SC$/i, '').trim() || 'SC',
    estado: e.estado || 'SC',
    status: e.status || 'Lançamento',
    tipoLabel: e.tipoLabel || '',
    preco: e.preco || 'Sob consulta',
    descricao: String(e.descricao || ''),
    destaques,
    diferenciais: linhas(e.diferenciais),
    lazer: linhas(e.lazer),
    fotos: ordenarFotos(e.fotos),
    lazerFotos: (Array.isArray(e.lazerFotos) ? e.lazerFotos : []).map(fotoUrl).filter(https),
    plantas: (Array.isArray(e.plantas) ? e.plantas : []).filter((p) => p && https(p.url || p.img))
      .map((p) => ({ nome: p.nome || 'Planta', sub: p.sub || '', img: p.url || p.img })),
    video: video(e.video),
    endereco: e.endereco || '',
    coords: coords(e.coords),
    aprox: e.aprox !== false,
    proximidades: pares(e.proximidades),
    ficha: pares(e.ficha),
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return err(res, 405, 'Somente leitura. Cadastre empreendimentos pelo CRM.');
  try {
    await ensureSchema();
    const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'empreendimentos'");
    const lista = Array.isArray(r[0] && r[0].valor) ? r[0].valor : [];
    const data = lista.filter((e) => e && e.publicarSite !== false)
      .sort((a, b) => (+a.ordem || 0) - (+b.ordem || 0)).map(paraSite);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
    return ok(res, { data, total: data.length });
  } catch (e) { return fail(res, e); }
}
