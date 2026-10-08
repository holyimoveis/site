// SEO do site: páginas próprias por imóvel/empreendimento (o Google lê), sitemap.xml e robots.txt.
// Arquivo com "_" (não conta no limite de funções). Usado por api/site.js.
import { sql, ensureSchema } from './_lib.js';
import { paraSite as imSite } from './imoveis.js';
import { paraSite as emSite } from './empreendimentos.js';

const WA = '5549988454873';
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => (v ? 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '');
export const slug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);

async function doc(chave) {
  await ensureSchema();
  const r = await sql.query('SELECT valor FROM crm_docs WHERE chave = $1', [chave]);
  return Array.isArray(r[0] && r[0].valor) ? r[0].valor : [];
}
export async function imoveisPublicos() { return (await doc('imoveis')).filter((i) => i && i.publicarSite === true && i.status === 'Disponível').map(imSite); }
export async function emprPublicos() { return (await doc('empreendimentos')).filter((e) => e && e.publicarSite !== false).map(emSite); }

const base = (req) => process.env.SITE_URL || 'https://www.holyimoveis.com';
export const urlItem = (b, kind, it) => `${b}/${kind === 'im' ? 'imovel' : 'empreendimento'}/${encodeURIComponent(it.id)}/${slug(it.nome)}`;

export async function sitemap(req) {
  const b = base(req);
  const [ims, ems] = await Promise.all([imoveisPublicos(), emprPublicos()]);
  const hoje = new Date().toISOString().slice(0, 10);
  const urls = [{ loc: b + '/', pr: '1.0' }].concat(ems.map((e) => ({ loc: urlItem(b, 'em', e), pr: '0.9' })), ims.map((i) => ({ loc: urlItem(b, 'im', i), pr: '0.8' })), [{ loc: b + '/privacidade.html', pr: '0.2' }]);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${hoje}</lastmod><priority>${u.pr}</priority></url>`).join('\n')}\n</urlset>\n`;
}
export function robots(req) {
  return `User-agent: *\nAllow: /\nDisallow: /crm\nDisallow: /api/\nDisallow: /l/\n\nSitemap: ${base(req)}/sitemap.xml\n`;
}

const CSS = `*{box-sizing:border-box;margin:0;padding:0}body{font-family:Inter,-apple-system,Segoe UI,sans-serif;color:#1a1c18;background:#f5f3ee;line-height:1.6}
a{color:inherit}header{background:#2d3a1f;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px}header img{height:40px}
header a.cta{background:#b8993a;color:#2d3a1f;padding:9px 16px;border-radius:6px;font-weight:600;font-size:14px;text-decoration:none;white-space:nowrap}
.hero{position:relative;height:min(68vh,560px);background:#2d3a1f center/cover}.hero:after{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(26,28,24,.85),rgba(26,28,24,.05) 60%)}
.ht{position:absolute;left:0;right:0;bottom:0;z-index:1;padding:28px 20px;max-width:1080px;margin:0 auto;color:#fff}.k{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#d4b86a;font-weight:600}
h1{font-family:'Playfair Display',Georgia,serif;font-size:clamp(28px,4.5vw,46px);line-height:1.1;margin:6px 0}.loc{opacity:.85}
main{max-width:1080px;margin:0 auto;padding:24px 20px 60px}.grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:28px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
.specs{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin:0 0 22px}.sp{background:#fff;border:1px solid #e1e5d9;border-radius:10px;padding:12px}.sp b{display:block;font-size:20px}.sp span{font-size:11px;color:#7a7d72;text-transform:uppercase;letter-spacing:.08em}
h2{font-family:'Playfair Display',Georgia,serif;font-size:22px;margin:26px 0 10px}.txt{white-space:pre-line;color:#3d4237}.tags{display:flex;flex-wrap:wrap;gap:6px}.tags span{background:#fff;border:1px solid #d6dfc8;color:#4a5c2f;border-radius:20px;padding:4px 12px;font-size:13px}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}.gal img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;display:block}
aside .box{position:sticky;top:16px;background:#fff;border:1px solid #e1e5d9;border-radius:14px;padding:22px}.pr{font-family:'Playfair Display',Georgia,serif;font-size:30px;color:#2d3a1f;margin-bottom:4px}
.btn{display:block;text-align:center;background:#25D366;color:#fff;text-decoration:none;font-weight:600;padding:14px;border-radius:8px;margin-top:14px}.btn2{display:block;text-align:center;border:1px solid #2d3a1f;color:#2d3a1f;text-decoration:none;font-weight:600;padding:12px;border-radius:8px;margin-top:10px}
footer{background:#1a1c18;color:#cfd3c7;text-align:center;padding:26px 20px;font-size:13px}footer a{color:#d4b86a}.mut{color:#7a7d72;font-size:13px}`;

