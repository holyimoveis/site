// Integração com a Meta: campanhas de anúncios (formulário de lead), leads e publicação no Instagram.
// Imóveis = Categoria Especial de Anúncio "HOUSING" (exigência da Meta): sem idade/gênero/CEP, sem exclusões,
// raio mínimo nas cidades. O "público ideal" é construído dentro dessas regras.
import { sql, ensureSchema, cors, isAdmin, body, ok, err, fail } from './_lib.js';
export const maxDuration = 60;

const V = () => process.env.META_API_VERSION || 'v25.0';
const TOKEN = () => process.env.META_ACCESS_TOKEN || '';
const ACT = () => { const a = String(process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, ''); return a ? 'act_' + a : ''; };
const PAGE = () => process.env.META_PAGE_ID || '';
const configurado = () => !!(TOKEN() && ACT() && PAGE());

async function graph(path, method = 'GET', params = {}, token) {
  const tk = token || TOKEN();
  let url = `https://graph.facebook.com/${V()}/${path.replace(/^\//, '')}`;
  const opt = { method, headers: {} };
  if (method === 'GET') {
    const q = new URLSearchParams({ access_token: tk });
    for (const [k, v] of Object.entries(params)) q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    url += (url.includes('?') ? '&' : '?') + q.toString();
  } else {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify({ ...params, access_token: tk });
  }
  const r = await fetch(url, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error((e.error_user_msg || e.message || ('HTTP ' + r.status)) + (e.error_subcode ? ` (código ${e.code}/${e.error_subcode})` : e.code ? ` (código ${e.code})` : ''));
  }
  return j;
}
let _pageToken = null, _igId = undefined;
async function pageToken() {
  if (_pageToken) return _pageToken;
  const j = await graph(PAGE(), 'GET', { fields: 'access_token,name' });
  _pageToken = j.access_token || TOKEN();
  return _pageToken;
}
async function igUser() {
  if (process.env.META_IG_USER_ID) return process.env.META_IG_USER_ID;
  if (_igId !== undefined) return _igId;
  try { const j = await graph(PAGE(), 'GET', { fields: 'instagram_business_account' }); _igId = j.instagram_business_account ? j.instagram_business_account.id : null; }
  catch (e) { _igId = null; }
  return _igId;
}
const site = (req) => process.env.SITE_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host));

