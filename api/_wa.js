// Motor do assistente de WhatsApp da Holy
// Funciona com a API oficial direto da Meta ou via parceiro oficial 360dialog (necessário para Coexistência).
import { proximoResponsavel } from './_auth.js';
import { avisarHelena } from './_avisos.js';
import { sql, ensureSchema, atualizarDoc } from './_lib.js';
import { tokenPaginaSalvo } from './_metatoken.js';
import { paraSite as imovelSite } from './imoveis.js';
import { paraSite as emprSite } from './empreendimentos.js';

const ETAPAS = ['Prospecção', 'Qualificação', 'Proposta', 'Negociação', 'Pós-venda'];
const TEMP = { frio: 'cold', morno: 'warm', quente: 'hot' };
const MOTIVOS = {
  pediu_visita: 'Quer agendar uma visita',
  pediu_humano: 'Pediu para falar com você',
  duvida_pontual: 'Tem uma dúvida que só você pode responder',
  outro: 'Precisa de você',
};

export const PADRAO_CONFIG = {
  ativo: true,
  nomeAssistente: 'Helena',
  apresentacao: 'Helena, assistente virtual da Holy',
  tom: 'Informal, porém elegante: próxima e calorosa, como uma consultora experiente de imóveis de alto padrão conversando no WhatsApp. Frases curtas, português correto, sem gírias (nunca use "top"), no máximo um emoji por mensagem. Trata o cliente pelo primeiro nome quando souber.',
  infoHoly: 'Holy Curadoria Imobiliária: curadoria de imóveis de alto padrão em Santa Catarina, com atuação em Chapecó, Balneário Camboriú, Itapema e Porto Belo. O corretor responsável é o Édipo Junior, com 16 anos de trajetória no mercado imobiliário.',
  regras: '',
  horaInicio: 8,
  horaFim: 20,
  retorno: '',
  semHorario: true,
  avisoNumero: '',
  retomada: true,      // Helena retoma 1 vez quem parou de responder (dentro da janela de 24h)
  retomadaHoras: 4,    // depois de quantas horas sem resposta
};

