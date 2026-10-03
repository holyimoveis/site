// Imóveis públicos do site: vêm direto do CRM (cadastros com "Publicar no site" marcado e status Disponível)
// Só campos de vitrine saem daqui: endereço exato e dados do proprietário nunca são enviados.
import { sql, ensureSchema, cors, ok, err, fail } from './_lib.js';

const n = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
const url = (u) => typeof u === 'string' && /^https:\/\//.test(u);

export function paraSite(im) {
  const fotos = (Array.isArray(im.fotos) ? im.fotos : [])
    .slice().sort((a, b) => (b && b.principal ? 1 : 0) - (a && a.principal ? 1 : 0))
    .map((f) => (typeof f === 'string' ? f : f && f.url)).filter(url);
  const cidade = String(im.cidade || '').replace(/-SC$/i, '').trim();
  return {
    id: String(im.id),
    ref: im.codigo || null,
    nome: String(im.nome || 'Imóvel'),
    tipo: im.tipo || 'Imóvel',
    finalidade: im.finalidade === 'Locação' ? 'Locação' : 'Venda',
    status: 'Disponível',
    cidade, estado: 'SC',
    bairro: im.bairro || '',
    area: n(im.area) || n(im.areaPrivativa) || n(im.areaUtil),
    areaPrivativa: n(im.areaPrivativa) || n(im.areaUtil),
    quartos: n(im.quartos), suites: n(im.suites), vagas: n(im.vagas),
    banheiros: n(im.banheiros), lavabos: n(im.lavabos),
    lazer: Array.isArray(im.lazer) ? im.lazer : [],
    valor: n(im.valor), condominio: n(im.condominio), iptu: n(im.iptu),
    andar: im.andares || null,
    destaque: String(im.seloSite || '').slice(0, 24) || (im.exclusividade ? 'Exclusividade Holy' : null),
    descricao: String(im.descricao || ''),
    diferenciais: Array.isArray(im.diferenciais) ? im.diferenciais : [],
    fotos,
    video: im.videoSite || '',
  };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return err(res, 405, 'Somente leitura. Cadastre imóveis pelo CRM.');
  try {
    await ensureSchema();
    const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'imoveis'");
    const lista = Array.isArray(r[0] && r[0].valor) ? r[0].valor : [];
    let data = lista.filter((im) => im && im.publicarSite === true && im.status === 'Disponível').map(paraSite);
    const q = req.query || {};
    if (q.id) {
      const one = data.find((d) => d.id === String(q.id));
      return one ? ok(res, { data: one }) : err(res, 404, 'Não encontrado.');
    }
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
    return ok(res, { data, total: data.length });
  } catch (e) { return fail(res, e); }
}
