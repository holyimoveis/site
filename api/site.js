// Configurações públicas do site (banner da página inicial), editadas no CRM > Configurações
import { sql, ensureSchema, cors, ok, err, fail } from './_lib.js';
import { abrirLink } from './_links.js';
import { pagina, sitemap, robots } from './_seo.js';
import { vcardDoToken } from './_contato.js';
import { descadastrar } from './_email.js';
import { paginaDossie, eventoDossie } from './_dossie.js';
const https = (u) => typeof u === 'string' && /^https:\/\//.test(u);
export const maxDuration = 60; // dossiê: localização e arredores podem levar alguns segundos
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if ((req.query || {}).sair) { // descadastro dos e-mails automáticos (GET pelo link; POST pelo botão do Gmail)
    const okS = await descadastrar(String(req.query.sair)).catch(() => false);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex');
    if (req.method === 'POST') return res.status(okS ? 200 : 400).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(okS ? 200 : 400).send('<!DOCTYPE html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Holy Imóveis</title><body style="font-family:Arial,sans-serif;background:#f5f3ee;color:#1a1c18;display:flex;min-height:90vh;align-items:center;justify-content:center;text-align:center;padding:20px"><div><h1 style="font-family:Georgia,serif;color:#2d3a1f">' + (okS ? 'Pronto, você não vai mais receber nossos e-mails.' : 'Link inválido ou expirado.') + '</h1><p>' + (okS ? 'Se mudar de ideia ou quiser falar com a gente, é só chamar.' : 'Responda qualquer e-mail nosso pedindo o descadastro que resolvemos na hora.') + '</p><p><a href="/" style="color:#2d3a1f">Voltar ao site</a></p></div></body></html>');
  }
  if ((req.query || {}).d) { // 📘 dossiê exclusivo do cliente (GET abre; POST registra o que ele fez na página)
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (req.method === 'POST') { await eventoDossie(String(req.query.d), req.query || {}, req).catch((e) => console.error('[dossie] evento', e.message)); return res.status(204).end(); }
    const html = await paginaDossie(String(req.query.d), req).catch((e) => { console.error('[dossie]', e); return null; });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!html) return res.status(404).send('<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Holy Imóveis</title><body style="font-family:Arial,sans-serif;background:#f6f3ec;display:flex;min-height:90vh;align-items:center;justify-content:center;text-align:center;padding:20px"><div><h2 style="font-family:Georgia,serif;color:#2d3a1f">Este link não está mais ativo.</h2><p>Fale com a Holy que enviamos o material atualizado.</p><p><a href="https://wa.me/5549988454873" style="color:#2d3a1f">Falar no WhatsApp</a></p></div></body></html>');
    return res.status(200).send(html);
  }
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