// ── IA: estratégia, público e textos ──────────────────────────────────
const FERRAMENTA = {
  name: 'estrategia',
  description: 'Estratégia de campanha de leads no Meta para um imóvel ou empreendimento.',
  input_schema: {
    type: 'object',
    properties: {
      persona: { type: 'string', description: 'Quem é o comprador provável e por quê (para orientar criativo e praças; NÃO vira segmentação demográfica).' },
      pracas: { type: 'array', items: { type: 'object', properties: { cidade: { type: 'string' }, uf: { type: 'string' }, raio_km: { type: 'number' }, motivo: { type: 'string' } }, required: ['cidade', 'uf', 'raio_km'] }, description: '2 a 6 cidades de origem dos compradores, raio mínimo 25 km.' },
      interesses: { type: 'array', items: { type: 'string' }, description: 'Até 8 sinais de interesse (nomes como aparecem no Meta, ex.: Golfe, Investimento imobiliário, Imóveis de luxo).' },
      orcamento_diario: { type: 'number', description: 'Sugestão em reais por dia.' },
      duracao_dias: { type: 'number' },
      justificativa_orcamento: { type: 'string' },
      textos: { type: 'array', items: { type: 'object', properties: { texto_principal: { type: 'string' }, titulo: { type: 'string' }, descricao: { type: 'string' } }, required: ['texto_principal', 'titulo'] }, description: 'Exatamente 3 variações para teste A/B.' },
      perguntas: { type: 'array', items: { type: 'object', properties: { pergunta: { type: 'string' }, opcoes: { type: 'array', items: { type: 'string' } } }, required: ['pergunta', 'opcoes'] }, description: '2 ou 3 perguntas qualificadoras de múltipla escolha.' },
      agradecimento: { type: 'string', description: 'Texto da tela final do formulário.' },
      dicas: { type: 'array', items: { type: 'string' } },
    },
    required: ['persona', 'pracas', 'interesses', 'orcamento_diario', 'duracao_dias', 'textos', 'perguntas', 'agradecimento'],
  },
};
async function sugerir(item) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY.');
  const sys = `Você é um gestor de tráfego sênior especializado em imóveis de alto padrão no Brasil, trabalhando para a Holy Curadoria Imobiliária (Santa Catarina). Objetivo: o MENOR custo por lead QUALIFICADO (lead quente), não o lead mais barato.

REGRAS OBRIGATÓRIAS DA META (Categoria Especial de Anúncio: Moradia/HOUSING):
- Proibido segmentar por idade, gênero, CEP; não existem exclusões nem públicos semelhantes. Idade fica 18-65+ e todos os gêneros.
- Localização só por cidades com raio de no mínimo 25 km (use 25 a 40 km).
- Interesses funcionam apenas como sinais para o público Advantage+.
- Os textos devem descrever o IMÓVEL e nunca o tipo de comprador (nada de "ideal para casais", "para famílias", "para executivos", idade, religião etc.).

ESTRATÉGIA PARA LEAD QUENTE:
- Praças: onde moram os compradores prováveis (ex.: imóveis no litoral catarinense atraem compradores do Oeste de SC, Serra e capitais do Sul, Curitiba, São Paulo; imóveis em Chapecó atraem a própria região).
- O primeiro texto deve abrir com o valor ("a partir de R$ ...") ou um dado forte, para filtrar curiosos. Use só informações fornecidas; nunca invente preço, prazo ou condição.
- Perguntas do formulário qualificam: objetivo (morar, investir, temporada), prazo de compra e forma de pagamento.
- Orçamento: realista para leads no Brasil, com tempo de aprendizado (mínimo 7 dias).
Responda sempre com a ferramenta "estrategia", em português do Brasil.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 2500, system: sys,
      messages: [{ role: 'user', content: 'Dados do anúncio (JSON):\n' + JSON.stringify(item).slice(0, 12000) }],
      tools: [FERRAMENTA], tool_choice: { type: 'tool', name: 'estrategia' } }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const u = (d.content || []).find((c) => c.type === 'tool_use');
  if (!u) throw new Error('A IA não devolveu a estratégia.');
  const out = u.input;
  out.pracas = (out.pracas || []).map((p) => ({ ...p, raio_km: Math.max(25, Math.min(80, +p.raio_km || 25)) }));
  return out;
}

// ── Criação da campanha ───────────────────────────────────────────────
async function cidadeKey(cidade, uf) {
  const j = await graph('search', 'GET', { type: 'adgeolocation', location_types: ['city'], q: cidade, country_code: 'BR', limit: 10 });
  const lst = j.data || [];
  const alvo = lst.find((x) => uf && String(x.region || '').toLowerCase().includes(ufNome(uf))) || lst[0];
  return alvo ? { key: alvo.key, nome: alvo.name + (alvo.region ? ' - ' + alvo.region : '') } : null;
}
const UFS = { sc: 'santa catarina', rs: 'rio grande do sul', pr: 'paraná', sp: 'são paulo', rj: 'rio de janeiro', mg: 'minas gerais', df: 'distrito federal', go: 'goiás', ms: 'mato grosso do sul', mt: 'mato grosso', ba: 'bahia' };
const ufNome = (uf) => UFS[String(uf || '').toLowerCase()] || String(uf || '').toLowerCase();
async function interesseIds(nomes) {
  const out = [];
  for (const n of (nomes || []).slice(0, 8)) {
    try { const j = await graph('search', 'GET', { type: 'adinterest', q: n, locale: 'pt_BR', limit: 1 }); if (j.data && j.data[0]) out.push({ id: j.data[0].id, name: j.data[0].name }); } catch (e) {}
  }
  return out;
}
async function subirImagem(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('Não consegui baixar a foto do anúncio.');
  const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
  const j = await graph(`${ACT()}/adimages`, 'POST', { bytes: b64 });
  const k = Object.keys(j.images || {})[0];
  if (!k) throw new Error('A Meta não aceitou a imagem.');
  return j.images[k].hash;
}
async function criar(b, req) {
  if (!configurado()) throw new Error('Meta não configurada (faltam META_ACCESS_TOKEN, META_AD_ACCOUNT_ID ou META_PAGE_ID).');
  const nome = String(b.nome || 'Holy').slice(0, 80);
  const textos = (b.textos || []).filter((t) => t && t.texto_principal).slice(0, 3);
  if (!textos.length) throw new Error('Inclua ao menos um texto.');
  if (!b.foto || !/^https:/.test(b.foto)) throw new Error('Escolha uma foto do imóvel (já enviada para a nuvem).');
  const diario = Math.max(20, Math.round(+b.orcamento_diario || 50));
  const dias = Math.max(3, Math.min(90, Math.round(+b.duracao_dias || 14)));
  const passos = [];
  // cidades
  const cidades = [];
  for (const p of (b.pracas || []).slice(0, 10)) {
    const c = await cidadeKey(p.cidade, p.uf);
    if (c) cidades.push({ key: c.key, radius: Math.max(25, Math.min(80, Math.round(+p.raio_km || 25))), distance_unit: 'kilometer', _nome: c.nome });
  }
  if (!cidades.length) throw new Error('Não encontrei as cidades escolhidas no Meta.');
  passos.push('Praças: ' + cidades.map((c) => c._nome + ' (' + c.radius + ' km)').join(', '));
  // formulário de lead (alta intenção)
  const ptk = await pageToken();
  const perguntas = [{ type: 'FULL_NAME' }, { type: 'PHONE' }, { type: 'EMAIL' }];
  (b.perguntas || []).slice(0, 3).forEach((q, i) => {
    const ops = (q.opcoes || []).filter(Boolean).slice(0, 6);
    const chave = String(q.pergunta).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'pergunta';
    if (q.pergunta && ops.length >= 2) perguntas.push({ type: 'CUSTOM', key: chave + '_' + (i + 1), label: String(q.pergunta).slice(0, 80), options: ops.map((o, k) => ({ value: String(o).slice(0, 80), key: chave + '_' + (i + 1) + '_' + k })) });
  });
  const linkPagina = b.link && /^https:/.test(b.link) ? b.link : site(req);
  const form = await graph(`${PAGE()}/leadgen_forms`, 'POST', {
    name: `${nome} | ${new Date().toISOString().slice(0, 10)}`.slice(0, 100), locale: 'pt_BR',
    questions: perguntas, is_optimized_for_quality: true,
    privacy_policy: { url: site(req) + '/privacidade.html', link_text: 'Política de privacidade da Holy' },
    thank_you_page: { title: 'Recebemos seu interesse!', body: String(b.agradecimento || 'Um consultor da Holy vai falar com você pelo WhatsApp em breve.').slice(0, 300), button_type: 'VIEW_WEBSITE', button_text: 'Ver o imóvel', website_url: linkPagina },
  }, ptk);
  passos.push('Formulário de alta intenção criado');
  // campanha
  const camp = await graph(`${ACT()}/campaigns`, 'POST', {
    name: `Holy | ${nome} | Leads`, objective: 'OUTCOME_LEADS', status: 'PAUSED', buying_type: 'AUCTION',
    special_ad_categories: ['HOUSING'], special_ad_category_country: ['BR'], is_adset_budget_sharing_enabled: false,
  });
  passos.push('Campanha criada (pausada)');
  // conjunto de anúncios
  const ints = await interesseIds(b.interesses);
  const alvoBase = { geo_locations: { cities: cidades.map(({ _nome, ...c }) => c) }, age_min: 18, age_max: 65, targeting_automation: { advantage_audience: 1 } };
  const inicio = new Date(Date.now() + 10 * 60000), fim = new Date(inicio.getTime() + dias * 86400000);
  const adsetBase = { name: `${nome} | Público Holy`, campaign_id: camp.id, daily_budget: diario * 100, billing_event: 'IMPRESSIONS', optimization_goal: 'LEAD_GENERATION',
    destination_type: 'ON_AD', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', promoted_object: { page_id: PAGE() }, start_time: inicio.toISOString(), end_time: fim.toISOString(), status: 'PAUSED' };
  let adset;
  try {
    adset = await graph(`${ACT()}/adsets`, 'POST', { ...adsetBase, targeting: ints.length ? { ...alvoBase, flexible_spec: [{ interests: ints }] } : alvoBase });
    passos.push(ints.length ? 'Público: Advantage+ com sinais de interesse (' + ints.map((i) => i.name).join(', ') + ')' : 'Público: Advantage+ aberto');
  } catch (e) {
    adset = await graph(`${ACT()}/adsets`, 'POST', { ...adsetBase, targeting: alvoBase });
    passos.push('Público: Advantage+ aberto (a Meta não aceitou os interesses nesta categoria: ' + e.message.slice(0, 120) + ')');
  }
  // criativos e anúncios (1 por variação de texto)
  const hash = await subirImagem(b.foto);
  const ig = await igUser();
  const ads = [];
  for (let i = 0; i < textos.length; i++) {
    const t = textos[i];
    const story = { page_id: PAGE(), link_data: { image_hash: hash, link: linkPagina, message: String(t.texto_principal).slice(0, 2000), name: String(t.titulo || nome).slice(0, 80), description: String(t.descricao || '').slice(0, 60), call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: form.id } } } };
    if (ig) story.instagram_user_id = ig;
    const cr = await graph(`${ACT()}/adcreatives`, 'POST', { name: `${nome} | Variação ${String.fromCharCode(65 + i)}`, object_story_spec: story });
    const ad = await graph(`${ACT()}/ads`, 'POST', { name: `${nome} | Variação ${String.fromCharCode(65 + i)}`, adset_id: adset.id, creative: { creative_id: cr.id }, status: 'PAUSED' });
    ads.push(ad.id);
  }
  passos.push(ads.length + ' anúncio(s) para teste A/B' + (ig ? ' (Facebook + Instagram)' : ' (Facebook; Instagram não vinculado à Página)'));
  return { campanha: camp.id, conjunto: adset.id, anuncios: ads, formulario: form.id, passos, orcamento_diario: diario, dias,
    link: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${ACT().replace('act_', '')}&selected_campaign_ids=${camp.id}` };
}