export async function pagina(req, kind, id) {
  const b = base(req);
  const lista = kind === 'im' ? await imoveisPublicos() : await emprPublicos();
  const it = lista.find((x) => String(x.id) === String(id));
  if (!it) return null;
  const url = urlItem(b, kind, it);
  const foto = (it.fotos || [])[0] || b + '/assets/holy-logo-claro.svg';
  const cidade = it.cidade || 'SC';
  const preco = kind === 'im' ? brl(it.valor) : it.preco;
  const specs = kind === 'im'
    ? [[it.areaPrivativa || it.area, 'm² privativos'], [it.quartos, 'quartos'], [it.suites, 'suítes'], [it.vagas, 'vagas'], [it.banheiros, 'banheiros']].filter((s) => +s[0])
    : (it.destaques || []).slice(0, 5).map((d) => [d.n, d.l]);
  const titulo = kind === 'im'
    ? `${it.tipo}${it.quartos ? ' com ' + it.quartos + ' quartos' : ''}${it.bairro ? ' no ' + it.bairro : ''}, ${cidade} | ${it.nome}`
    : `${it.nome} · ${it.tipoLabel || 'Empreendimento'} em ${cidade}`;
  const resumoInteiro = String(it.descricao || '').replace(/\s+/g, ' ').trim() || `${it.nome} em ${cidade}. ${preco || ''}`;
  const resumo = resumoInteiro.length <= 158 ? resumoInteiro : resumoInteiro.slice(0, 155).replace(/\s+\S*$/, '').replace(/[,;:.!\-–\s]+$/, '') + '…';
  const ref = kind === 'im' ? (it.ref || it.id) : it.nome;
  const waTxt = encodeURIComponent(`Olá! Vi no site o ${kind === 'im' ? 'imóvel' : 'empreendimento'} ${it.nome} (ref. ${ref}) e quero mais informações.`);
  const ld = kind === 'im' ? {
    '@context': 'https://schema.org', '@type': 'RealEstateListing', name: it.nome, description: resumo, url, image: (it.fotos || []).slice(0, 6), datePosted: new Date().toISOString().slice(0, 10),
    offers: it.valor ? { '@type': 'Offer', price: it.valor, priceCurrency: 'BRL', availability: 'https://schema.org/InStock', seller: { '@type': 'RealEstateAgent', name: 'Holy Curadoria Imobiliária' } } : undefined,
    about: { '@type': it.tipo === 'Apartamento' ? 'Apartment' : 'SingleFamilyResidence', numberOfRooms: it.quartos || undefined, floorSize: (it.areaPrivativa || it.area) ? { '@type': 'QuantitativeValue', value: it.areaPrivativa || it.area, unitCode: 'MTK' } : undefined,
      address: { '@type': 'PostalAddress', addressLocality: cidade, addressRegion: 'SC', addressCountry: 'BR', streetAddress: it.bairro || undefined } },
  } : {
    '@context': 'https://schema.org', '@type': 'RealEstateListing', name: it.nome, description: resumo, url, image: (it.fotos || []).slice(0, 6),
    about: { '@type': 'ApartmentComplex', name: it.nome, address: { '@type': 'PostalAddress', addressLocality: cidade, addressRegion: 'SC', addressCountry: 'BR' } },
  };
  const org = { '@context': 'https://schema.org', '@type': 'RealEstateAgent', name: 'Holy Curadoria Imobiliária', url: b + '/', logo: b + '/assets/holy-logo-escuro.svg', telephone: '+55 49 98845-4873', areaServed: ['Chapecó', 'Balneário Camboriú', 'Itapema', 'Porto Belo'].map((c) => ({ '@type': 'City', name: c + ', SC' })) };
  const tags = (it.diferenciais || []).concat(it.lazer || []).slice(0, 24);
  const fotos = (it.fotos || []).concat(it.lazerFotos || []).slice(1, 19);
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} | Holy Curadoria Imobiliária</title><meta name="description" content="${esc(resumo)}"><link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(resumo)}"><meta property="og:image" content="${esc(foto)}"><meta property="og:url" content="${esc(url)}"><meta property="og:locale" content="pt_BR"><meta property="og:site_name" content="Holy Curadoria Imobiliária">
<meta name="twitter:card" content="summary_large_image"><link rel="icon" href="/assets/holy-coroa.svg">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script><script type="application/ld+json">${JSON.stringify(org).replace(/</g, '\\u003c')}</script>
<style>${CSS}</style><script src="/assets/holy-track.js" defer></script></head><body>
<header><a href="/"><img src="/assets/holy-logo-claro.svg" alt="Holy Curadoria Imobiliária"></a><a class="cta" href="https://wa.me/${WA}?text=${waTxt}" data-holy-conv="whatsapp">Falar no WhatsApp</a></header>
<section class="hero" style="background-image:url('${esc(foto)}')"><div class="ht"><div class="k">${esc(kind === 'im' ? (it.tipo + ' · ' + (it.finalidade || 'Venda')) : (it.status || 'Lançamento'))}</div><h1>${esc(it.nome)}</h1><div class="loc">${esc([it.bairro, cidade + ' - SC'].filter(Boolean).join(', '))}</div></div></section>
<main><div class="grid"><div>
${specs.length ? `<div class="specs">${specs.map((s) => `<div class="sp"><b>${esc(s[0])}</b><span>${esc(s[1])}</span></div>`).join('')}</div>` : ''}
${it.descricao ? `<h2>Sobre ${kind === 'im' ? 'o imóvel' : 'o empreendimento'}</h2><div class="txt">${esc(it.descricao)}</div>` : ''}
${tags.length ? `<h2>Diferenciais e lazer</h2><div class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
${fotos.length ? `<h2>Fotos</h2><div class="gal">${fotos.map((f, i) => `<img src="${esc(f)}" alt="${esc(it.nome)} – foto ${i + 2}" loading="lazy">`).join('')}</div>` : ''}
${kind === 'em' && (it.ficha || []).length ? `<h2>Ficha técnica</h2><div class="txt">${it.ficha.map((f) => esc(f[0] + ': ' + f[1])).join('\n')}</div>` : ''}
</div><aside><div class="box"><div class="mut">${kind === 'im' ? (it.finalidade === 'Locação' ? 'Aluguel' : 'Valor') : 'Valores'}</div><div class="pr">${esc(preco || 'Sob consulta')}</div>
${kind === 'im' && (it.condominio || it.iptu) ? `<div class="mut">${it.condominio ? 'Condomínio ' + brl(it.condominio) : ''}${it.condominio && it.iptu ? ' · ' : ''}${it.iptu ? 'IPTU ' + brl(it.iptu) : ''}</div>` : ''}
<a class="btn" href="https://wa.me/${WA}?text=${waTxt}" data-holy-conv="whatsapp">Quero mais informações</a>
<a class="btn2" href="/#${kind === 'im' ? 'imovel' : 'empreendimento'}-${encodeURIComponent(it.id)}">Ver no site com mapa e comparador</a>
<p class="mut" style="margin-top:14px">Ref. ${esc(ref)} · Curadoria Holy: atendimento personalizado em Chapecó, Balneário Camboriú, Itapema e Porto Belo.</p></div></aside></div></main>
<footer>Holy Curadoria Imobiliária · <a href="/">holyimoveis.com</a> · <a href="/privacidade.html">Privacidade</a></footer>
<script>window.HOLY_ITEM=${JSON.stringify({ kind, id: it.id, nome: it.nome }).replace(/</g, '\\u003c')};</script></body></html>`;
}
