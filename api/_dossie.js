// 📘 Dossiê premium por cliente (/d/CODIGO): página exclusiva do imóvel, personalizada para um cliente,
// com mapa, o que tem por perto, simulação de financiamento e rastreio (abriu, simulou, pediu visita, tempo de leitura).
// Arquivo com "_" (não conta no limite de 12 funções da Vercel). Usado por api/crm.js (criar) e api/site.js (abrir).
import crypto from 'node:crypto';
import { sql, ensureSchema, atualizarDoc } from './_lib.js';
import { paraSite } from './imoveis.js';
import { enviarAviso, avisoConfigurado } from './_avisos.js';

const WA = '5549988454873';
const SITE = () => process.env.SITE_URL || 'https://www.holyimoveis.com';
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => (v ? 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '');
// "R$ 450 mil", "1,2 milhão", "300.000", "30%" (do valor) -> número em reais
function valorTexto(t, total) {
  const s = String(t || '').toLowerCase();
  const m = s.match(/(\d[\d.]*(?:,\d+)?)\s*(%|mil\b|k\b|mi\b|milh)?/);
  if (!m) return 0;
  let n = parseFloat(m[1].replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  if (!isFinite(n)) return 0;
  if (m[2] === '%') return total ? Math.round(total * n / 100) : 0;
  if (m[2] === 'mil' || m[2] === 'k') n *= 1e3; else if (m[2] === 'mi' || m[2] === 'milh') n *= 1e6;
  return Math.round(n);
}
const primeiro = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const ROBO = /whatsapp|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|linkedinbot|discordbot|skypeuripreview|googlebot|bingbot|bot\b|crawler|spider|preview/i;

let pronto = false;
export async function esquemaDossie() {
  if (pronto) return;
  await ensureSchema();
  await sql.query(`CREATE TABLE IF NOT EXISTS dossies (
      code TEXT PRIMARY KEY, cliente_id TEXT, cliente TEXT, item_id TEXT NOT NULL, item_nome TEXT,
      intro TEXT, autor TEXT, perfil JSONB, aberturas INT NOT NULL DEFAULT 0, ultima TIMESTAMPTZ,
      eventos JSONB NOT NULL DEFAULT '{}'::jsonb, criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await sql.query(`CREATE TABLE IF NOT EXISTS geo_cache (chave TEXT PRIMARY KEY, valor JSONB, atualizado TIMESTAMPTZ NOT NULL DEFAULT now())`);
  pronto = true;
}

async function doc(chave) {
  const r = await sql.query('SELECT valor FROM crm_docs WHERE chave = $1', [chave]);
  return Array.isArray(r[0] && r[0].valor) ? r[0].valor : [];
}

// ── Localização e "o que tem por perto" (OpenStreetMap), calculado uma vez e guardado ──
const UA = { 'User-Agent': 'HolyImoveis/1.0 (+https://www.holyimoveis.com)', 'Accept-Language': 'pt-BR' };
function distancia(a, b) {
  const R = 6371000, r = (x) => (x * Math.PI) / 180;
  const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const CATS = [
  ['Supermercado', (t) => t.shop === 'supermarket', 2000],
  ['Escola', (t) => t.amenity === 'school', 2000],
  ['Farmácia', (t) => t.amenity === 'pharmacy', 2000],
  ['Hospital ou clínica', (t) => t.amenity === 'hospital' || t.amenity === 'clinic', 3000],
  ['Parque ou praça', (t) => t.leisure === 'park', 2000],
  ['Academia', (t) => t.leisure === 'fitness_centre', 2000],
  ['Restaurante ou café', (t) => t.amenity === 'restaurant' || t.amenity === 'cafe', 1500],
  ['Banco', (t) => t.amenity === 'bank', 2000],
  ['Praia', (t) => t.natural === 'beach', 4000],
  ['Shopping', (t) => t.shop === 'mall', 4000],
];
async function geocodificar(q) {
  const u = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'br', q });
  const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  const j = await r.json();
  return j && j[0] ? [+j[0].lat, +j[0].lon] : null;
}
let ultimoErroPerto = '';
async function pertos(c) {
  const [la, ln] = c;
  // uma consulta curta por categoria (com limite próprio), para não estourar o tempo do OpenStreetMap em áreas densas
  const A = (r, f, n) => `nwr(around:${r},${la},${ln})${f};out center tags ${n};`;
  const q = '[out:json][timeout:25];' + [
    A(1500, '[shop=supermarket]', 25), A(1500, '[amenity=school]', 25), A(1200, '[amenity=pharmacy]', 25),
    A(3000, '[amenity~"^(hospital|clinic)$"]', 25), A(1500, '[leisure=park]', 25), A(1500, '[leisure=fitness_centre]', 25),
    A(800, '[amenity~"^(restaurant|cafe)$"]', 40), A(1500, '[amenity=bank]', 25), A(3000, '[natural=beach]', 10), A(4000, '[shop=mall]', 10),
  ].join('');
  let els = null; ultimoErroPerto = '';
  for (const url of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter']) {
    try {
      const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, UA), body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(20000) });
      if (!r.ok) { ultimoErroPerto += (ultimoErroPerto ? ' · ' : '') + new URL(url).host + ' respondeu ' + r.status; continue; }
      const j = await r.json().catch(() => null);
      if (!j || !Array.isArray(j.elements)) { ultimoErroPerto += (ultimoErroPerto ? ' · ' : '') + new URL(url).host + ' respondeu algo inválido'; continue; }
      if (j.remark && /error|timed out/i.test(j.remark) && !j.elements.length) { ultimoErroPerto += (ultimoErroPerto ? ' · ' : '') + new URL(url).host + ': ' + String(j.remark).slice(0, 120); continue; }
      els = j.elements; break;
    } catch (e) { ultimoErroPerto += (ultimoErroPerto ? ' · ' : '') + new URL(url).host + ': ' + (e.name === 'TimeoutError' ? 'demorou demais' : e.message); }
  }
  if (!els) console.error('[dossie] arredores falharam:', ultimoErroPerto);
  if (!els) return null; // falhou: não guarda como "nada por perto"

  const out = [];
  for (const [rot, ok] of CATS) {
    let melhor = null;
    for (const e of els) {
      const t = e.tags || {};
      if (!ok(t) || !t.name) continue;
      const p = e.center ? [e.center.lat, e.center.lon] : [e.lat, e.lon];
      if (p[0] == null) continue;
      const d = distancia(c, p);
      if (!melhor || d < melhor.d) melhor = { cat: rot, nome: String(t.name).slice(0, 60), d: Math.round(d), p };
    }
    if (melhor) out.push(melhor);
  }
  return out.sort((a, b) => a.d - b.d);
}
// Coordenadas coladas no cadastro (link do Google Maps ou "-27.10, -52.61"); links curtos (maps.app.goo.gl) são abertos para achar o endereço completo
async function coordsDoLink(t) {
  let s = String(t || '').trim();
  if (!s) return null;
  const ler = (x) => {
    const m = x.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || x.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || x.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i) || x.match(/^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/);
    if (!m) return null;
    const la = +m[1], ln = +m[2];
    return Math.abs(la) <= 90 && Math.abs(ln) <= 180 ? [la, ln] : null;
  };
  let c = ler(s);
  if (!c && /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.|www\.google\.[a-z.]+\/maps)/i.test(s)) {
    for (let i = 0; i < 3 && !c; i++) {
      const r = await fetch(s, { redirect: 'manual', headers: UA, signal: AbortSignal.timeout(6000) }).catch(() => null);
      const loc = r && r.headers.get('location');
      if (!loc) break;
      s = new URL(loc, s).toString(); c = ler(decodeURIComponent(s));
    }
  }
  return c;
}

export async function geoImovel(im) {
  const cidade = String(im.cidade || '').replace(/-SC$/i, '').trim();
  const partes = [[im.rua, im.bairro, cidade], [im.bairro, cidade]].map((p) => p.filter(Boolean).join(', ')).filter((s, i, a) => s && a.indexOf(s) === i);
  const local = [im.bairro, cidade].filter(Boolean).join(', ');
  const mapa = String(im.mapa || '').trim();
  if (!partes.length && !mapa) return null;
  const chave = 'g3:' + (mapa ? 'mapa:' + mapa.slice(0, 300) : partes[0].toLowerCase());
  await esquemaDossie();
  const c = (await sql.query("SELECT valor, atualizado FROM geo_cache WHERE chave = $1 AND atualizado > now() - interval '90 days'", [chave]))[0];
  if (c && c.valor && c.valor.coords) {
    // "nada por perto" de uma tentativa que falhou: tenta de novo depois de 1 hora
    if ((!c.valor.perto || !c.valor.perto.length) && Date.now() - new Date(c.atualizado).getTime() > 600 * 1000) {
      const perto = await pertos(c.valor.coords).catch(() => null);
      const v = Object.assign({}, c.valor, { perto: perto || [], erro: perto ? (perto.length ? '' : 'nenhum lugar com nome encontrado no raio') : ultimoErroPerto });
      await sql.query('UPDATE geo_cache SET valor = $2, atualizado = now() WHERE chave = $1', [chave, JSON.stringify(v)]);
      return v;
    }
    return c.valor;
  }
  let coords = mapa ? await coordsDoLink(mapa).catch(() => null) : null, exato = !!coords;
  for (let i = 0; i < partes.length && !coords; i++) {
    coords = await geocodificar(partes[i] + ', SC, Brasil').catch(() => null);
    exato = !!coords && i === 0 && !!im.rua;
    if (!coords && i < partes.length - 1) await new Promise((r) => setTimeout(r, 1100)); // regra de uso do Nominatim: 1 pedido por segundo
  }
  if (!coords) return null;
  const perto = await pertos(coords).catch(() => null);
  const valor = { coords, exato, local: local || partes[partes.length - 1] || '', perto: perto || [], erro: perto ? (perto.length ? '' : 'nenhum lugar com nome encontrado no raio') : ultimoErroPerto };
  await sql.query('INSERT INTO geo_cache (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado = now()', [chave, JSON.stringify(valor)]);
  return valor;
}

// ── Criar (CRM) ──
export async function criarDossie({ clienteId, imovelId, intro, autor }) {
  await esquemaDossie();
  const im = (await doc('imoveis')).find((x) => x && String(x.id) === String(imovelId));
  if (!im) throw new Error('Imóvel não encontrado.');
  const cli = clienteId ? (await doc('clientes')).find((x) => x && x.id === clienteId) : null;
  const p = (cli && cli.perfilWhatsApp) || {};
  const perfil = { pagamento: p.pagamento || '', entrada: p.entrada || '', financiamento: p.financiamento || '', permuta: p.imovel_permuta || (/permuta/i.test(String(p.pagamento || '')) ? 'sim' : '') };
  const code = crypto.randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10);
  await sql.query('INSERT INTO dossies (code, cliente_id, cliente, item_id, item_nome, intro, autor, perfil) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [code, clienteId || null, String((cli && cli.nome) || '').slice(0, 120), String(im.id), String(im.nome || '').slice(0, 160), String(intro || '').slice(0, 1500), String(autor || '').slice(0, 80), JSON.stringify(perfil)]);
  await geoImovel(im).catch((e) => console.error('[dossie] geo', e.message)); // já deixa o mapa pronto para a 1ª abertura
  return { code, url: SITE() + '/d/' + code };
}
export async function listarDossies(clienteId) {
  await esquemaDossie();
  return sql.query('SELECT code, item_nome, aberturas, ultima, eventos, criado_em FROM dossies WHERE cliente_id = $1 ORDER BY criado_em DESC LIMIT 20', [clienteId]);
}

// ── Rastreio: aberturas e ações dentro do dossiê ──
async function registrar(r, chaveEv, desc, intervaloH, avisar) {
  const ev = r.eventos || {};
  const ant = ev[chaveEv] ? new Date(ev[chaveEv]).getTime() : 0;
  if (Date.now() - ant < intervaloH * 3600 * 1000) return;
  ev[chaveEv] = new Date().toISOString();
  await sql.query('UPDATE dossies SET eventos = $2 WHERE code = $1', [r.code, JSON.stringify(ev)]);
  if (r.cliente_id) {
    const agora = new Date();
    const item = { id: 'int' + Math.random().toString(36).slice(2, 9), tipo: 'Nota interna',
      data: agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }),
      hora: agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }),
      desc, imovelId: r.item_id || '', clienteId: r.cliente_id, cliente: r.cliente || '', autor: 'Sistema' };
    await atualizarDoc('timeline', (t) => [item].concat(Array.isArray(t) ? t : [])).catch(() => null);
  }
  if (avisar && avisoConfigurado()) await enviarAviso(avisar).catch(() => null);
}
export async function eventoDossie(code, q, req) {
  if (!/^[A-Za-z0-9]{6,14}$/.test(code)) return false;
  if (ROBO.test(String(req.headers['user-agent'] || ''))) return false;
  await esquemaDossie();
  const r = (await sql.query('SELECT * FROM dossies WHERE code = $1', [code]))[0];
  if (!r) return false;
  const nome = r.cliente || 'Cliente';
  const ev = String(q.ev || '');
  if (ev === 'sim') {
    const ent = Math.max(0, Math.round(+q.entrada || 0)), anos = Math.max(0, Math.round(+q.anos || 0));
    await registrar(r, 'sim', `🧮 Simulou financiamento no dossiê: entrada ${brl(ent) || 'R$ 0'}, ${anos} anos${q.parcela ? ', 1ª parcela ~' + brl(+q.parcela) : ''}`, 1);
  } else if (ev === 'visita') {
    await registrar(r, 'visita', '📅 Tocou em "Agendar visita" no dossiê', 2, `📅 *${nome}* tocou em *Agendar visita* no dossiê de ${r.item_nome}. Fique de olho no WhatsApp da Holy!`);
  } else if (ev === 'duvida') {
    await registrar(r, 'duvida', '💬 Tocou em "Tirar uma dúvida" no dossiê', 2);
  } else if (ev === 'tempo') {
    const s = Math.round(+q.s || 0);
    if (s >= 30) await registrar(r, 'tempo', `⏱ Leu o dossiê por ${s >= 120 ? Math.round(s / 60) + ' min' : s + ' s'}`, 0.5);
  } else return false;
  return true;
}

// ── Página ──
export async function paginaDossie(code, req) {
  if (!/^[A-Za-z0-9]{6,14}$/.test(code)) return null;
  await esquemaDossie();
  const r = (await sql.query('SELECT * FROM dossies WHERE code = $1', [code]))[0];
  if (!r) return null;
  const bruto = (await doc('imoveis')).find((x) => x && String(x.id) === String(r.item_id));
  const nome1 = primeiro(r.cliente);
  if (!bruto || bruto.status === 'Vendido') {
    return pagina(`<div class="fim"><img src="/assets/holy-logo-escuro.svg" alt="Holy"><h1>${nome1 ? esc(nome1) + ', este' : 'Este'} imóvel não está mais disponível</h1><p>Mas a curadoria continua: me chame que eu separo opções parecidas para você.</p><a class="cta" href="https://wa.me/${WA}?text=${encodeURIComponent('Olá! ' + (nome1 ? 'Aqui é ' + nome1 + '. ' : '') + 'O dossiê de ' + (r.item_nome || 'um imóvel') + ' não está mais disponível. Pode me mandar opções parecidas?')}">Falar no WhatsApp</a></div>`, 'Holy Curadoria Imobiliária', '');
  }
  // abertura (robôs que geram a prévia do link não contam)
  if (!ROBO.test(String(req.headers['user-agent'] || '')) && !(req.query || {}).previa) { // ?previa=1: o corretor conferindo pelo CRM não conta
    const n = (r.aberturas || 0) + 1;
    await sql.query('UPDATE dossies SET aberturas = aberturas + 1, ultima = now() WHERE code = $1', [code]);
    await registrar(r, 'abriu', `📘 Abriu o dossiê de ${r.item_nome}` + (n > 1 ? ` (${n}ª vez)` : ''), 6,
      `📘 *${r.cliente || 'Um cliente'}* abriu agora o dossiê de *${r.item_nome}*` + (n > 1 ? ` (${n}ª vez)` : '') + '. Bom momento para chamar!').catch((e) => console.error('[dossie] abertura', e.message));
  }
  const it = paraSite(bruto);
  const geo = await geoImovel(bruto).catch(() => null);
  const pf = r.perfil || {};
  const autor = String(r.autor || 'Édipo Junior').split(/\s+/).slice(0, 2).join(' ');
  const fotos = (it.fotos || []).slice(0, 24);
  const capa = fotos[0] || '';
  const priv = it.areaPrivativa; // só a área privativa (a área total não aparece como se fosse do apartamento)
  const m2 = it.valor && priv ? Math.round(it.valor / priv) : 0;
  const local = [it.bairro, it.cidade].filter(Boolean).join(', ');
  const specs = [[priv, 'm² privativos'], [it.quartos, it.quartos == 1 ? 'quarto' : 'quartos'], [it.suites, it.suites == 1 ? 'suíte' : 'suítes'], [it.vagas, it.vagas == 1 ? 'vaga' : 'vagas'], [it.banheiros, 'banheiros']].filter((s) => +s[0]);
  const tags = (it.diferenciais || []).concat(it.lazer || []).slice(0, 30);
  const avista = /vista/i.test(pf.pagamento || '') && !/financ/i.test(pf.pagamento || '');
  const txtVisita = `Olá ${primeiro(autor)}! ${nome1 ? 'Aqui é ' + nome1 + '. ' : ''}Vi o dossiê de ${it.nome} e gostaria de agendar uma visita.`;
  const txtDuvida = `Olá ${primeiro(autor)}! ${nome1 ? 'Aqui é ' + nome1 + '. ' : ''}Vi o dossiê de ${it.nome} e tenho uma dúvida:`;
  const intro = String(r.intro || '').trim() || `${nome1 ? nome1 + ', ' : ''}separei este material sobre o ${it.nome} para você ver com calma: fotos, localização, o que tem por perto e uma simulação de pagamento. Qualquer dúvida, é só me chamar.`;
  const perto = (geo && geo.perto) || [];
  const dist = (d) => (d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1).replace('.', ',') + ' km');
  const modo = (d) => (d <= 1500 ? Math.max(1, Math.round(d / 80)) + ' min a pé' : Math.max(2, Math.round(d / 450)) + ' min de carro');
  const dados = { code, valor: it.valor || 0, entrada: valorTexto(pf.entrada, it.valor), coords: geo && geo.coords && geo.coords.map((v) => Math.round(v * 1000) / 1000) /* ~100 m de margem: o endereço exato não vai para o cliente */, perto: perto.map((p) => ({ n: p.nome, c: p.cat, p: p.p })), exato: !!(geo && geo.exato) };

  const corpo = `
<header class="top"><img src="/assets/holy-logo-claro.svg" alt="Holy Curadoria Imobiliária"><span>Dossiê exclusivo${nome1 ? ' · ' + esc(nome1) : ''}</span></header>
<section class="hero" style="${capa ? `background-image:url('${esc(capa)}')` : ''}">
  <div class="hero-in">
    <div class="selo" title="Selecionado pela curadoria Holy">${SELO}</div>
    ${nome1 ? `<div class="para">Preparado para ${esc(r.cliente)}</div>` : ''}
    <h1>${esc(it.nome)}</h1>
    <div class="loc">${esc(local)}${it.valor ? ' · <b>' + esc(brl(it.valor)) + '</b>' : ''}</div>
  </div>
</section>
<main>
<section class="carta rev">
  <p class="txt">${esc(intro).replace(/\n+/g, '</p><p class="txt">')}</p>
  <div class="ass"><b>${esc(autor)}</b><span>Holy Curadoria Imobiliária</span></div>
</section>
${specs.length ? `<section class="nums rev">${specs.map((s) => `<div><b>${esc(s[0])}</b><span>${esc(s[1])}</span></div>`).join('')}${m2 ? `<div><b>${esc(brl(m2))}</b><span>por m²</span></div>` : ''}</section>` : ''}
${fotos.length > 1 ? `<section class="sec rev"><h2>Fotos</h2><div class="gal">${fotos.map((f, i) => `<button onclick="lb(${i})" aria-label="Ampliar foto ${i + 1}"><img src="${esc(f)}" alt="${esc(it.nome)} – foto ${i + 1}" loading="${i < 3 ? 'eager' : 'lazy'}"></button>`).join('')}</div></section>` : ''}
${it.descricao ? `<section class="sec rev"><h2>Sobre o imóvel</h2><div class="desc">${esc(it.descricao).replace(/\n{2,}/g, '</p><p>').replace(/^/, '<p>').replace(/$/, '</p>').replace(/\n/g, '<br>')}</div></section>` : ''}
${tags.length ? `<section class="sec rev"><h2>Diferenciais</h2><div class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div></section>` : ''}
${(it.condominio || it.iptu) ? `<section class="sec rev custos">${it.condominio ? `<div><span>Condomínio</span><b>${esc(brl(it.condominio))}/mês</b></div>` : ''}${it.iptu ? `<div><span>IPTU</span><b>${esc(brl(it.iptu))}</b></div>` : ''}</section>` : ''}
<section class="sec rev" id="local"><h2>Localização</h2>
  ${geo && geo.coords ? `<div id="mapa" class="mapa"></div>` : `<iframe class="mapa" loading="lazy" src="https://www.google.com/maps?q=${encodeURIComponent(local + ', SC')}&output=embed" title="Mapa"></iframe>`}
  <div class="nota">📍 ${esc(local)} · localização aproximada. O endereço exato é passado no agendamento da visita.</div>
  ${perto.length ? `<h3>O que tem por perto</h3><ul class="perto">${perto.map((p) => `<li><div><b>${esc(p.cat)}</b><span>${esc(p.nome)}</span></div><div class="d"><b>${dist(p.d)}</b><span>${modo(p.d)}</span></div></li>`).join('')}</ul><div class="nota">Distâncias em linha reta, aproximadas. Fonte: OpenStreetMap.</div>` : ''}
  ${!perto.length && (req.query || {}).previa ? `<div class="nota" style="color:#a3402e;margin-top:14px">Nota só para você (prévia): o "o que tem por perto" ainda não carregou${geo && geo.erro ? ' — motivo: ' + esc(geo.erro) : geo ? '' : ' — a localização do imóvel não foi encontrada; cole as coordenadas no campo Localização no mapa'}. O sistema tenta de novo a cada 10 minutos; abra esta página de novo mais tarde.</div>` : ''}
</section>
${it.valor && it.finalidade !== 'Locação' ? `<section class="sec rev" id="sim">
  ${avista ? `<details><summary><h2>Simulação de financiamento</h2><span>Se quiser financiar uma parte</span></summary>` : '<h2>Simulação de financiamento</h2>'}
  <div class="sim">
    <div class="ctl">
      <label>Entrada <output id="o-ent"></output><input id="s-ent" type="range" min="20" max="90" step="5"></label>
      <label>Prazo <output id="o-anos"></output><input id="s-anos" type="range" min="5" max="35" step="1" value="30"></label>
      <label>Juros ao ano (%)<input id="s-taxa" type="number" min="5" max="20" step="0.1" value="11.5" inputmode="decimal"></label>
    </div>
    <div class="res">
      <div class="r1"><span>Valor financiado</span><b id="r-fin"></b></div>
      <div class="r2"><div><span>Tabela SAC · 1ª parcela</span><b id="r-sac1"></b><small id="r-sacn"></small></div><div><span>Tabela Price · parcela fixa</span><b id="r-price"></b><small>do início ao fim</small></div></div>
      <div class="r1"><span>Renda familiar sugerida (SAC)</span><b id="r-renda"></b></div>
    </div>
  </div>
  <div class="nota">Simulação ilustrativa: não inclui seguros obrigatórios, taxas do banco, correção (TR) nem os custos de ITBI e registro. As condições reais dependem do banco e da análise de crédito. Eu faço a simulação oficial com os bancos parceiros para você.</div>
  ${avista ? '</details>' : ''}
</section>` : ''}
${pf.permuta ? `<section class="sec rev perm"><h2>Seu imóvel na negociação</h2><p>Você comentou que pensa em usar um imóvel na compra. Me mande fotos, endereço e metragem dele que eu já levo a avaliação para a conversa com o proprietário.</p></section>` : ''}
<section class="final rev">
  <h2>${nome1 ? esc(nome1) + ', quer' : 'Quer'} conhecer pessoalmente?</h2>
  <p>A visita é o momento de sentir o imóvel: luz, silêncio, vizinhança. Eu acompanho você e respondo tudo na hora.</p>
  <a class="cta" data-ev="visita" href="https://wa.me/${WA}?text=${encodeURIComponent(txtVisita)}" target="_blank" rel="noopener">Agendar visita</a>
  <a class="cta2" data-ev="duvida" href="https://wa.me/${WA}?text=${encodeURIComponent(txtDuvida)}" target="_blank" rel="noopener">Tirar uma dúvida</a>
</section>
</main>
<footer><img src="/assets/holy-coroa.svg" alt="" width="22" height="22"><div>Holy Curadoria Imobiliária · Chapecó · Balneário Camboriú · Itapema · Porto Belo<br><a href="/">holyimoveis.com</a> · Material exclusivo e pessoal${it.ref ? ' · Ref. ' + esc(it.ref) : ''}</div></footer>
<div id="lb" class="lb" onclick="if(event.target===this)lbx()"><button class="lbx" onclick="lbx()" aria-label="Fechar">×</button><button class="lbp" onclick="lbn(-1)" aria-label="Anterior">‹</button><img id="lbi" alt=""><button class="lbn" onclick="lbn(1)" aria-label="Próxima">›</button><div id="lbc" class="lbc"></div></div>
<script>window.D=${JSON.stringify(dados).replace(/</g, '\\u003c')};window.F=${JSON.stringify(fotos).replace(/</g, '\\u003c')};</script>
<script>${JS}</script>`;
  return pagina(corpo, nome1 ? `${nome1}, seu dossiê exclusivo · ${it.nome}` : `Dossiê exclusivo · ${it.nome}`, capa, geo && geo.coords,
    r.cliente ? `Material exclusivo preparado para ${r.cliente} pela Holy Curadoria Imobiliária.` : '');
}

function pagina(corpo, titulo, img, mapa, descricao) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)} | Holy</title><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#1f2a15">
<meta property="og:title" content="${esc(titulo)}"><meta property="og:description" content="${esc(descricao || 'Material exclusivo preparado pela Holy Curadoria Imobiliária.')}"><meta name="description" content="${esc(descricao || 'Material exclusivo preparado pela Holy Curadoria Imobiliária.')}">${img ? `<meta property="og:image" content="${esc(img)}">` : ''}
<link rel="icon" href="/assets/holy-coroa.svg"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;1,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
${mapa ? '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"><script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" defer></script>' : ''}
<style>${CSS}</style></head><body>${corpo}</body></html>`;
}

const SELO = `<svg viewBox="0 0 120 120" width="96" height="96" aria-label="Imóvel curado Holy"><defs><path id="sc" d="M60,60 m-44,0 a44,44 0 1,1 88,0 a44,44 0 1,1 -88,0"/></defs>
<circle cx="60" cy="60" r="57" fill="rgba(20,26,14,.55)" stroke="#c9a85a" stroke-width="1.5"/><circle cx="60" cy="60" r="34" fill="none" stroke="#c9a85a" stroke-width=".8" opacity=".7"/>
<text font-family="Inter,Arial" font-size="8.6" fill="#e8d7a8" font-weight="600"><textPath href="#sc" textLength="272" lengthAdjust="spacing">IMÓVEL CURADO · HOLY · IMÓVEL CURADO · HOLY · </textPath></text>
<path d="M44 70 L47 52 L54 60 L60 47 L66 60 L73 52 L76 70 Z" fill="none" stroke="#e8d7a8" stroke-width="2" stroke-linejoin="round"/><line x1="44" y1="74" x2="76" y2="74" stroke="#e8d7a8" stroke-width="2"/></svg>`;

const CSS = `:root{--ol:#1f2a15;--ol2:#2d3a1f;--gd:#b8993a;--gd2:#e8d7a8;--cr:#f6f3ec;--cr2:#ebe5d8;--ink:#1b1d17;--mut:#6f7266}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}body{font-family:Inter,system-ui,sans-serif;background:var(--cr);color:var(--ink);-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}a{color:inherit}
.top{position:fixed;top:0;left:0;right:0;z-index:20;display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:linear-gradient(rgba(15,20,10,.55),rgba(15,20,10,0));color:#fff;font-size:11px;letter-spacing:.14em;text-transform:uppercase}
.top img{height:30px;width:auto}
.hero{min-height:88vh;min-height:88svh;background:var(--ol) center/cover no-repeat;position:relative;display:flex;align-items:flex-end}
.hero:before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,20,10,.15) 30%,rgba(15,20,10,.85))}
.hero-in{position:relative;max-width:1080px;margin:0 auto;width:100%;padding:0 22px 56px;color:#fff}
.selo{margin-bottom:22px;filter:drop-shadow(0 4px 14px rgba(0,0,0,.35))}
.para{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--gd2);margin-bottom:12px}
.hero h1{font-family:'Playfair Display',Georgia,serif;font-weight:500;font-size:clamp(34px,6vw,64px);line-height:1.05;max-width:820px}
.loc{margin-top:14px;font-size:16px;opacity:.92}.loc b{color:var(--gd2);font-weight:600}
main{max-width:1080px;margin:0 auto;padding:0 22px}
.carta{max-width:720px;margin:-36px auto 0;background:#fff;border-radius:4px;padding:40px 44px;position:relative;box-shadow:0 20px 50px -25px rgba(31,42,21,.35);border-top:3px solid var(--gd)}
.carta .txt{font-family:'Playfair Display',Georgia,serif;font-style:italic;font-size:21px;line-height:1.6;color:var(--ol2)}.carta .txt+.txt{margin-top:14px}
.ass{margin-top:24px;display:flex;flex-direction:column;font-size:13px}.ass b{font-size:15px}.ass span{color:var(--mut);margin-top:2px}
.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:1px;background:var(--cr2);border:1px solid var(--cr2);margin:56px 0 0;border-radius:4px;overflow:hidden}
.nums div{background:var(--cr);padding:22px 16px;text-align:center}.nums b{display:block;font-family:'Playfair Display',Georgia,serif;font-size:28px;font-weight:500;color:var(--ol2)}.nums span{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}
.sec{margin-top:72px}.sec h2,.final h2,summary h2{font-family:'Playfair Display',Georgia,serif;font-weight:500;font-size:30px;color:var(--ol2);margin-bottom:22px}
.sec h3{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--gd);margin:28px 0 10px}
.gal{display:grid;grid-template-columns:repeat(6,1fr);grid-auto-rows:120px;gap:8px}
.gal button{border:0;padding:0;cursor:zoom-in;overflow:hidden;border-radius:3px;background:var(--cr2);grid-column:span 2}
.gal button:nth-child(1){grid-column:span 4;grid-row:span 3}.gal button:nth-child(2),.gal button:nth-child(3){grid-row:span 1;grid-column:span 2}
.gal button:nth-child(n+4){grid-row:span 2}
.gal img{width:100%;height:100%;object-fit:cover;transition:transform .6s}.gal button:hover img{transform:scale(1.04)}
.desc{font-size:16px;line-height:1.85;color:#3b3f34;max-width:760px}.desc p+p{margin-top:14px}
.tags{display:flex;flex-wrap:wrap;gap:8px}.tags span{font-size:13px;padding:8px 14px;border:1px solid var(--cr2);background:#fff;border-radius:30px;color:var(--ol2)}
.custos{display:flex;gap:28px;flex-wrap:wrap;font-size:14px;color:var(--mut)}.custos b{color:var(--ink);margin-left:8px}
.mapa{width:100%;height:380px;border:0;border-radius:4px;background:var(--cr2)}
.leaflet-tile-pane{filter:grayscale(.75) sepia(.12)}
.nota{font-size:12px;color:var(--mut);line-height:1.6;margin-top:10px}
.perto{list-style:none;display:grid;grid-template-columns:1fr 1fr;gap:0 36px}
.perto li{display:flex;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid var(--cr2)}
.perto li div{display:flex;flex-direction:column}.perto li span{font-size:13px;color:var(--mut);margin-top:2px}.perto .d{text-align:right;white-space:nowrap}
.sim{display:grid;grid-template-columns:1fr 1.15fr;gap:28px;background:#fff;border-radius:4px;padding:28px;border:1px solid var(--cr2)}
.ctl{display:flex;flex-direction:column;gap:22px}.ctl label{font-size:13px;color:var(--mut);display:flex;flex-direction:column;gap:8px}
.ctl output{color:var(--ink);font-weight:600;font-size:15px}
input[type=range]{accent-color:var(--ol2);width:100%}input[type=number]{font:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--cr2);border-radius:4px;width:120px}
.res{display:flex;flex-direction:column;gap:14px}.r1{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid var(--cr2);padding-bottom:12px;font-size:14px;color:var(--mut)}
.r1 b{font-size:18px;color:var(--ink)}.r2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.r2 div{background:var(--cr);border-radius:4px;padding:16px;display:flex;flex-direction:column;gap:4px}.r2 span{font-size:12px;color:var(--mut)}.r2 b{font-family:'Playfair Display',Georgia,serif;font-size:26px;font-weight:500;color:var(--ol2)}.r2 small{font-size:12px;color:var(--mut)}
details summary{list-style:none;cursor:pointer}details summary::-webkit-details-marker{display:none}details summary h2{display:inline;margin:0}details summary span{display:block;font-size:13px;color:var(--gd);margin:6px 0 20px}
.perm{background:#fff;border-left:3px solid var(--gd);padding:28px 32px;border-radius:4px}.perm h2{font-size:24px;margin-bottom:10px}.perm p{line-height:1.7;color:#3b3f34}
.final{margin:88px -22px 0;padding:72px 22px;text-align:center;background:var(--ol);color:#fff}
.final h2{color:#fff;font-size:clamp(28px,4vw,40px)}.final p{max-width:520px;margin:0 auto 30px;line-height:1.7;opacity:.85}
.cta,.cta2{display:inline-block;text-decoration:none;font-weight:600;font-size:15px;padding:16px 34px;border-radius:40px;margin:6px}
.cta{background:var(--gd);color:#1b1d17}.cta2{border:1px solid rgba(255,255,255,.4);color:#fff}
footer{display:flex;gap:14px;align-items:center;justify-content:center;padding:30px 22px 40px;font-size:12px;color:var(--mut);line-height:1.7;text-align:left;background:var(--cr)}
.lb{position:fixed;inset:0;background:rgba(10,12,8,.95);z-index:50;display:none;align-items:center;justify-content:center}.lb.on{display:flex}
.lb img{max-width:92vw;max-height:84vh;object-fit:contain}.lb button{position:absolute;background:none;border:0;color:#fff;font-size:44px;cursor:pointer;padding:10px 18px}
.lbx{top:8px;right:8px}.lbp{left:4px}.lbn{right:4px}.lbc{position:absolute;bottom:16px;color:#ccc;font-size:13px}
.fim{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;gap:16px}.fim img{width:120px}.fim h1{font-family:'Playfair Display',serif;font-weight:500;color:var(--ol2)}.fim .cta{color:#1b1d17}
.rev{opacity:0;transform:translateY(18px);transition:opacity .8s,transform .8s}.rev.in{opacity:1;transform:none}
@media(max-width:760px){.carta{padding:30px 24px;margin-top:-28px}.carta .txt{font-size:18px}.sim{grid-template-columns:1fr;padding:20px}.perto{grid-template-columns:1fr}
.gal{grid-template-columns:repeat(2,1fr);grid-auto-rows:150px}.gal button,.gal button:nth-child(n){grid-column:span 1;grid-row:span 1}.gal button:nth-child(1){grid-column:span 2;grid-row:span 2}
.gal button:last-child:nth-child(even){grid-column:span 2}.mapa{height:300px}.sec{margin-top:56px}.top span{display:none}}
@media(prefers-reduced-motion:reduce){.rev{opacity:1;transform:none;transition:none}}`;

const JS = `(function(){
var D=window.D,F=window.F||[],i0=0;
function bc(ev,q){try{var u='/api/site?d='+D.code+'&ev='+ev+(q?'&'+q:'');if(navigator.sendBeacon)navigator.sendBeacon(u,'');else fetch(u,{method:'POST',keepalive:true});}catch(e){}}
window.lb=function(i){i0=i;var b=document.getElementById('lb');b.classList.add('on');sh();};
window.lbx=function(){document.getElementById('lb').classList.remove('on');};
window.lbn=function(d){i0=(i0+d+F.length)%F.length;sh();};
function sh(){document.getElementById('lbi').src=F[i0];document.getElementById('lbc').textContent=(i0+1)+' / '+F.length;}
document.addEventListener('keydown',function(e){if(!document.getElementById('lb').classList.contains('on'))return;if(e.key==='Escape')lbx();if(e.key==='ArrowRight')lbn(1);if(e.key==='ArrowLeft')lbn(-1);});
var io='IntersectionObserver' in window?new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.08}):null;
document.querySelectorAll('.rev').forEach(function(el){io?io.observe(el):el.classList.add('in');});
document.querySelectorAll('[data-ev]').forEach(function(a){a.addEventListener('click',function(){bc(a.getAttribute('data-ev'));});});
var t0=Date.now(),vis=0,enviado=0;function tempo(){var s=Math.round((Date.now()-t0)/1000)+vis;if(s>=30&&!enviado){enviado=1;bc('tempo','s='+s);}}
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')tempo();});window.addEventListener('pagehide',tempo);
var V=D.valor,se=document.getElementById('s-ent');
if(se&&V){
  var brl=function(v){return 'R$ '+Math.round(v).toLocaleString('pt-BR');};
  var p0=D.entrada&&D.entrada<V?Math.min(90,Math.max(20,Math.round(D.entrada/V*20)*5)):30;se.value=p0;
  var sa=document.getElementById('s-anos'),st=document.getElementById('s-taxa'),tm=null;
  function calc(user){
    var pe=+se.value,an=+sa.value,ta=Math.max(0,+String(st.value).replace(',','.'))/100;
    var ent=V*pe/100,P=V-ent,n=an*12,i=Math.pow(1+ta,1/12)-1;
    var price=i?P*i/(1-Math.pow(1+i,-n)):P/n,a=P/n,s1=a+P*i,sn=a+a*i;
    document.getElementById('o-ent').textContent=pe+'% · '+brl(ent);
    document.getElementById('o-anos').textContent=an+' anos';
    document.getElementById('r-fin').textContent=brl(P);
    document.getElementById('r-sac1').textContent=brl(s1);
    document.getElementById('r-sacn').textContent='caindo até '+brl(sn)+' na última';
    document.getElementById('r-price').textContent=brl(price);
    document.getElementById('r-renda').textContent=brl(s1/0.3);
    if(user){clearTimeout(tm);tm=setTimeout(function(){bc('sim','entrada='+Math.round(ent)+'&anos='+an+'&parcela='+Math.round(s1));},2500);}
  }
  [se,sa,st].forEach(function(el){el.addEventListener('input',function(){calc(1);});});calc(0);
}
function mapa(){
  if(!D.coords||typeof L==='undefined'||!document.getElementById('mapa'))return;
  var m=L.map('mapa',{center:D.coords,zoom:15,scrollWheelZoom:false});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',maxZoom:19}).addTo(m);
  L.circle(D.coords,{radius:D.exato?220:450,color:'#b8993a',weight:1.5,fillColor:'#b8993a',fillOpacity:.14}).addTo(m);
  var pts=[D.coords];(D.perto||[]).forEach(function(p){pts.push(p.p);L.circleMarker(p.p,{radius:5,color:'#2d3a1f',weight:2,fillColor:'#fff',fillOpacity:1}).bindTooltip(p.c+': '+p.n).addTo(m);});
  if(pts.length>1)m.fitBounds(pts,{padding:[30,30],maxZoom:16});
}
if(document.readyState==='complete')mapa();else window.addEventListener('load',mapa);
})();`;