// ── Métricas, status e leads ──────────────────────────────────────────
async function metricas(ids) {
  const out = {};
  for (const id of (ids || []).slice(0, 30)) {
    try {
      const [c, ins] = await Promise.all([
        graph(id, 'GET', { fields: 'name,status,effective_status' }),
        graph(`${id}/insights`, 'GET', { fields: 'spend,impressions,reach,clicks,actions', date_preset: 'maximum' }),
      ]);
      const i = (ins.data || [])[0] || {};
      const acts = i.actions || [];
      const leads = acts.filter((a) => ['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped'].includes(a.action_type)).reduce((m, a) => Math.max(m, +a.value || 0), 0);
      const gasto = +i.spend || 0;
      out[id] = { status: c.effective_status || c.status, gasto, impressoes: +i.impressions || 0, alcance: +i.reach || 0, cliques: +i.clicks || 0, leads, cpl: leads ? gasto / leads : null };
    } catch (e) { out[id] = { erro: e.message }; }
  }
  return out;
}
async function mudarStatus(b) {
  const st = b.ativo ? 'ACTIVE' : 'PAUSED';
  for (const id of [...(b.anuncios || []), b.conjunto, b.campanha].filter(Boolean)) await graph(id, 'POST', { status: st });
  return st;
}
async function puxarLeads(forms) {
  await sql.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_id TEXT');
  await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS leads_meta_idx ON leads (meta_id)');
  const ptk = await pageToken();
  let novos = 0;
  for (const f of (forms || []).slice(0, 30)) {
    if (!f || !f.id) continue;
    let j;
    try { j = await graph(`${f.id}/leads`, 'GET', { fields: 'id,created_time,field_data,ad_name', limit: 100 }, ptk); } catch (e) { continue; }
    for (const l of j.data || []) {
      const fd = {}; (l.field_data || []).forEach((x) => { fd[x.name] = (x.values || []).join(', '); });
      const nome = fd.full_name || fd.nome_completo || '', tel = fd.phone_number || fd.telefone || '', email = fd.email || '';
      const extras = Object.entries(fd).filter(([k]) => !['full_name', 'phone_number', 'email', 'nome_completo', 'telefone'].includes(k)).map(([k, v]) => k.replace(/_\d+$/, '').replace(/_/g, ' ') + ': ' + v).join(' | ');
      const r = await sql.query(
        `INSERT INTO leads (tipo, nome, email, telefone, interesse, mensagem, origem, imovel, meta_id, criado_em)
         VALUES ('formulario', $1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (meta_id) DO NOTHING RETURNING id`,
        [nome || null, email || null, tel || null, f.item || null, extras || null, 'Meta Ads' + (l.ad_name ? ': ' + l.ad_name : ''), f.item || null, l.id, l.created_time || new Date().toISOString()]);
      if (r.length) novos++;
    }
  }
  return novos;
}

