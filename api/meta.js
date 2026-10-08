// Integração com a Meta: campanhas de anúncios (formulário de lead), leads e publicação no Instagram.
// Imóveis = Categoria Especial de Anúncio "HOUSING" (exigência da Meta): sem idade/gênero/CEP, sem exclusões,
// raio mínimo nas cidades. O "público ideal" é construído dentro dessas regras.
import { sql, ensureSchema, cors, body, ok, err, fail } from './_lib.js';
import { sessao, pode } from './_auth.js';
import { tokenPaginaSalvo, infoTokenPagina, salvarTokenPagina, apagarTokenPagina } from './_metatoken.js';
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
  if (method === 'GET' || method === 'DELETE') {
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
// Token da Página: primeiro o do usuário do sistema (tem pages_manage_ads e leads_retrieval, usados em
// formulários, anúncios e leads); se ele estiver bloqueado, usa o token salvo pelo login do Édipo (Plano B).
async function pageToken() {
  if (_pageToken) return _pageToken;
  try {
    const j = await graph(PAGE(), 'GET', { fields: 'access_token,name' });
    if (j.access_token) { _pageToken = j.access_token; return _pageToken; }
  } catch (e) {
    const salvo = await tokenPaginaSalvo();
    if (salvo) return salvo;
    throw e;
  }
  return (await tokenPaginaSalvo()) || TOKEN();
}
async function igUser() {
  if (process.env.META_IG_USER_ID) return process.env.META_IG_USER_ID;
  if (_igId !== undefined) return _igId;
  try { const j = await graph(PAGE(), 'GET', { fields: 'instagram_business_account' }, (await tokenPaginaSalvo()) || undefined); _igId = j.instagram_business_account ? j.instagram_business_account.id : null; }
  catch (e) { _igId = null; }
  return _igId;
}
const site = (req) => process.env.SITE_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host));

