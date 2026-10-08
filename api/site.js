// Configurações públicas do site (banner da página inicial), editadas no CRM > Configurações
import { sql, ensureSchema, cors, ok, err, fail } from './_lib.js';
import { abrirLink } from './_links.js';
import { pagina, sitemap, robots } from './_seo.js';
import { vcardDoToken } from './_contato.js';
const https = (u) => typeof u === 'string' && /^https:\/\//.test(u);
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return err(res, 405, 'Somente leitura.');
  const pg = (req.query || {}).pg;
  if (pg === 'sitemap' || pg === 'robots') {
    res.setHeader('Content-Type', pg === 'sitemap' ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).send(pg === 'sitemap' ? await sitemap(req) : robots(req));
  }
  if (pg === 'imovel' || pg === 'empreendimento') {
    const html = await pagina(req, pg === 'imovel' ? 'im' : 'em', String(req.query.id || '')).catch((e) => { console.error(e); return null; });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!html) { res.setHeader('Cache-Control', 'no-store'); return res.status(404).send('<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/#portfolio"><title>Imóvel indisponível</title><p>Este imóvel não está mais disponível. <a href="/#portfolio">Ver outros</a></p>'); }
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).send(html);
  }
  if ((req.query || {}).c) { // contato de um toque (link do aviso no WhatsApp)
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
    const v = await vcardDoToken(String(req.query.c)).catch(() => null);
    if (!v) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(404).send('Link de contato inválido ou expirado. Abra o cliente no CRM.'); }
    const arq = String(v.nome || 'lead').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40) || 'lead';
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="' + arq + '.vcf"');
    return res.status(200).send(v.vcf);
  }
  if ((req.query || {}).l) {
    const destino = await abrirLink(String(req.query.l), req).catch(() => null);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 302; res.setHeader('Location', destino || '/'); return res.end();
  }
  try {
    await ensureSchema();
    const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'site_config'");
    const c = (r[0] && r[0].valor) || {};
    const b = c.banners || {};
    const banners = {};
    for (const k of ['litoral', 'holy', 'venda']) if (https(b[k])) banners[k] = b[k];
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
    const t = c.rastreamento || {};
    const id = (v, re) => (re.test(String(v || '').trim()) ? String(v).trim() : '');
    const rastreamento = { ga4: id(t.ga4, /^G-[A-Z0-9]{4,20}$/), ads: id(t.ads, /^AW-\d{6,15}$/), adsLead: id(t.adsLead, /^[A-Za-z0-9_-]{4,40}$/), adsWhats: id(t.adsWhats, /^[A-Za-z0-9_-]{4,40}$/), pixel: id(t.pixel, /^\d{8,20}$/) };
    return ok(res, { banners, rastreamento });
  } catch (e) { return fail(res, e); }
}