// ── Instagram ─────────────────────────────────────────────────────────
async function aguardar(id) {
  for (let i = 0; i < 20; i++) {
    const j = await graph(id, 'GET', { fields: 'status_code' });
    if (j.status_code === 'FINISHED' || !j.status_code) return;
    if (j.status_code === 'ERROR') throw new Error('O Instagram recusou a mídia.');
    await new Promise((r) => setTimeout(r, 2000));
  }
}
async function publicarIG(b) {
  const ig = await igUser();
  if (!ig) throw new Error('Nenhuma conta do Instagram profissional vinculada à Página do Facebook.');
  const urls = (b.imagens || []).filter((u) => /^https:/.test(u)).slice(0, 10);
  if (!urls.length) throw new Error('Nenhuma imagem para publicar.');
  const legenda = String(b.legenda || '').slice(0, 2200);
  const publicados = [];
  if (b.tipo === 'story') {
    for (const u of urls) { const c = await graph(`${ig}/media`, 'POST', { image_url: u, media_type: 'STORIES' }); await aguardar(c.id); publicados.push((await graph(`${ig}/media_publish`, 'POST', { creation_id: c.id })).id); }
  } else if (urls.length === 1) {
    const c = await graph(`${ig}/media`, 'POST', { image_url: urls[0], caption: legenda }); await aguardar(c.id);
    publicados.push((await graph(`${ig}/media_publish`, 'POST', { creation_id: c.id })).id);
  } else {
    const filhos = [];
    for (const u of urls) { const c = await graph(`${ig}/media`, 'POST', { image_url: u, is_carousel_item: true }); filhos.push(c.id); }
    for (const f of filhos) await aguardar(f);
    const car = await graph(`${ig}/media`, 'POST', { media_type: 'CAROUSEL', children: filhos.join(','), caption: legenda }); await aguardar(car.id);
    publicados.push((await graph(`${ig}/media_publish`, 'POST', { creation_id: car.id })).id);
  }
  return publicados;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!isAdmin(req)) return err(res, 401, 'Senha do CRM inválida.');
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const b = req.method === 'POST' ? body(req) : (req.query || {});
    const acao = b.acao || (req.query || {}).acao;
    if (acao === 'status') {
      if (!configurado()) return ok(res, { configurado: false, faltando: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'META_PAGE_ID'].filter((k) => !process.env[k]) });
      const out = { configurado: true };
      try { const a = await graph(ACT(), 'GET', { fields: 'name,currency,account_status' }); out.conta = a.name; out.moeda = a.currency; out.contaAtiva = a.account_status === 1; } catch (e) { out.erroConta = e.message; }
      try { const p = await graph(PAGE(), 'GET', { fields: 'name' }); out.pagina = p.name; } catch (e) { out.erroPagina = e.message; }
      try { const ig = await igUser(); if (ig) { const i = await graph(ig, 'GET', { fields: 'username' }); out.instagram = '@' + i.username; } } catch (e) {}
      return ok(res, out);
    }
    if (acao === 'sugerir') return ok(res, { estrategia: await sugerir(b.item || {}) });
    if (acao === 'criar') return ok(res, await criar(b, req));
    if (acao === 'metricas') return ok(res, { metricas: await metricas(b.ids) });
    if (acao === 'statusCampanha') return ok(res, { status: await mudarStatus(b) });
    if (acao === 'puxarLeads') return ok(res, { novos: configurado() ? await puxarLeads(b.forms) : 0 });
    if (acao === 'publicarIG') return ok(res, { publicados: await publicarIG(b) });
    return err(res, 400, 'Ação desconhecida.');
  } catch (e) {
    if (e && e.message === 'DB_NAO_CONFIGURADO') return fail(res, e);
    return err(res, 400, e.message || 'Erro na Meta');
  }
}