// ── IA: estratégia, público e textos ──────────────────────────────────
const FERRAMENTA = {
  name: 'estrategia',
  description: 'Plano de campanha de leads no Meta para um imóvel ou empreendimento, com objetivo, orçamento por padrão do imóvel e anúncios.',
  input_schema: {
    type: 'object',
    properties: {
      objetivo: { type: 'string', description: 'Objetivo da campanha em UMA frase mensurável (ex.: "Gerar 25 a 35 leads qualificados em 21 dias, a até R$ 80 por lead, de compradores com prazo de até 12 meses").' },
      padrao: { type: 'string', enum: ['econômico', 'médio', 'médio-alto', 'alto padrão', 'luxo'], description: 'Padrão do imóvel, pelo valor e pelos atributos.' },
      persona: { type: 'string', description: 'Quem é o comprador provável e o que ele valoriza (orienta criativo e praças; NÃO vira segmentação demográfica).' },
      pracas: { type: 'array', items: { type: 'object', properties: { cidade: { type: 'string' }, uf: { type: 'string' }, raio_km: { type: 'number' }, motivo: { type: 'string' } }, required: ['cidade', 'uf', 'raio_km'] }, description: '2 a 6 cidades de origem dos compradores, raio mínimo 25 km.' },
      interesses: { type: 'array', items: { type: 'string' }, description: 'Até 8 sinais de interesse (nomes como aparecem no Meta).' },
      orcamento_diario: { type: 'number', description: 'Reais por dia, dentro da faixa do padrão.' },
      duracao_dias: { type: 'number' },
      cpl_estimado: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } }, required: ['min', 'max'], description: 'Custo por lead esperado, em reais.' },
      leads_estimados: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } }, required: ['min', 'max'] },
      justificativa_orcamento: { type: 'string', description: '1 a 2 frases com os números que justificam o orçamento.' },
      plano_otimizacao: { type: 'array', items: { type: 'string' }, description: '3 a 5 ações por fase (ex.: "Dias 1-7: não editar; aprendizado").' },
      textos: { type: 'array', items: { type: 'object', properties: { angulo: { type: 'string' }, texto_principal: { type: 'string' }, titulo: { type: 'string' }, descricao: { type: 'string' } }, required: ['angulo', 'texto_principal', 'titulo'] }, description: 'Exatamente 3 variações, cada uma com um ângulo diferente.' },
      perguntas: { type: 'array', items: { type: 'object', properties: { pergunta: { type: 'string' }, opcoes: { type: 'array', items: { type: 'string' } } }, required: ['pergunta', 'opcoes'] }, description: '2 ou 3 perguntas qualificadoras de múltipla escolha.' },
      agradecimento: { type: 'string', description: 'Texto da tela final do formulário.' },
      dicas: { type: 'array', items: { type: 'string' } },
    },
    required: ['objetivo', 'padrao', 'persona', 'pracas', 'interesses', 'orcamento_diario', 'duracao_dias', 'cpl_estimado', 'leads_estimados', 'justificativa_orcamento', 'plano_otimizacao', 'textos', 'perguntas', 'agradecimento'],
  },
};
// Faixas de referência por padrão (R$/dia, dias, CPL). A IA ajusta dentro delas pela praça e pela concorrência.
const FAIXAS = {
  'econômico': { dia: [30, 50], dias: [14, 21], cpl: [8, 25] },
  'médio': { dia: [40, 70], dias: [14, 21], cpl: [15, 40] },
  'médio-alto': { dia: [60, 100], dias: [21, 28], cpl: [30, 80] },
  'alto padrão': { dia: [80, 150], dias: [21, 28], cpl: [60, 150] },
  'luxo': { dia: [120, 250], dias: [28, 30], cpl: [120, 350] },
};
async function sugerir(item) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY.');
  const tabela = Object.entries(FAIXAS).map(([k, f]) => `- ${k}: R$ ${f.dia[0]} a ${f.dia[1]}/dia · ${f.dias[0]} a ${f.dias[1]} dias · custo por lead esperado R$ ${f.cpl[0]} a ${f.cpl[1]}`).join('\n');
  const sys = `Você é, ao mesmo tempo, gestor de tráfego de alta performance especializado no mercado imobiliário brasileiro e copywriter de imóveis de alto padrão. Trabalha para a Holy Curadoria Imobiliária (Santa Catarina: Chapecó, Balneário Camboriú, Itapema, Porto Belo). Pense como quem é cobrado por resultado: o alvo é o MENOR custo por lead QUALIFICADO (comprador com intenção e capacidade), nunca o lead mais barato.

PASSO 1 · CLASSIFIQUE O PADRÃO
Pelo valor e pelos atributos: econômico (até R$ 350 mil), médio (R$ 350 a 800 mil), médio-alto (R$ 800 mil a 1,5 milhão), alto padrão (R$ 1,5 a 4 milhões), luxo (acima de R$ 4 milhões). Sem valor informado, deduza pelos atributos (metragem, suítes, localização, lazer) e diga isso na justificativa. Empreendimento com várias unidades: use o valor de entrada.

PASSO 2 · DEFINA O OBJETIVO
Uma frase mensurável com volume de leads, prazo e custo por lead máximo, coerentes com o orçamento (leads estimados = investimento total ÷ custo por lead).

PASSO 3 · ORÇAMENTO (referência de mercado; ajuste dentro da faixa pela praça e pela concorrência)
${tabela}
Nunca abaixo de R$ 30/dia nem menos de 14 dias (7 de aprendizado + 7 de otimização). Lançamento com várias unidades pode ir ao topo da faixa.

PASSO 4 · PRAÇAS E SINAIS
Praças = onde moram os compradores prováveis (litoral catarinense atrai Oeste de SC, Serra, Curitiba, Porto Alegre, São Paulo e a própria região; Chapecó atrai a própria cidade e o entorno). Interesses são só sinais para o Advantage+.

PASSO 5 · ANÚNCIOS (3 variações, cada uma com um ângulo DIFERENTE)
A) "Valor e números": abre com o preço ("A partir de R$ …" ou o valor exato) e 2 a 3 dados concretos (m², suítes, vagas, vista, distância do mar) quando fornecidos.
B) "Experiência do imóvel": como é viver ali, através de atributos reais (luz natural, pé-direito, vista, acabamento, planta, lazer). Descreva o imóvel, nunca o comprador.
C) "Localização e exclusividade": o que o endereço entrega (bairro, quadra do mar, acessos, entorno) e por que é raro, sem inventar.
Estrutura do texto principal: 1ª linha é o gancho (até 90 caracteres, aparece antes do "ver mais"); depois 2 a 4 linhas curtas com atributos concretos; termine com a chamada para o formulário (ex.: "Toque em Cadastre-se e receba plantas, fotos e condições.").
Título: até 40 caracteres, concreto. Descrição: até 30 caracteres.
Vocabulário refinado e preciso, à altura do padrão: prefira substantivos concretos ("vista definitiva para o mar", "suíte master com closet", "planta integrada", "pé-direito duplo") a adjetivos vazios. Econômico e médio: direto e acolhedor, foco em condição e praticidade. Alto padrão e luxo: sóbrio, poucas palavras, sem emojis, exclusividade e precisão.
PROIBIDO: "imperdível", "oportunidade única", "sonho", "top", "perfeito", "incrível", "maravilhoso", frases em CAIXA ALTA, excesso de exclamações, promessa de valorização ou rentabilidade, e qualquer dado não fornecido (preço, prazo, condição, metragem).

PASSO 6 · FORMULÁRIO
Perguntas que separam curiosos de compradores: objetivo (morar, investir, temporada), prazo para a compra e forma de pagamento. No alto padrão e no luxo, a forma de pagamento pode virar faixa de investimento.

REGRAS OBRIGATÓRIAS DA META (Categoria Especial de Anúncio: Moradia/HOUSING)
- Proibido segmentar por idade, gênero ou CEP; sem exclusões nem públicos semelhantes.
- Localização só por cidades com raio de no mínimo 25 km.
- Os textos descrevem o IMÓVEL e nunca o tipo de comprador (nada de "ideal para casais", "para famílias", "para executivos", idade, religião, estado civil).

Responda sempre com a ferramenta "estrategia", em português do Brasil.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 4000, system: sys,
      messages: [{ role: 'user', content: 'Dados do anúncio (JSON):\n' + JSON.stringify(item).slice(0, 12000) }],
      tools: [FERRAMENTA], tool_choice: { type: 'tool', name: 'estrategia' } }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  const u = (d.content || []).find((c) => c.type === 'tool_use');
  if (!u) throw new Error('A IA não devolveu a estratégia.');
  const out = u.input;
  out.pracas = (out.pracas || []).map((p) => ({ ...p, raio_km: Math.max(25, Math.min(80, +p.raio_km || 25)) }));
  out.orcamento_diario = Math.max(30, Math.round(+out.orcamento_diario || 50));
  out.duracao_dias = Math.max(14, Math.min(60, Math.round(+out.duracao_dias || 21)));
  out.faixa = FAIXAS[out.padrao] || null;
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
// Carimbo único para nomes na Meta (evita "o nome do formulário já existe" em uma segunda tentativa)
function carimbo() {
  const d = new Date(Date.now() - 3 * 3600000); // horário de Brasília
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}h${p(d.getUTCMinutes())}`;
}
async function criar(b, req) {
  if (!configurado()) throw new Error('Meta não configurada (faltam META_ACCESS_TOKEN, META_AD_ACCOUNT_ID ou META_PAGE_ID).');
  const nome = String(b.nome || 'Holy').slice(0, 60);
  const sufixo = carimbo() + ' ' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const textos = (b.textos || []).filter((t) => t && t.texto_principal).slice(0, 3);
  if (!textos.length) throw new Error('Inclua ao menos um texto.');
  if (!b.foto || !/^https:/.test(b.foto)) throw new Error('Escolha uma foto do imóvel (já enviada para a nuvem).');
  const diario = Math.max(20, Math.round(+b.orcamento_diario || 50));
  const dias = Math.max(3, Math.min(90, Math.round(+b.duracao_dias || 14)));
  const passos = [];
  const criados = { form: null, camp: null };
  let etapa = 'Praças';
  try {
    // cidades
    const cidades = [];
    for (const p of (b.pracas || []).slice(0, 10)) {
      const c = await cidadeKey(p.cidade, p.uf);
      if (c) cidades.push({ key: c.key, radius: Math.max(25, Math.min(80, Math.round(+p.raio_km || 25))), distance_unit: 'kilometer', _nome: c.nome });
    }
    if (!cidades.length) throw new Error('Não encontrei as cidades escolhidas no Meta.');
    passos.push('Praças: ' + cidades.map((c) => c._nome + ' (' + c.radius + ' km)').join(', '));
    // formulário de lead (alta intenção)
    etapa = 'Formulário de lead';
    const ptk = await pageToken();
    const perguntas = [{ type: 'FULL_NAME' }, { type: 'PHONE' }, { type: 'EMAIL' }];
    (b.perguntas || []).slice(0, 3).forEach((q, i) => {
      const ops = (q.opcoes || []).filter(Boolean).slice(0, 6);
      const chave = String(q.pergunta).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'pergunta';
      if (q.pergunta && ops.length >= 2) perguntas.push({ type: 'CUSTOM', key: chave + '_' + (i + 1), label: String(q.pergunta).slice(0, 80), options: ops.map((o, k) => ({ value: String(o).slice(0, 80), key: chave + '_' + (i + 1) + '_' + k })) });
    });
    const linkPagina = b.link && /^https:/.test(b.link) ? b.link : site(req);
    const form = await graph(`${PAGE()}/leadgen_forms`, 'POST', {
      name: `${nome} | ${sufixo}`.slice(0, 100), locale: 'pt_BR',
      questions: perguntas, is_optimized_for_quality: true,
      privacy_policy: { url: site(req) + '/privacidade.html', link_text: 'Política de privacidade da Holy' },
      // botão final abre a conversa com a Helena no Messenger (ela atende na hora); o link do imóvel segue no texto
      thank_you_page: { title: 'Recebemos seu interesse!', body: (String(b.agradecimento || 'Um consultor da Holy vai falar com você pelo WhatsApp em breve.').slice(0, 220) + ' Quer adiantar? Toque em Falar agora.').slice(0, 300), button_type: 'VIEW_WEBSITE', button_text: 'Falar agora', website_url: 'https://m.me/' + PAGE() + '?ref=lead' },
    }, ptk);
    criados.form = form.id;
    passos.push('Formulário de alta intenção criado');
    // campanha
    etapa = 'Campanha';
    const camp = await graph(`${ACT()}/campaigns`, 'POST', {
      name: `Holy | ${nome} | Leads | ${sufixo}`, objective: 'OUTCOME_LEADS', status: 'PAUSED', buying_type: 'AUCTION',
      special_ad_categories: ['HOUSING'], special_ad_category_country: ['BR'], is_adset_budget_sharing_enabled: false,
    });
    criados.camp = camp.id;
    passos.push('Campanha criada (pausada)');
    // conjunto de anúncios
    etapa = 'Público e orçamento';
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
    etapa = 'Imagem do anúncio';
    const hash = await subirImagem(b.foto);
    const ig = await igUser();
    const ads = [];
    for (let i = 0; i < textos.length; i++) {
      etapa = 'Anúncio ' + String.fromCharCode(65 + i);
      const t = textos[i];
      const story = { page_id: PAGE(), link_data: { image_hash: hash, link: linkPagina, message: String(t.texto_principal).slice(0, 2000), name: String(t.titulo || nome).slice(0, 80), description: String(t.descricao || '').slice(0, 60), call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: form.id } } } };
      if (ig) story.instagram_user_id = ig;
      const rot = `${nome} | Variação ${String.fromCharCode(65 + i)}` + (t.angulo ? ' · ' + String(t.angulo).slice(0, 30) : '');
      const cr = await graph(`${ACT()}/adcreatives`, 'POST', { name: rot, object_story_spec: story });
      const ad = await graph(`${ACT()}/ads`, 'POST', { name: rot, adset_id: adset.id, creative: { creative_id: cr.id }, status: 'PAUSED' });
      ads.push(ad.id);
    }
    passos.push(ads.length + ' anúncio(s) para teste A/B' + (ig ? ' (Facebook + Instagram)' : ' (Facebook; Instagram não vinculado à Página)'));
    return { campanha: camp.id, conjunto: adset.id, anuncios: ads, formulario: form.id, passos, orcamento_diario: diario, dias,
      nomeCampanha: `Holy | ${nome} | Leads | ${sufixo}`,
      link: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${ACT().replace('act_', '')}&selected_campaign_ids=${camp.id}` };
  } catch (e) {
    // Desfaz o que ficou pela metade, para não deixar campanha e formulário órfãos na Meta
    const limpeza = [];
    if (criados.camp) { try { await graph(criados.camp, 'DELETE'); limpeza.push('campanha excluída'); } catch (x) { limpeza.push('não consegui excluir a campanha incompleta; exclua no Gerenciador'); } }
    if (criados.form) { try { await graph(criados.form, 'POST', { status: 'ARCHIVED' }, await pageToken()); limpeza.push('formulário arquivado'); } catch (x) { /* formulário sem anúncio não aparece para ninguém */ } }
    throw new Error(`Etapa "${etapa}": ${e.message}` + (limpeza.length ? ` · Desfeito: ${limpeza.join(', ')}.` : ''));
  }
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
// Troca o formulário de uma campanha que já está rodando pelo modelo novo (botão "Falar agora" -> Helena no Messenger).
// A Meta não deixa editar formulário: cria um igual, com as mesmas perguntas, e troca nos anúncios (criativo novo, mesmo texto e imagem).
const FIM_FORM = (corpo) => ({ title: 'Recebemos seu interesse!', body: (String(corpo || 'Um consultor da Holy vai falar com você pelo WhatsApp em breve.').replace(/\s*Quer adiantar\?.*$/, '').slice(0, 220) + ' Quer adiantar? Toque em Falar agora.').slice(0, 300), button_type: 'VIEW_WEBSITE', button_text: 'Falar agora', website_url: 'https://m.me/' + PAGE() + '?ref=lead' });
async function atualizarFormulario(b, req) {
  const ptk = await pageToken();
  if (!b.formulario || !Array.isArray(b.anuncios) || !b.anuncios.length) throw new Error('Campanha sem formulário ou anúncios registrados no CRM.');
  const velho = await graph(String(b.formulario), 'GET', { fields: 'name,locale,questions{key,label,type,options{key,value}},thank_you_page{title,body,button_type},privacy_policy_url' }, ptk);
  const tp = velho.thank_you_page || {};
  if (tp.button_type === 'VIEW_WEBSITE' && /Falar agora/.test(String(tp.body || ''))) return { formulario: b.formulario, jaAtualizado: true, passos: ['Este formulário já está no modelo novo.'] };
  const perguntas = (velho.questions || []).map((q) => q.type === 'CUSTOM'
    ? { type: 'CUSTOM', key: q.key, label: q.label, options: (q.options || []).map((o) => ({ key: o.key, value: o.value })) }
    : { type: q.type });
  const novo = await graph(`${PAGE()}/leadgen_forms`, 'POST', {
    name: (String(velho.name || 'Formulário Holy').replace(/ · v\d+$/, '') + ' · v2').slice(0, 100), locale: velho.locale || 'pt_BR',
    questions: perguntas, is_optimized_for_quality: true,
    privacy_policy: { url: velho.privacy_policy_url || (site(req) + '/privacidade.html'), link_text: 'Política de privacidade da Holy' },
    thank_you_page: FIM_FORM(tp.body),
  }, ptk);
  const passos = ['Formulário novo criado com as mesmas perguntas e o botão "Falar agora"'];
  const trocados = [];
  for (const adId of b.anuncios.slice(0, 10)) {
    const ad = await graph(String(adId), 'GET', { fields: 'name,creative{name,object_story_spec}' });
    const spec = ad.creative && ad.creative.object_story_spec;
    if (!spec) { passos.push('Anúncio ' + adId + ': sem criativo editável, mantido'); continue; }
    const novoSpec = JSON.parse(JSON.stringify(spec));
    const blocos = [novoSpec.link_data, novoSpec.video_data].filter(Boolean);
    let achou = false;
    for (const bl of blocos) { const cta = bl.call_to_action; if (cta && cta.value) { cta.value.lead_gen_form_id = novo.id; achou = true; } }
    if (!achou) { passos.push('Anúncio ' + (ad.name || adId) + ': não usa formulário, mantido'); continue; }
    const cr = await graph(`${ACT()}/adcreatives`, 'POST', { name: String((ad.creative.name || ad.name || 'Criativo') + ' · v2').slice(0, 100), object_story_spec: novoSpec });
    await graph(String(adId), 'POST', { creative: { creative_id: cr.id } });
    trocados.push(adId);
  }
  passos.push(trocados.length + ' anúncio(s) agora usam o formulário novo (a Meta revisa de novo em alguns minutos)');
  return { formulario: novo.id, antigo: b.formulario, trocados, passos };
}
async function mudarStatus(b) {
  const st = b.ativo ? 'ACTIVE' : 'PAUSED';
  for (const id of [...(b.anuncios || []), b.conjunto, b.campanha].filter(Boolean)) await graph(id, 'POST', { status: st });
  return st;
}
export async function puxarLeads(forms) {
  await sql.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_id TEXT');
  await sql.query('CREATE UNIQUE INDEX IF NOT EXISTS leads_meta_idx ON leads (meta_id)');
  const ptk = await pageToken();
  let novos = 0;
  for (const f of (forms || []).slice(0, 30)) {
    if (!f || !f.id) continue;
    let j;
    try { j = await graph(`${f.id}/leads`, 'GET', { fields: 'id,created_time,field_data,ad_name,campaign_name', limit: 100 }, ptk); } catch (e) { continue; }
    // rótulos das perguntas (para gravar "Qual o seu objetivo?: Investir" e não a chave interna)
    // a Meta devolve a CHAVE da opção marcada (ex.: "pergunta_1_0"); "opcoes" traduz para o texto da opção
    const rotulos = {}, opcoes = {};
    try {
      const fq = await graph(f.id, 'GET', { fields: 'questions{key,label,type,options{key,value}}' }, ptk);
      (fq.questions || []).forEach((q) => {
        if (q.key) rotulos[q.key] = q.label || q.key;
        (q.options || []).forEach((o) => { if (o && o.key) opcoes[o.key] = o.value || o.key; });
      });
    } catch (e) {}
    for (const l of j.data || []) {
      const fd = {}; (l.field_data || []).forEach((x) => { fd[x.name] = (x.values || []).map((v) => opcoes[v] || v).join(', '); });
      const nome = fd.full_name || fd.nome_completo || '', tel = fd.phone_number || fd.telefone || '', email = fd.email || '';
      const legivel = (k) => rotulos[k] || (k.replace(/_\d+$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) + '?');
      const extras = Object.entries(fd).filter(([k]) => !['full_name', 'phone_number', 'email', 'nome_completo', 'telefone'].includes(k)).map(([k, v]) => legivel(k).replace(/[?:]?\s*$/, '?') + ' ' + String(v)).join(' | ');
      const campanha = f.item || l.campaign_name || l.ad_name || '';
      const r = await sql.query(
        `INSERT INTO leads (tipo, nome, email, telefone, interesse, mensagem, origem, imovel, meta_id, criado_em)
         VALUES ('formulario', $1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (meta_id) DO NOTHING RETURNING id`,
        [nome || null, email || null, tel || null, f.item || null, extras || null, 'Meta Ads' + (campanha ? ': ' + campanha : ''), f.item || null, l.id, l.created_time || new Date().toISOString()]);
      if (r.length) novos++;
    }
  }
  return novos;
}

// ── Instagram ─────────────────────────────────────────────────────────
// O Instagram processa cada mídia em segundo plano: só dá para publicar quando o status for FINISHED.
async function aguardar(id) {
  for (let i = 0; i < 25; i++) {
    let j = {};
    try { j = await graph(id, 'GET', { fields: 'status_code,status' }); } catch (e) { /* consulta pode falhar logo após criar; tenta de novo */ }
    if (j.status_code === 'FINISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') throw new Error('O Instagram recusou a mídia' + (j.status ? ' (' + j.status + ')' : '') + '.');
    await new Promise((r) => setTimeout(r, i < 5 ? 1500 : 2500));
  }
  throw new Error('O Instagram demorou para processar as imagens. Tente publicar de novo em 1 minuto.');
}
// Publica com novas tentativas quando a Meta responde "mídia não está pronta" (código 9007)
async function publicarContainer(ig, creationId) {
  for (let i = 0; i < 6; i++) {
    try { return (await graph(`${ig}/media_publish`, 'POST', { creation_id: creationId })).id; }
    catch (e) {
      if (!/9007|2207027|não está pronta|not ready/i.test(e.message) || i === 5) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
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
    for (const u of urls) { const c = await graph(`${ig}/media`, 'POST', { image_url: u, media_type: 'STORIES' }); await aguardar(c.id); publicados.push(await publicarContainer(ig, c.id)); }
  } else if (urls.length === 1) {
    const c = await graph(`${ig}/media`, 'POST', { image_url: urls[0], caption: legenda }); await aguardar(c.id);
    publicados.push(await publicarContainer(ig, c.id));
  } else {
    const filhos = (await Promise.all(urls.map((u) => graph(`${ig}/media`, 'POST', { image_url: u, is_carousel_item: true })))).map((c) => c.id);
    await Promise.all(filhos.map((f) => aguardar(f)));
    const car = await graph(`${ig}/media`, 'POST', { media_type: 'CAROUSEL', children: filhos.join(','), caption: legenda }); await aguardar(car.id);
    publicados.push(await publicarContainer(ig, car.id));
  }
  return publicados;
}

// ── Helena no Instagram e no Messenger: liga os avisos de mensagem da Página para o CRM ──
async function conectarMensagens(req) {
  const passos = [];
  const ptk = await pageToken();
  await graph(`${PAGE()}/subscribed_apps`, 'POST', { subscribed_fields: 'messages,messaging_postbacks,message_echoes,leadgen' }, ptk);
  passos.push('Página Holy Imóveis inscrita para receber mensagens (Messenger e Instagram) e leads dos formulários na hora');
  const appId = process.env.META_APP_ID || '1110281681853167', segredo = process.env.META_APP_SECRET, verify = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (!segredo) throw new Error('Falta META_APP_SECRET na Vercel (Chave Secreta do app Holy CRM, em Configurações do app > Básico).');
  if (verify.length < 12) throw new Error('Falta WHATSAPP_VERIFY_TOKEN na Vercel (mínimo 12 letras e números).');
  const callback = site(req) + '/api/whatsapp';
  const appToken = appId + '|' + segredo;
  for (const [object, fields] of [['page', 'messages,messaging_postbacks,message_echoes,leadgen'], ['instagram', 'messages']]) {
    await graph(`${appId}/subscriptions`, 'POST', { object, callback_url: callback, fields, verify_token: verify, include_values: true }, appToken);
    passos.push('Webhook do app para ' + (object === 'page' ? 'Messenger' : 'Instagram') + ' apontando para ' + callback);
  }
  return passos;
}
async function statusMensagens() {
  const out = { messenger: false, instagram: !!(await igUser().catch(() => null)) };
  try { const r = await graph(`${PAGE()}/subscribed_apps`, 'GET', {}, await pageToken()); const meu = (r.data || []).find((a) => String(a.id) === String(process.env.META_APP_ID || '1110281681853167')); out.messenger = !!meu; out.campos = meu ? meu.subscribed_fields : []; } catch (e) { out.erro = e.message; }
  out.segredo = !!process.env.META_APP_SECRET;
  return out;
}

// ── Diagnóstico da Helena no Instagram/Messenger: confere tudo de uma vez ──
async function diagnosticoMensagens() {
  const appId = String(process.env.META_APP_ID || '1110281681853167');
  const segredo = process.env.META_APP_SECRET || '';
  const appToken = appId + '|' + segredo;
  const itens = [];
  const add = (ok, titulo, detalhe = '', acao = '') => itens.push({ ok, titulo, detalhe, acao });

  add(!!segredo, 'META_APP_SECRET na Vercel', segredo ? 'cadastrada' : 'faltando', segredo ? '' : 'Cadastrar a Chave Secreta do app Holy CRM e fazer Redeploy');
  const vt = process.env.WHATSAPP_VERIFY_TOKEN || '';
  add(vt.length >= 12, 'WHATSAPP_VERIFY_TOKEN na Vercel', vt.length >= 12 ? 'cadastrada' : 'faltando ou com menos de 12 caracteres');

  // Chave Secreta: o próprio app responde com o token do app?
  let segredoOk = false;
  if (segredo) {
    try { await graph(appId, 'GET', { fields: 'name' }, appToken); segredoOk = true; add(true, 'Chave Secreta do app confere', 'a Meta aceitou a META_APP_SECRET (as assinaturas do webhook vão bater)'); }
    catch (e) { add(false, 'Chave Secreta do app confere', e.message, 'A META_APP_SECRET na Vercel não é a Chave Secreta do app Holy CRM: copiar de novo (Configurações do app > Básico) e fazer Redeploy'); }
  }

  // Token da Página pelo seu login (Plano B)
  const salvo = await tokenPaginaSalvo();
  let paginaOk = false;
  if (salvo && segredoOk) {
    try {
      const d = (await graph('debug_token', 'GET', { input_token: salvo }, appToken)).data || {};
      const info = (await infoTokenPagina()) || {};
      const faltam = ['pages_messaging', 'instagram_manage_messages'].filter((p) => !(d.scopes || []).includes(p));
      paginaOk = !!d.is_valid && !faltam.length;
      add(paginaOk, 'Token da Página pelo seu login', d.is_valid ? (faltam.length ? 'faltam permissões: ' + faltam.join(', ') : `válido · ${info.origem || ''}${info.salvo_em ? ' em ' + new Date(info.salvo_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''} · expira: ${d.expires_at ? new Date(d.expires_at * 1000).toLocaleDateString('pt-BR') : 'nunca'}`) : 'inválido (senha trocada ou acesso removido?)', paginaOk ? '' : 'Colar um token novo em "Token da Página"');
    } catch (e) { add(false, 'Token da Página pelo seu login', e.message, 'Colar um token novo em "Token da Página"'); }
  } else if (!salvo) {
    add(null, 'Token da Página pelo seu login', 'não cadastrado', 'Se o token do usuário do sistema estiver bloqueado, cadastre em "Token da Página" (botão no topo de Conversas)');
  }

  // Token do usuário do sistema (META_ACCESS_TOKEN): anúncios, leads e, sem o Plano B, mensagens
  if (segredoOk) {
    try {
      const d = (await graph('debug_token', 'GET', { input_token: TOKEN() }, appToken)).data || {};
      await graph(PAGE(), 'GET', { fields: 'name' }); // testa o uso real (pega o "API access blocked")
      add(!!d.is_valid, 'Token do usuário do sistema (META_ACCESS_TOKEN)', d.is_valid ? 'válido · ' + (d.scopes || []).length + ' permissões' : 'inválido');
    } catch (e) {
      add(paginaOk ? null : false, 'Token do usuário do sistema (META_ACCESS_TOKEN)', e.message, paginaOk ? 'Anúncios e leads ficam parados até a Meta liberar; a Helena usa o token da Página' : 'Cadastrar o token da Página pelo seu login (Plano B) ou resolver a restrição na Meta');
    }
  }

  if (segredoOk) {
    try {
      const subs = (await graph(`${appId}/subscriptions`, 'GET', {}, appToken)).data || [];
      for (const [obj, nome] of [['page', 'Messenger'], ['instagram', 'Instagram']]) {
        const s = subs.find((x) => x.object === obj);
        const campos = s ? (s.fields || []).map((f) => f.name || f) : [];
        const urlOk = !!(s && /\/api\/whatsapp/.test(s.callback_url || ''));
        add(!!(s && s.active !== false && urlOk && campos.includes('messages')), 'Webhook do app para o ' + nome,
          s ? `${s.active === false ? 'INATIVO · ' : ''}${s.callback_url} · campos: ${campos.join(', ') || 'nenhum'}` : 'não cadastrado',
          s && urlOk && campos.includes('messages') ? '' : 'Clicar em "Conectar Instagram e Messenger" de novo');
      }
    } catch (e) { add(false, 'Webhooks do app', e.message); }
  }

  try {
    const r = await graph(`${PAGE()}/subscribed_apps`, 'GET', {}, await pageToken());
    const lista = r.data || [];
    const meu = lista.find((a) => String(a.id) === appId);
    add(!!(meu && (meu.subscribed_fields || []).includes('messages')), 'Página Holy Imóveis inscrita no app', meu ? 'campos: ' + (meu.subscribed_fields || []).join(', ') : 'o app Holy CRM não está inscrito', meu ? '' : 'Clicar em "Conectar Instagram e Messenger"');
    const outros = lista.filter((a) => String(a.id) !== appId).map((a) => (a.name || 'app') + ' (' + a.id + ')' + ((a.subscribed_fields || []).includes('messages') ? ' · recebe mensagens' : ''));
    if (outros.length) add(null, 'Outros apps inscritos na Página', outros.join(' · '), 'Só importa se as mensagens chegarem como "standby" no diário abaixo');
  } catch (e) { add(false, 'Página inscrita no app', e.message); }

  try {
    const j = await graph(PAGE(), 'GET', { fields: 'instagram_business_account{id,username}' }, await pageToken());
    const ig = j.instagram_business_account;
    add(!!ig, 'Instagram ligado à Página', ig ? '@' + ig.username + ' · ' + ig.id : 'nenhuma conta do Instagram ligada à Página');
  } catch (e) { add(false, 'Instagram ligado à Página', e.message); }

  const cfgR = (await sql.query("SELECT valor FROM crm_docs WHERE chave = 'wa_config'"))[0];
  const cfg = (cfgR && cfgR.valor) || {};
  add(cfg.ativo !== false && cfg.canaisMeta !== false, 'Helena ligada no CRM',
    cfg.ativo === false ? 'o assistente está desligado' : cfg.canaisMeta === false ? 'está em "Helena só no WhatsApp"' : 'ligada para Instagram e Messenger',
    cfg.ativo === false || cfg.canaisMeta === false ? 'Ligar nos botões verdes do topo de Conversas' : '');

  const logR = (await sql.query("SELECT valor FROM crm_docs WHERE chave = 'webhook_log'"))[0];
  const chegadas = (Array.isArray(logR && logR.valor) ? logR.valor : []).filter((c) => c.object === 'page' || c.object === 'instagram' || c.status !== 200);
  const conversas = await sql.query(`SELECT c.wa_id, c.nome, c.pausado, c.motivo, c.ultima_msg,
      (SELECT count(*)::int FROM wa_mensagens m WHERE m.wa_id = c.wa_id AND m.papel = 'cliente') AS do_cliente,
      (SELECT count(*)::int FROM wa_mensagens m WHERE m.wa_id = c.wa_id AND m.papel = 'assistente') AS da_helena
    FROM wa_conversas c WHERE c.wa_id LIKE 'ig:%' OR c.wa_id LIKE 'fb:%' ORDER BY c.ultima_msg DESC LIMIT 10`);

  // Conclusão em português simples
  let conclusao;
  const vermelho = itens.find((i) => i.ok === false);
  const evs = chegadas.flatMap((c) => c.eventos || []);
  if (vermelho) conclusao = 'Corrigir primeiro: ' + vermelho.titulo + (vermelho.acao ? ' → ' + vermelho.acao : '') + '.';
  else if (chegadas.some((c) => c.status === 401)) conclusao = 'A Meta está entregando, mas a assinatura não confere: a META_APP_SECRET na Vercel não é a do app Holy CRM, ou faltou Redeploy depois de trocá-la.';
  else if (evs.some((e) => e.startsWith('standby'))) conclusao = 'As mensagens chegam como "standby": outro app (ou a caixa de entrada da Meta com automação) está no controle das conversas da Página. É preciso tornar o Holy CRM o app principal em Página > Configurações > Mensagens avançadas.';
  else if (!evs.some((e) => e === 'mensagem')) conclusao = 'Tudo configurado, mas nenhuma mensagem de cliente chegou. Causa mais provável: as permissões de mensagens do app estão com Acesso Padrão; assim a Meta só entrega mensagens de quem tem função no app Holy CRM. Teste mandando de uma conta que seja administradora/testadora do app, ou solicite o Acesso Avançado.';
  else if (conversas.some((c) => c.pausado && /não conseguiu responder/.test(c.motivo || ''))) conclusao = 'As mensagens chegam, mas a Helena falhou ao responder. Veja o motivo na conversa abaixo.';
  else if (conversas.some((c) => c.da_helena > 0)) conclusao = 'Funcionando: mensagens chegaram e a Helena respondeu.';
  else conclusao = 'As mensagens chegam. Se a Helena não respondeu, veja o motivo nas conversas abaixo (pausada, desligada etc.).';

  return { itens, chegadas: chegadas.slice(0, 15), conversas, conclusao };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const s = await sessao(req).catch(() => null);
  if (!s) return err(res, 401, 'Senha do CRM inválida.');
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const b = req.method === 'POST' ? body(req) : (req.query || {});
    const acao = b.acao || (req.query || {}).acao;
    const PERM = { salvarTokenPagina: 'meta.campanha', apagarTokenPagina: 'meta.campanha', diagnosticoMensagens: 'meta.campanha', conectarMensagens: 'meta.campanha', statusMensagens: 'meta.ver', status: 'meta.ver', metricas: 'meta.ver', puxarLeads: 'meta.ver', publicarIG: 'meta.publicar', sugerir: 'meta.campanha', criar: 'meta.campanha', statusCampanha: 'meta.campanha', atualizarFormulario: 'meta.campanha' };
    if (PERM[acao] && !pode(s, PERM[acao])) return err(res, 403, 'Seu perfil não tem acesso a esta função da Meta.');
    if (acao === 'status') {
      if (!configurado()) return ok(res, { configurado: false, faltando: ['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID', 'META_PAGE_ID'].filter((k) => !process.env[k]) });
      const out = { configurado: true };
      try {
        const a = await graph(ACT(), 'GET', { fields: 'name,currency,account_status,is_prepay_account,funding_source_details,spend_cap,amount_spent' });
        out.conta = a.name; out.moeda = a.currency; out.contaAtiva = a.account_status === 1;
        out.prepago = !!a.is_prepay_account;
        const fsd = a.funding_source_details || {};
        out.pagamento = fsd.display_string || '';
        // Contas pré-pagas (Pix/boleto): a Meta mostra o saldo no texto, ex. "Saldo disponível (R$6,07 BRL)"
        const mm = String(fsd.display_string || '').match(/R\$\s?([\d.]+,\d{2}|[\d.]+)/);
        if (mm) out.saldo = +mm[1].replace(/\./g, '').replace(',', '.');
        if (+a.spend_cap) out.limiteGasto = (+a.spend_cap - (+a.amount_spent || 0)) / 100;
      } catch (e) { out.erroConta = e.message; }
      try { const p = await graph(PAGE(), 'GET', { fields: 'name' }); out.pagina = p.name; } catch (e) { out.erroPagina = e.message; }
      try { const ig = await igUser(); if (ig) { const i = await graph(ig, 'GET', { fields: 'username' }); out.instagram = '@' + i.username; } } catch (e) {}
      return ok(res, out);
    }
    if (acao === 'sugerir') return ok(res, { estrategia: await sugerir(b.item || {}) });
    if (acao === 'criar') return ok(res, await criar(b, req));
    if (acao === 'metricas') return ok(res, { metricas: await metricas(b.ids) });
    if (acao === 'statusCampanha') return ok(res, { status: await mudarStatus(b) });
    if (acao === 'atualizarFormulario') return ok(res, await atualizarFormulario(b, req));
    if (acao === 'puxarLeads') return ok(res, { novos: configurado() ? await puxarLeads(b.forms) : 0 });
    if (acao === 'publicarIG') return ok(res, { publicados: await publicarIG(b) });
    if (acao === 'conectarMensagens') return ok(res, { passos: await conectarMensagens(req) });
    if (acao === 'statusMensagens') return ok(res, await statusMensagens());
    if (acao === 'diagnosticoMensagens') return ok(res, await diagnosticoMensagens());
    if (acao === 'salvarTokenPagina') return ok(res, { info: await salvarTokenPagina(b.token, s.nome || s.email || '') });
    if (acao === 'apagarTokenPagina') { await apagarTokenPagina(); return ok(res); }
    return err(res, 400, 'Ação desconhecida.');
  } catch (e) {
    if (e && e.message === 'DB_NAO_CONFIGURADO') return fail(res, e);
    return err(res, 400, e.message || 'Erro na Meta');
  }
}