// ── Envio ──────────────────────────────────────────────────────────────
// Kapso (plano gratuito com Coexistência) → 360dialog → Meta direto
const KAPSO_META = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const KAPSO_PLAT = 'https://api.kapso.ai/platform/v1';
let _kapsoPhone = null;
export async function kapsoNumero() {
  if (process.env.KAPSO_PHONE_NUMBER_ID) return process.env.KAPSO_PHONE_NUMBER_ID;
  if (_kapsoPhone) return _kapsoPhone;
  const r = await fetch(KAPSO_PLAT + '/whatsapp/phone_numbers', { headers: { 'X-API-Key': process.env.KAPSO_API_KEY } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Kapso recusou a chave: ' + (j.error || r.status));
  const lista = Array.isArray(j.data) ? j.data : [];
  const n = lista.find((x) => String(x.status || '').toUpperCase() === 'CONNECTED') || lista[0];
  if (!n) throw new Error('Nenhum número conectado na Kapso ainda.');
  _kapsoPhone = String(n.phone_number_id || n.id);
  return _kapsoPhone;
}
async function destino() {
  if (process.env.KAPSO_API_KEY) {
    return { url: `${KAPSO_META}/${await kapsoNumero()}/messages`, headers: { 'X-API-Key': process.env.KAPSO_API_KEY } };
  }
  if (process.env.WHATSAPP_D360_KEY) {
    return { url: 'https://waba-v2.360dialog.io/messages', headers: { 'D360-API-KEY': process.env.WHATSAPP_D360_KEY } };
  }
  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    const v = process.env.WHATSAPP_API_VERSION || 'v23.0';
    return { url: `https://graph.facebook.com/${v}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN } };
  }
  return null;
}
export const whatsappConfigurado = () => !!(process.env.KAPSO_API_KEY || process.env.WHATSAPP_D360_KEY || (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID));
export const provedor = () => process.env.KAPSO_API_KEY ? 'Kapso' : process.env.WHATSAPP_D360_KEY ? '360dialog' : process.env.WHATSAPP_TOKEN ? 'Meta' : null;

// Cadastra (ou atualiza) o webhook na Kapso, no formato da Meta
export async function conectarWebhookKapso(url, segredo) {
  const id = await kapsoNumero();
  const h = { 'X-API-Key': process.env.KAPSO_API_KEY, 'Content-Type': 'application/json' };
  const base = `${KAPSO_PLAT}/whatsapp/phone_numbers/${id}/webhooks`;
  const corpo = JSON.stringify({ whatsapp_webhook: { kind: 'meta', url, secret_key: segredo, active: true } });
  const lst = await fetch(base, { headers: h }).then((r) => r.json()).catch(() => ({}));
  const atual = (Array.isArray(lst.data) ? lst.data : []).find((w) => w.kind === 'meta');
  let r;
  if (atual) {
    r = await fetch(`${base}/${atual.id}`, { method: 'PATCH', headers: h, body: corpo });
    if (!r.ok) { await fetch(`${base}/${atual.id}`, { method: 'DELETE', headers: h }); r = await fetch(base, { method: 'POST', headers: h, body: corpo }); }
  } else {
    r = await fetch(base, { method: 'POST', headers: h, body: corpo });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Kapso recusou o webhook: ' + (j.error || JSON.stringify(j).slice(0, 200)));
  return id;
}

async function postar(payload) {
  const d = await destino();
  if (!d) throw new Error('WhatsApp não configurado (faltam as chaves na Vercel).');
  const r = await fetch(d.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...d.headers }, body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('WhatsApp recusou: ' + (j.error && (j.error.message || j.error.title) || r.status));
  return j;
}
// ── Instagram e Messenger (Página da Holy pela API da Meta) ─────────────
// As conversas usam o id com prefixo: "ig:<id>" (Instagram) e "fb:<id>" (Messenger). Sem prefixo = WhatsApp.
export const canalDe = (id) => (String(id).startsWith('ig:') ? 'instagram' : String(id).startsWith('fb:') ? 'messenger' : 'whatsapp');
export const NOME_CANAL = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger (Facebook)' };
const GRAPH = 'https://graph.facebook.com/v21.0';
let _ptk = null;
async function tokenPagina() {
  const salvo = await tokenPaginaSalvo(); // token da Página pelo login do Édipo (Plano B)
  if (salvo) return salvo;
  if (_ptk && _ptk.exp > Date.now()) return _ptk.t;
  if (!process.env.META_ACCESS_TOKEN || !process.env.META_PAGE_ID) throw new Error('Meta não configurada (META_ACCESS_TOKEN e META_PAGE_ID).');
  const r = await fetch(`${GRAPH}/${process.env.META_PAGE_ID}?fields=access_token&access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('Não consegui o acesso da Página: ' + ((j.error && j.error.message) || r.status));
  _ptk = { t: j.access_token, exp: Date.now() + 30 * 60000 };
  return _ptk.t;
}
async function enviarMeta(id, texto) {
  const canal = canalDe(id), alvo = String(id).slice(3), max = canal === 'instagram' ? 950 : 1900;
  const ptk = await tokenPagina();
  let t = String(texto || '').trim(), ultimo = null;
  while (t) {
    let i = t.length <= max ? t.length : (t.lastIndexOf('\n', max) > 300 ? t.lastIndexOf('\n', max) : (t.lastIndexOf(' ', max) > 300 ? t.lastIndexOf(' ', max) : max));
    const parte = t.slice(0, i).trim(); t = t.slice(i).trim();
    if (!parte) continue;
    const r = await fetch(`${GRAPH}/${process.env.META_PAGE_ID}/messages?access_token=${encodeURIComponent(ptk)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: alvo }, messaging_type: 'RESPONSE', message: { text: parte } }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(NOME_CANAL[canal] + ' recusou: ' + ((j.error && j.error.message) || r.status));
    ultimo = j.message_id || null;
  }
  return ultimo;
}
// Nome público de quem escreveu (Messenger: nome; Instagram: nome ou @usuário)
export async function perfilMeta(id) {
  try {
    const canal = canalDe(id), ptk = await tokenPagina();
    const r = await fetch(`${GRAPH}/${String(id).slice(3)}?fields=${canal === 'instagram' ? 'name,username' : 'name'}&access_token=${encodeURIComponent(ptk)}`);
    const j = await r.json();
    return j.name || (j.username ? '@' + j.username : '');
  } catch (e) { return ''; }
}
export async function enviarTexto(waId, texto) {
  if (canalDe(waId) !== 'whatsapp') return enviarMeta(waId, texto);
  const partes = [];
  let t = String(texto || '').trim();
  while (t.length > 3800) { const i = t.lastIndexOf('\n', 3800) > 1000 ? t.lastIndexOf('\n', 3800) : 3800; partes.push(t.slice(0, i)); t = t.slice(i).trim(); }
  if (t) partes.push(t);
  let ultimo = null;
  for (const p of partes) ultimo = await postar({ recipient_type: 'individual', to: waId, type: 'text', text: { body: p, preview_url: true } });
  return ultimo && ultimo.messages && ultimo.messages[0] ? ultimo.messages[0].id : null;
}
export async function marcarLida(wamid) {
  if (!wamid || /^(m_|ig_|mid\.)/.test(String(wamid))) return; // Instagram/Messenger não usam este aviso
  try { await postar({ status: 'read', message_id: wamid }); } catch (e) { /* não é crítico */ }
}

// ── Banco ──────────────────────────────────────────────────────────────
export async function salvarMensagem(waId, papel, texto, wamid, nome) {
  await ensureSchema();
  const ins = await sql.query(
    `INSERT INTO wa_mensagens (wa_id, wamid, papel, texto) VALUES ($1, $2, $3, $4) ON CONFLICT (wamid) DO NOTHING RETURNING id`,
    [waId, wamid || null, papel, String(texto).slice(0, 8000)]);
  if (!ins.length) return null; // mensagem repetida (a Meta reenviou)
  await sql.query(
    `INSERT INTO wa_conversas (wa_id, nome, ultima_msg, ultima_cliente) VALUES ($1, $2, now(), CASE WHEN $3 = 'cliente' THEN now() END)
     ON CONFLICT (wa_id) DO UPDATE SET nome = COALESCE(wa_conversas.nome, EXCLUDED.nome), ultima_msg = now(),
       ultima_cliente = CASE WHEN $3 = 'cliente' THEN now() ELSE wa_conversas.ultima_cliente END`,
    [waId, nome || null, papel]);
  return ins[0].id;
}
export async function lerConfig() {
  const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'wa_config'");
  return Object.assign({}, PADRAO_CONFIG, (r[0] && r[0].valor) || {});
}

// ── Catálogo vindo do CRM ──────────────────────────────────────────────
const brl = (v) => v ? 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : 'valor sob consulta';
export async function catalogo(site) {
  const r = await sql.query("SELECT chave, valor FROM crm_docs WHERE chave IN ('imoveis','empreendimentos')");
  const doc = Object.fromEntries(r.map((x) => [x.chave, Array.isArray(x.valor) ? x.valor : []]));
  const emps = (doc.empreendimentos || []).filter((e) => e && e.publicarSite !== false).map(emprSite);
  const ims = (doc.imoveis || []).filter((i) => i && i.publicarSite === true && i.status === 'Disponível').map(imovelSite);
  const linhas = [];
  emps.forEach((e) => linhas.push(`- [EMPREENDIMENTO] ${e.nome} | ${e.cidade} | ${e.status}${e.tipoLabel ? ' | ' + e.tipoLabel : ''} | ${e.preco}`
    + (e.destaques.length ? ' | ' + e.destaques.map((d) => d.n + ' ' + d.l).join(', ') : '')
    + (e.lazer.length ? ' | Lazer: ' + e.lazer.join(', ') : '')
    + (e.ficha.length ? ' | ' + e.ficha.map((f) => f[0] + ': ' + f[1]).join('; ') : '')
    + ` | Página: ${site}/#empreendimento-${e.id}`));
  ims.forEach((i) => linhas.push(`- [IMÓVEL ${i.ref || i.id}] ${i.nome} | ${i.tipo} | ${[i.bairro, i.cidade].filter(Boolean).join(', ')}`
    + (i.area ? ` | área total ${i.area} m²` : '') + (i.areaPrivativa && i.areaPrivativa !== i.area ? ` | área privativa ${i.areaPrivativa} m²` : '') + (i.quartos ? ` | ${i.quartos} dorm.` : '') + (i.suites ? ` | ${i.suites} suítes` : '') + (i.vagas ? ` | ${i.vagas} vagas` : '')
    + ` | ${i.finalidade === 'Locação' ? 'Aluguel' : 'Venda'}: ${brl(i.valor)}`
    + (i.lavabos ? ` | ${i.lavabos} lavabo(s)` : '') + (i.diferenciais.length ? ' | ' + i.diferenciais.slice(0, 8).join(', ') : '') + (i.lazer && i.lazer.length ? ' | Lazer: ' + i.lazer.slice(0, 10).join(', ') : '')
    + ` | Página: ${site}/#imovel-${i.id}`));
  return linhas.join('\n').slice(0, 24000) || '(nenhum imóvel ou empreendimento publicado no momento)';
}

// ── Cérebro (Claude) ───────────────────────────────────────────────────
const FERRAMENTA = {
  name: 'responder',
  description: 'Envia a próxima mensagem ao cliente e registra o que se sabe dele.',
  input_schema: {
    type: 'object',
    properties: {
      resposta: { type: 'string', description: 'Mensagem para o cliente (WhatsApp, Instagram ou Messenger), em português do Brasil.' },
      nome_cliente: { type: 'string', description: 'Nome do cliente, se ele informou. Vazio se não souber.' },
      telefone_cliente: { type: 'string', description: 'WhatsApp/telefone que o cliente informou na conversa (Instagram e Messenger). Vazio se não informou.' },
      perfil: {
        type: 'object',
        properties: {
          objetivo: { type: 'string', description: 'morar, revenda, long stay (locação anual) ou short stay (temporada)' },
          desejos: { type: 'string', description: 'o que o cliente valoriza: vista, lazer, bairro, metragem, andar etc.' },
          objecoes: { type: 'string', description: 'receios ou impedimentos citados: preço, prazo de entrega, localização etc.' },
          cidades: { type: 'string' }, tipo_imovel: { type: 'string' }, faixa_valor: { type: 'string' },
          quartos: { type: 'string' }, prazo: { type: 'string' }, pagamento: { type: 'string', description: 'à vista, financiamento, permuta…' },
          interesse_em: { type: 'string', description: 'imóveis/empreendimentos do catálogo que despertaram interesse' },
          entrada: { type: 'string', description: 'valor ou % de entrada / recursos próprios disponíveis, como o cliente disse' },
          financiamento: { type: 'string', description: 'situação do financiamento: não vai usar, ainda não simulou, já simulou (banco/valor), crédito aprovado' },
          parcela_confortavel: { type: 'string', description: 'parcela mensal que o cliente considera confortável, se disse' },
          depende_venda: { type: 'string', description: 'se precisa vender outro imóvel/bem para comprar e em que pé está' },
          imovel_permuta: { type: 'string', description: 'imóvel oferecido em permuta: tipo, bairro/cidade, metragem, valor estimado, quitado ou não' },
          decisores: { type: 'string', description: 'quem participa da decisão (sozinho, cônjuge, família, sócio)' },
          momento: { type: 'string', description: 'maturidade: pronto para avançar já, ou o que falta resolver antes' },
          disponibilidade: { type: 'string', description: 'dias/horários em que o cliente pode visitar ou conversar' },
        },
      },
      maturidade: { type: 'string', enum: ['pronto', 'morno', 'frio', 'indefinido'], description: 'pronto = forma de pagamento clara e viável para o valor + decide/está alinhado + prazo curto; morno = interesse real mas depende de simular financiamento, vender/avaliar imóvel ou alinhar decisão; frio = pagamento não fecha com o valor ou só curiosidade; indefinido = ainda sem dados.' },
      temperatura: { type: 'string', enum: ['frio', 'morno', 'quente'] },
      etapa_funil: { type: 'string', enum: ETAPAS },
      transferir: { type: 'boolean', description: 'true para passar a conversa ao Édipo agora.' },
      motivo_transferencia: { type: 'string', enum: Object.keys(MOTIVOS) },
      resumo: { type: 'string', description: 'Resumo de 1 a 3 frases para o corretor: quem é, o que busca, como pretende pagar, quem decide, o que falta e o próximo passo sugerido.' },
    },
    required: ['resposta', 'temperatura', 'etapa_funil', 'maturidade', 'transferir', 'resumo'],
  },
};

export function noHorario(cfg, d = new Date()) {
  const h = +d.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }) % 24;
  return h >= +cfg.horaInicio && h < +cfg.horaFim;
}
function prompt(cfg, cat) {
  const agora = new Date();
  const hoje = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  const hora = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const semPromessa = cfg.semHorario !== false || !String(cfg.retorno || '').trim();
  const dentro = semPromessa || noHorario(cfg, agora);
  const canal = cfg._canal || 'whatsapp';
  const extraCanal = canal === 'whatsapp' ? '' : `\n\nCANAL: ${NOME_CANAL[canal]}\n- Você está respondendo uma mensagem direta no ${NOME_CANAL[canal]} da Holy. Escreva mensagens curtas, próprias de chat${canal === 'instagram' ? ' (no Instagram, no máximo 2 parágrafos curtos)' : ''}.\n- Aqui não temos o telefone do cliente. Quando a conversa evoluir (interesse real, visita, proposta ou passagem para o Édipo), peça de forma natural o WhatsApp dele para o Édipo continuar o atendimento, e registre em telefone_cliente.`;
  return `Você é a ${cfg.nomeAssistente}, que atende pelo ${NOME_CANAL[canal]} da Holy Curadoria Imobiliária. A data e a hora atuais, e o que já sabemos do cliente, estão no fim destas instruções.${extraCanal}

IDENTIDADE
- Você é a ${cfg.apresentacao || cfg.nomeAssistente}. Apresente-se assim, de forma natural, na primeira resposta da conversa, e confirme que é uma assistente virtual sempre que perguntarem. Nunca afirme ser o Édipo ou uma pessoa.
- Você escreve no tom do Édipo, mas fala em nome da Holy. Use o feminino ao falar de si mesma.

HORÁRIOS
${semPromessa ? `- Você atende 24 horas. Ao passar a conversa, diga apenas que o Édipo vai continuar o atendimento por aqui mesmo. NUNCA prometa horário de atendimento nem prazo de retorno do Édipo.` : `- Você atende 24 horas. O Édipo atende das ${cfg.horaInicio}h às ${cfg.horaFim}h e retorna ${cfg.retorno}.
- Agora ${dentro ? `está DENTRO do horário do Édipo: ao passar a conversa, diga que ele retorna ${cfg.retorno}.` : `está FORA do horário do Édipo: ao passar a conversa, diga que ele retorna a partir das ${cfg.horaInicio}h, e continue disponível para tirar dúvidas até lá.`}`}

TOM
${cfg.tom}

SOBRE A HOLY
${cfg.infoHoly}
Se o cliente perguntar algo sobre a Holy que não esteja escrito aqui, diga que vai confirmar com o Édipo. Não invente.

OBJETIVO
Conduza o atendimento como o melhor corretor da Holy: acolhedor, curioso e consultivo. Sua missão é entregar ao Édipo um cliente QUALIFICADO — com tudo o que ele precisa saber antes de uma visita — sem que o cliente sinta que preencheu um formulário.

QUALIFICAÇÃO (siga esta ordem, pulando o que você já sabe pelo histórico, pelo formulário ou pelo CRM)
1. Conexão e desejo: entenda o que encantou o cliente e o que não pode faltar no próximo imóvel (bairro, vagas, varanda, andar, lazer, pet). Mostre como o imóvel atende ao que ele disse.
2. Objetivo e prazo: morar, revenda, long stay ou short stay; e para quando ele imagina a mudança/compra.
3. Forma de pagamento — SEMPRE antes de falar em visita. Pergunte com leveza e com um motivo que ajuda o cliente, por exemplo: "Pra eu já te passar as condições certinhas: você pensa em recursos próprios, financiamento, ou usar algum imóvel na negociação?"
4. Aprofunde conforme a resposta (uma pergunta por mensagem):
   - Recursos próprios / à vista: o valor já está disponível ou depende de vender algo ou de resgate? (depende_venda)
   - Financiamento: já simulou ou tem crédito aprovado? Quanto pensa em dar de entrada? Que parcela ficaria confortável? Se não simulou, ofereça: "o Édipo pode te ajudar a simular e ver qual banco sai melhor". Explique conceitos com simplicidade se perguntarem (entrada, FGTS, SAC x Price), sem citar taxas, aprovação ou valores de parcela.
   - Permuta: qual imóvel (tipo, bairro, metragem, valor que ele estima, se está quitado) e se o complemento seria à vista ou financiado. Diga que a Holy avalia o imóvel dele sem compromisso.
5. Decisão: quem mais participa da escolha? Se houver cônjuge/família, sugira que venham juntos na visita.
6. Momento: se encontrar o imóvel certo, ele consegue avançar já ou precisa resolver algo antes?
7. Disponibilidade: quais dias e horários ficam bons para conhecer o imóvel.
Com isso completo (ou o essencial: pagamento, decisores e disponibilidade), convide para a visita e transfira para o Édipo (pediu_visita).

COMO PERGUNTAR (humanização)
- UMA pergunta por mensagem, sempre depois de reagir ao que o cliente disse (valide, comente, conecte com o imóvel). Nunca duas perguntas seguidas na mesma mensagem.
- Justifique as perguntas sensíveis com um benefício para o cliente ("pra não te mostrar nada fora do seu momento", "pra deixar tudo pronto pro Édipo").
- Nunca pergunte renda, salário ou dados pessoais/documentos. Use entrada e parcela confortável.
- Se o cliente desviar ou não quiser responder, respeite, siga a conversa e retome depois com naturalidade.
- Espelhe o jeito do cliente (formal/informal, curto/longo). Use o nome dele de vez em quando.
- Se ele já respondeu algo no formulário do anúncio (aparece no histórico/CRM), não pergunte de novo: confirme e aprofunde ("vi que você pensa em permuta + complemento, me conta do seu imóvel?").
- Registre tudo o que descobrir em perfil e atualize maturidade a cada mensagem.

Quando houver opções compatíveis, apresente no máximo 3, com 1 linha cada e o link da página. Se nada combinar, diga que a Holy faz curadoria sob medida e que o Édipo pode buscar opções fora do site.

CATÁLOGO (só existe o que está abaixo; nunca invente imóveis, valores, metragens, prazos ou condições)
${cat}

REGRAS
- Não prometa aprovação de financiamento, descontos, condições de pagamento ou datas que não estejam no catálogo.
- Nunca informe endereço exato, número do apartamento, nem dados de proprietários. Fale de bairro e cidade.
- Você não negocia valores nem condições. Se o cliente quiser fazer proposta, pedir desconto ou condição especial, isso é uma dúvida que só o Édipo responde (duvida_pontual).
- Assuntos sem relação com imóveis e com a Holy: responda com gentileza que você ajuda apenas com imóveis da Holy.
- Se o cliente mandar áudio, foto ou arquivo, diga que por aqui você só consegue ler texto e peça para ele escrever; se for importante, ofereça passar para o Édipo.
${cfg.regras ? '- ' + String(cfg.regras).split('\n').filter(Boolean).join('\n- ') : ''}

QUANDO PASSAR PARA O ÉDIPO (transferir = true) — SOMENTE nestes casos
- pediu_visita: quer agendar ou fazer uma visita. Antes de transferir, se ainda faltar forma de pagamento, decisores ou disponibilidade, faça no máximo 2 perguntas essenciais (uma por mensagem), com naturalidade ("pra eu já deixar tudo pronto pro Édipo…"). Se o cliente insistir ou demonstrar pressa, transfira na hora.
- pediu_humano: pediu para falar com uma pessoa, com o corretor ou com o Édipo. Transfira na hora, sem mais perguntas.
- duvida_pontual: fez uma pergunta específica que o catálogo e as informações da Holy não respondem (ex.: proposta de valor, condição especial, documentação de um imóvel, disponibilidade de unidade específica).
Em qualquer outra situação, continue conduzindo você mesmo, mesmo que o cliente esteja muito interessado.
Ao transferir, avise com naturalidade que o Édipo vai continuar o atendimento por aqui mesmo, respeitando o que está em HORÁRIOS. Não faça mais perguntas nessa mensagem.

FORMATO
Mensagens curtas de WhatsApp (até 4 ou 5 linhas). Sem títulos, tabelas ou markdown; pode usar *negrito* do WhatsApp com moderação. Links sempre completos.
Use SEMPRE a ferramenta "responder".${cfg._retomada ? `

RETOMADA (esta mensagem)
O cliente parou de responder há algumas horas. Escreva UMA única mensagem curta de retomada, leve e sem pressão, que traga algo de valor ligado ao que ele contou: um imóvel ou empreendimento do catálogo compatível (com o link), uma informação útil sobre o bairro ou a condição, ou uma pergunta simples que facilite a resposta. Não repita o que já foi dito, não cobre resposta, não diga que ele sumiu. Se não houver nada de valor para oferecer, faça só uma pergunta curta e gentil. transferir = false.` : ''}${CORTE}AGORA: ${hoje}, ${hora} (horário de Brasília).${cfg._ficha ? `

O QUE JÁ SABEMOS DESTE CLIENTE (CRM — use para não repetir perguntas; não cite que veio do sistema)
${cfg._ficha}` : ''}`;
}
// A parte fixa das instruções (tom, regras, catálogo) vai em cache na Anthropic: corta a maior parte do custo de entrada.
// O que muda a cada mensagem (data, hora e ficha do cliente) fica depois do corte, fora do cache.
const CORTE = '\n\n<<<FIM_FIXO>>>\n\n';
function blocosSistema(texto) {
  const i = texto.indexOf(CORTE);
  if (i < 0) return texto;
  return [
    { type: 'text', text: texto.slice(0, i), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: texto.slice(i + CORTE.length) },
  ];
}

export function montarHistorico(msgs) {
  const out = [];
  for (const m of msgs) {
    const role = m.papel === 'cliente' ? 'user' : 'assistant';
    const txt = m.papel === 'humano' ? '[Mensagem enviada pelo Édipo]: ' + m.texto : m.texto;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + txt;
    else out.push({ role, content: txt });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// O que o CRM já sabe do cliente (respostas do formulário do anúncio, perfil anterior), para a Helena não perguntar de novo
export async function fichaCliente(waId, conv) {
  try {
    const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'clientes'");
    const lista = Array.isArray(r[0] && r[0].valor) ? r[0].valor : [];
    const fim8 = String(waId || '').replace(/\D/g, '').slice(-8);
    const c = lista.find((x) => conv && x.id === conv.cliente_id) || (canalDe(waId) === 'whatsapp' && fim8.length === 8 ? lista.find((x) => String(x.celular || x.tel || '').replace(/\D/g, '').slice(-8) === fim8) : null);
    if (!c) return '';
    const p = c.perfilWhatsApp || {};
    const perfil = Object.entries(p).filter(([, v]) => v).map(([k, v]) => k.replace(/_/g, ' ') + ': ' + v).join(' · ');
    return [
      'Nome: ' + (c.nome || '') + (c.origem ? ' · Origem: ' + c.origem : ''),
      c.obs ? 'Anotações: ' + String(c.obs).replace(/\[WhatsApp\][\s\S]*/, '').trim().slice(0, 900) : '',
      perfil ? 'Já levantado: ' + perfil : '',
      c.maturidade ? 'Maturidade anterior: ' + c.maturidade : '',
    ].filter((x) => x && !/^Anotações: $/.test(x)).join('\n');
  } catch (e) { return ''; }
}

export async function pensar(cfg, cat, historico) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Sem ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 900,
      system: blocosSistema(prompt(cfg, cat)), messages: historico,
      tools: [FERRAMENTA], tool_choice: { type: 'tool', name: 'responder' },
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || 'erro da IA');
  const uso = (d.content || []).find((c) => c.type === 'tool_use');
  if (!uso || !uso.input || !String(uso.input.resposta || '').trim()) throw new Error('IA sem resposta válida');
  return uso.input;
}

// ── CRM ────────────────────────────────────────────────────────────────
function telefoneBR(waId) {
  const d = String(waId).replace(/\D/g, '');
  const n = d.startsWith('55') ? d.slice(2) : d;
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return '+' + d;
}
const rid = () => Math.random().toString(36).slice(2, 9);
const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const agoraHM = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

async function sincronizarCRM(waId, conv, out, nomePerfil) {
  const canal = canalDe(waId);
  const telInformado = String(out.telefone_cliente || '').replace(/\D/g, '');
  const tel = canal === 'whatsapp' ? telefoneBR(waId) : (telInformado.length >= 10 ? telefoneBR(telInformado) : '');
  const fim8 = (canal === 'whatsapp' ? String(waId) : telInformado).replace(/\D/g, '').slice(-8);
  const p = out.perfil || {};
  const perfilTxt = [['Objetivo', p.objetivo], ['Desejos', p.desejos], ['Objeções', p.objecoes], ['Cidades', p.cidades], ['Tipo', p.tipo_imovel], ['Faixa de valor', p.faixa_valor], ['Quartos', p.quartos], ['Prazo', p.prazo], ['Pagamento', p.pagamento], ['Entrada', p.entrada], ['Financiamento', p.financiamento], ['Parcela confortável', p.parcela_confortavel], ['Depende de venda', p.depende_venda], ['Permuta', p.imovel_permuta], ['Decisores', p.decisores], ['Momento', p.momento], ['Disponibilidade', p.disponibilidade], ['Interesse', p.interesse_em]]
    .filter((x) => x[1]).map((x) => x[0] + ': ' + x[1]).join(' · ');
  const bloco = '[WhatsApp] ' + (canal !== 'whatsapp' ? '(' + NOME_CANAL[canal] + ') ' : '') + (out.resumo || '') + (perfilTxt ? '\n' + perfilTxt : '');
  let clienteId = conv.cliente_id, novo = false, nomeFinal = '';
  await atualizarDoc('clientes', async (lista) => {
    lista = Array.isArray(lista) ? lista : [];
    let c = lista.find((x) => x.id === clienteId) || (fim8.length === 8 ? lista.find((x) => String(x.celular || x.tel || '').replace(/\D/g, '').slice(-8) === fim8) : null);
    if (!c) {
      novo = true;
      const nome = (out.nome_cliente || nomePerfil || (canal === 'whatsapp' ? 'Contato WhatsApp ' + tel.slice(-4) : 'Contato ' + NOME_CANAL[canal].split(' ')[0])).trim();
      c = { id: 'cl' + rid(), nome, avatar: nome.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2), email: '', celular: tel, tel: '', cpf: '', nascimento: '', profissao: '', empresa: '', renda: 0, patrimonioEst: 0, origem: canal === 'whatsapp' ? 'WhatsApp' : canal === 'instagram' ? 'Instagram' : 'Facebook', stage: 'Prospecção', temp: 'warm', obs: '', interesses: [], interacoes: [], createdAt: hojeISO() };
      const resp = await proximoResponsavel().catch(() => null); // rodízio entre corretores (se ligado)
      if (resp) { c.responsavelId = resp.id; c.responsavelNome = resp.nome; }
      lista.unshift(c);
    }
    if (tel && !c.celular) c.celular = tel;
    if (out.nome_cliente && /^(Contato WhatsApp|Contato Instagram|Contato Messenger|@)/.test(c.nome)) { c.nome = out.nome_cliente.trim(); c.avatar = c.nome.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2); }
    const iAtual = ETAPAS.indexOf(c.stage), iNova = ETAPAS.indexOf(out.etapa_funil);
    if (iNova > iAtual && iNova <= 3) c.stage = out.etapa_funil; // só avança, nunca volta; Pós-venda fica com você
    if (TEMP[out.temperatura]) c.temp = TEMP[out.temperatura];
    c.obs = (String(c.obs || '').split('[WhatsApp]')[0].trim() + '\n\n' + bloco).trim();
    c.perfilWhatsApp = Object.assign({}, c.perfilWhatsApp || {}, Object.fromEntries(Object.entries(p).filter(([, v]) => v && String(v).trim())));
    if (out.maturidade && out.maturidade !== 'indefinido') c.maturidade = out.maturidade;
    clienteId = c.id; nomeFinal = c.nome;
    return lista;
  });
  if (!conv.cliente_id || conv.cliente_id !== clienteId) await sql.query('UPDATE wa_conversas SET cliente_id = $2 WHERE wa_id = $1', [waId, clienteId]);
  const eventos = [];
  if (novo) eventos.push({ id: 'int' + rid(), tipo: canal === 'whatsapp' ? 'WhatsApp' : NOME_CANAL[canal].split(' ')[0], data: hojeISO(), hora: agoraHM(), desc: 'Primeiro contato pelo ' + NOME_CANAL[canal] + ' (assistente virtual). ' + (out.resumo || ''), imovelId: '', clienteId, cliente: nomeFinal, autor: 'Helena' });
  if (out.transferir) eventos.push({ id: 'int' + rid(), tipo: 'Nota interna', data: hojeISO(), hora: agoraHM(), desc: '🔔 Assistente passou o atendimento para você: ' + (MOTIVOS[out.motivo_transferencia] || MOTIVOS.outro) + '. ' + (out.resumo || '') + (out.maturidade && out.maturidade !== 'indefinido' ? '\nMaturidade: ' + ({ pronto: '🟢 pronto para comprar', morno: '🟡 morno', frio: '🔴 frio' }[out.maturidade] || out.maturidade) : '') + (perfilTxt ? '\n' + perfilTxt : ''), imovelId: '', clienteId, cliente: nomeFinal });
  if (eventos.length) await atualizarDoc('timeline', (t) => eventos.concat(Array.isArray(t) ? t : []));
  // aviso no WhatsApp pessoal do Édipo: contato novo ou atendimento passado para ele
  if (novo || out.transferir) await avisarHelena({ clienteId, nome: nomeFinal, canal: NOME_CANAL[canal], telefone: tel, resumo: out.resumo, motivo: out.transferir ? (MOTIVOS[out.motivo_transferencia] || MOTIVOS.outro) : '', ficha: out.transferir ? [out.maturidade && out.maturidade !== 'indefinido' ? 'Maturidade: ' + ({ pronto: '🟢 pronto', morno: '🟡 morno', frio: '🔴 frio' }[out.maturidade] || out.maturidade) : '', perfilTxt.replace(/ · /g, '\n')].filter(Boolean).join('\n') : '' }).catch(() => null);
}

// ── Fluxo principal ────────────────────────────────────────────────────
export async function processarConversa(waId, site, nomePerfil) {
  await ensureSchema();
  // espera o cliente terminar de digitar (mensagens em sequência viram uma resposta só)
  await new Promise((r) => setTimeout(r, 4000));
  const ult = await sql.query("SELECT id FROM wa_mensagens WHERE wa_id = $1 ORDER BY id DESC LIMIT 1", [waId]);
  const ultCli = await sql.query("SELECT id FROM wa_mensagens WHERE wa_id = $1 AND papel = 'cliente' ORDER BY id DESC LIMIT 1", [waId]);
  if (!ult[0] || !ultCli[0] || ult[0].id !== ultCli[0].id) return; // outra mensagem chegou ou já foi respondida
  const meu = ultCli[0].id;

  const cfg = await lerConfig();
  cfg._canal = canalDe(waId);
  const conv = (await sql.query('SELECT * FROM wa_conversas WHERE wa_id = $1', [waId]))[0] || {};
  if (cfg._canal !== 'whatsapp' && cfg.canaisMeta === false) return; // Helena desligada no Instagram/Messenger
  if (cfg.ativo === false || conv.pausado) return;

  const enviadas = await sql.query("SELECT count(*)::int n FROM wa_mensagens WHERE wa_id = $1 AND papel = 'assistente' AND criado_em > now() - interval '1 hour'", [waId]);
  if (enviadas[0].n >= 30) {
    await sql.query("UPDATE wa_conversas SET pausado = true, aguardando = true, motivo = 'Muitas mensagens em 1 hora: assistente pausado por segurança' WHERE wa_id = $1", [waId]);
    return;
  }

  const msgs = (await sql.query('SELECT papel, texto FROM wa_mensagens WHERE wa_id = $1 ORDER BY id DESC LIMIT 40', [waId])).reverse();
  let out;
  try {
    cfg._ficha = await fichaCliente(waId, conv);
    out = await pensar(cfg, await catalogo(site), montarHistorico(msgs));
  } catch (e) {
    console.error('IA falhou', e);
    await sql.query("UPDATE wa_conversas SET pausado = true, aguardando = true, motivo = $2 WHERE wa_id = $1", [waId, 'O assistente não conseguiu responder (' + String(e.message).slice(0, 120) + '). Responda você.']);
    return;
  }
  // se chegou mensagem nova enquanto a IA pensava, deixa a próxima rodada responder
  const novo = await sql.query("SELECT id FROM wa_mensagens WHERE wa_id = $1 AND papel = 'cliente' ORDER BY id DESC LIMIT 1", [waId]);
  if (novo[0].id !== meu) return;
  const pausa = (await sql.query('SELECT pausado FROM wa_conversas WHERE wa_id = $1', [waId]))[0];
  if (pausa && pausa.pausado) return; // você assumiu enquanto a IA pensava

  const wamid = await enviarTexto(waId, out.resposta);
  await salvarMensagem(waId, 'assistente', out.resposta, wamid);
  if (out.transferir) {
    await sql.query('UPDATE wa_conversas SET pausado = true, aguardando = true, motivo = $2 WHERE wa_id = $1',
      [waId, MOTIVOS[out.motivo_transferencia] || MOTIVOS.outro]);
    try { await avisarEdipo(cfg, { nome: out.nome_cliente || nomePerfil || '', telefone: cfg._canal === 'whatsapp' ? telefoneBR(waId) : ((out.telefone_cliente || 'sem telefone') + ' · via ' + NOME_CANAL[cfg._canal]), motivo: MOTIVOS[out.motivo_transferencia] || MOTIVOS.outro, resumo: out.resumo || '' }); }
    catch (e) { console.error('Aviso ao Édipo falhou', e); }
  }
  // Instagram/Messenger nem sempre informam o nome do perfil: usa o nome que o cliente disse à Helena
  if (out.nome_cliente && String(out.nome_cliente).trim()) {
    try { await sql.query('UPDATE wa_conversas SET nome = $2 WHERE wa_id = $1 AND (nome IS NULL OR nome = \'\')', [waId, String(out.nome_cliente).trim().slice(0, 80)]); } catch (e) { /* não é crítico */ }
  }
  try { await sincronizarCRM(waId, conv, out, nomePerfil); } catch (e) { console.error('CRM falhou', e); }
}

// ── Aviso no WhatsApp pessoal do Édipo ────────────────────────────────
// Mensagem livre só é entregue se esse número tiver escrito para a Holy nas últimas 24h;
// fora disso a Meta exige um modelo aprovado (aviso_lead).
export const MODELO_AVISO = 'aviso_lead';
const limpar = (t, n) => String(t || '-').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, n) || '-';
export async function avisarEdipo(cfg, d) {
  const para = String(process.env.WHATSAPP_AVISO_PARA || cfg.avisoNumero || '').replace(/\D/g, '');
  if (para.length < 12) return { enviado: false, motivo: 'Número para avisos não configurado.' };
  const p = [limpar(d.nome || 'Cliente', 60), limpar(d.telefone, 30), limpar(d.motivo, 80), limpar(d.resumo, 300)];
  try {
    await postar({ to: para, type: 'template', template: { name: MODELO_AVISO, language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: p.map((t) => ({ type: 'text', text: t })) }] } });
    return { enviado: true, via: 'modelo' };
  } catch (e) {
    // modelo ainda não aprovado: tenta mensagem livre (funciona dentro da janela de 24h)
    await postar({ to: para, type: 'text', text: { body: `🔔 Novo atendimento passado pela Helena\n\nCliente: ${p[0]}\nWhatsApp: ${p[1]}\nMotivo: ${p[2]}\nResumo: ${p[3]}\n\nResponda pelo WhatsApp da Holy.` } });
    return { enviado: true, via: 'texto', aviso: 'Modelo ainda não aprovado; enviado como mensagem comum.' };
  }
}
export async function criarModeloAviso() {
  if (!process.env.KAPSO_API_KEY) throw new Error('A criação automática do modelo funciona com a Kapso. Falta KAPSO_API_KEY.');
  const r0 = await fetch(KAPSO_PLAT + '/whatsapp/phone_numbers', { headers: { 'X-API-Key': process.env.KAPSO_API_KEY } });
  const j0 = await r0.json().catch(() => ({}));
  const num = (Array.isArray(j0.data) ? j0.data : []).find((x) => String(x.status || '').toUpperCase() === 'CONNECTED') || (j0.data || [])[0];
  if (!num || !num.business_account_id) throw new Error('Nenhum número conectado na Kapso ainda. Crie o modelo depois da conexão.');
  const waba = num.business_account_id;
  const h = { 'X-API-Key': process.env.KAPSO_API_KEY, 'Content-Type': 'application/json' };
  const lst = await fetch(`${KAPSO_META}/${waba}/message_templates?name=${MODELO_AVISO}`, { headers: h }).then((r) => r.json()).catch(() => ({}));
  const ja = (Array.isArray(lst.data) ? lst.data : []).find((t) => t.name === MODELO_AVISO);
  if (ja) return { status: ja.status, existente: true };
  const r = await fetch(`${KAPSO_META}/${waba}/message_templates`, { method: 'POST', headers: h, body: JSON.stringify({
    name: MODELO_AVISO, category: 'UTILITY', language: 'pt_BR',
    components: [{ type: 'BODY', text: 'Novo atendimento passado pela Helena: {{1}}, WhatsApp {{2}}. Motivo: {{3}}. Resumo: {{4}}. Responda pelo WhatsApp da Holy.',
      example: { body_text: [['Maria Silva', '(49) 99999-0000', 'Quer agendar uma visita', 'Busca apartamento de 3 suítes em Itapema para morar']] } }],
  }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('A Meta recusou o modelo: ' + ((j.error && (j.error.message || j.error)) || JSON.stringify(j).slice(0, 200)));
  return { status: j.status || 'PENDING', existente: false };
}

// ── Retomada: quem parou de responder recebe UMA mensagem de valor, ainda dentro da janela de 24h ──
// Roda quando chega mensagem, quando o CRM abre Conversas e 1x por dia (cron). Nunca repete para o mesmo silêncio.
let _ultimaVarredura = 0;
export async function retomadas(site, forcar) {
  if (!forcar && Date.now() - _ultimaVarredura < 10 * 60000) return { feitas: 0, pulou: true };
  _ultimaVarredura = Date.now();
  await ensureSchema();
  await sql.query('ALTER TABLE wa_conversas ADD COLUMN IF NOT EXISTS retomada_em TIMESTAMPTZ');
  const cfg = await lerConfig();
  if (cfg.ativo === false || cfg.retomada === false) return { feitas: 0 };
  const horas = Math.min(Math.max(+cfg.retomadaHoras || 4, 1), 20);
  const cands = await sql.query(`SELECT c.wa_id, c.nome, c.cliente_id FROM wa_conversas c
      WHERE c.pausado = false AND c.ultima_cliente IS NOT NULL
        AND c.ultima_cliente > now() - interval '22 hours'
        AND c.ultima_msg < now() - ($1 || ' hours')::interval
        AND (c.retomada_em IS NULL OR c.retomada_em < c.ultima_cliente)
        AND (SELECT papel FROM wa_mensagens m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) = 'assistente'
        AND (SELECT count(*) FROM wa_mensagens m WHERE m.wa_id = c.wa_id AND m.papel = 'cliente') >= 1
      ORDER BY c.ultima_msg LIMIT 5`, [String(horas)]);
  let feitas = 0;
  for (const c of cands) {
    try {
      if (canalDe(c.wa_id) !== 'whatsapp' && cfg.canaisMeta === false) continue;
      if (canalDe(c.wa_id) === 'whatsapp' && !whatsappConfigurado()) continue;
      // marca antes de enviar: se algo falhar, não tenta de novo para este silêncio
      const marc = await sql.query('UPDATE wa_conversas SET retomada_em = now() WHERE wa_id = $1 AND (retomada_em IS NULL OR retomada_em < ultima_cliente) RETURNING wa_id', [c.wa_id]);
      if (!marc.length) continue;
      const msgs = (await sql.query('SELECT papel, texto FROM wa_mensagens WHERE wa_id = $1 ORDER BY id DESC LIMIT 40', [c.wa_id])).reverse();
      const hist = montarHistorico(msgs.concat([{ papel: 'cliente', texto: '[Aviso interno do sistema, não é o cliente: ele não responde há algumas horas. Envie agora a mensagem de retomada.]' }]));
      const c2 = Object.assign({}, cfg, { _canal: canalDe(c.wa_id), _retomada: true, _ficha: await fichaCliente(c.wa_id, c) });
      const out = await pensar(c2, await catalogo(site), hist);
      const wamid = await enviarTexto(c.wa_id, out.resposta);
      await salvarMensagem(c.wa_id, 'assistente', out.resposta, wamid);
      feitas++;
    } catch (e) { console.error('retomada falhou', c.wa_id, e && e.message); }
  }
  return { feitas };
}
