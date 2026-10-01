// Motor do assistente de WhatsApp da Holy
// Funciona com a API oficial direto da Meta ou via parceiro oficial 360dialog (necessário para Coexistência).
import { sql, ensureSchema, atualizarDoc } from './_lib.js';
import { paraSite as imovelSite } from './imoveis.js';
import { paraSite as emprSite } from './empreendimentos.js';

const ETAPAS = ['Prospecção', 'Qualificação', 'Proposta', 'Negociação', 'Pós-venda'];
const TEMP = { frio: 'cold', morno: 'warm', quente: 'hot' };
const MOTIVOS = {
  pediu_visita: 'Pediu para agendar visita',
  pediu_humano: 'Pediu para falar com uma pessoa',
  negociacao: 'Quer negociar ou fazer proposta',
  lead_quente: 'Lead quente: orçamento e prazo definidos',
  outro: 'Precisa de você',
};

export const PADRAO_CONFIG = {
  ativo: true,
  nomeAssistente: 'Assistente virtual da Holy',
  tom: 'Próximo, educado e direto, como um corretor experiente conversando no WhatsApp. Frases curtas, linguagem simples, sem exagerar nos emojis (no máximo um por mensagem). Trata o cliente pelo primeiro nome quando souber.',
  infoHoly: 'Holy Curadoria Imobiliária: curadoria de imóveis de alto padrão em Santa Catarina, com atuação em Chapecó, Balneário Camboriú, Itapema e Porto Belo. O corretor responsável é o Édipo Junior.',
  regras: '',
};

// ── Envio ──────────────────────────────────────────────────────────────
function destino() {
  if (process.env.WHATSAPP_D360_KEY) {
    return { url: 'https://waba-v2.360dialog.io/messages', headers: { 'D360-API-KEY': process.env.WHATSAPP_D360_KEY } };
  }
  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) {
    const v = process.env.WHATSAPP_API_VERSION || 'v23.0';
    return { url: `https://graph.facebook.com/${v}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN } };
  }
  return null;
}
export const whatsappConfigurado = () => !!destino();

async function postar(payload) {
  const d = destino();
  if (!d) throw new Error('WhatsApp não configurado (faltam as chaves na Vercel).');
  const r = await fetch(d.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...d.headers }, body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('WhatsApp recusou: ' + (j.error && (j.error.message || j.error.title) || r.status));
  return j;
}
export async function enviarTexto(waId, texto) {
  const partes = [];
  let t = String(texto || '').trim();
  while (t.length > 3800) { const i = t.lastIndexOf('\n', 3800) > 1000 ? t.lastIndexOf('\n', 3800) : 3800; partes.push(t.slice(0, i)); t = t.slice(i).trim(); }
  if (t) partes.push(t);
  let ultimo = null;
  for (const p of partes) ultimo = await postar({ recipient_type: 'individual', to: waId, type: 'text', text: { body: p, preview_url: true } });
  return ultimo && ultimo.messages && ultimo.messages[0] ? ultimo.messages[0].id : null;
}
export async function marcarLida(wamid) {
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
    + (i.area ? ` | ${i.area} m²` : '') + (i.quartos ? ` | ${i.quartos} dorm.` : '') + (i.suites ? ` | ${i.suites} suítes` : '') + (i.vagas ? ` | ${i.vagas} vagas` : '')
    + ` | ${i.finalidade === 'Locação' ? 'Aluguel' : 'Venda'}: ${brl(i.valor)}`
    + (i.diferenciais.length ? ' | ' + i.diferenciais.slice(0, 6).join(', ') : '')
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
      resposta: { type: 'string', description: 'Mensagem de WhatsApp para o cliente, em português do Brasil.' },
      nome_cliente: { type: 'string', description: 'Nome do cliente, se ele informou. Vazio se não souber.' },
      perfil: {
        type: 'object',
        properties: {
          objetivo: { type: 'string', description: 'morar, investir, temporada, vender etc.' },
          cidades: { type: 'string' }, tipo_imovel: { type: 'string' }, faixa_valor: { type: 'string' },
          quartos: { type: 'string' }, prazo: { type: 'string' }, pagamento: { type: 'string', description: 'à vista, financiamento, permuta…' },
          interesse_em: { type: 'string', description: 'imóveis/empreendimentos do catálogo que despertaram interesse' },
        },
      },
      temperatura: { type: 'string', enum: ['frio', 'morno', 'quente'] },
      etapa_funil: { type: 'string', enum: ETAPAS },
      transferir: { type: 'boolean', description: 'true para passar a conversa ao Édipo agora.' },
      motivo_transferencia: { type: 'string', enum: Object.keys(MOTIVOS) },
      resumo: { type: 'string', description: 'Resumo de 1 a 2 frases do cliente e do que ele busca, para o corretor.' },
    },
    required: ['resposta', 'temperatura', 'etapa_funil', 'transferir', 'resumo'],
  },
};

function prompt(cfg, cat) {
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  return `Você é o ${cfg.nomeAssistente}, que atende pelo WhatsApp da Holy Curadoria Imobiliária. Hoje é ${hoje}.

IDENTIDADE
- Você é um assistente virtual. Diga isso de forma natural na primeira resposta da conversa e sempre que perguntarem. Nunca afirme ser o Édipo ou uma pessoa.
- Você escreve no tom do Édipo, mas fala em nome da Holy.

TOM
${cfg.tom}

SOBRE A HOLY
${cfg.infoHoly}
Se o cliente perguntar algo sobre a Holy que não esteja escrito aqui, diga que vai confirmar com o Édipo. Não invente.

OBJETIVO
Entender o que o cliente procura e apresentar opções reais do catálogo. Qualifique com naturalidade, UMA pergunta por mensagem, sem parecer formulário: objetivo (morar, investir, temporada), cidade, tipo de imóvel, faixa de valor, quartos, prazo e forma de pagamento.
Quando houver opções compatíveis, apresente no máximo 3, com 1 linha cada e o link da página. Se nada combinar, diga que a Holy faz curadoria sob medida e que o Édipo pode buscar opções fora do site.

CATÁLOGO (só existe o que está abaixo; nunca invente imóveis, valores, metragens, prazos ou condições)
${cat}

REGRAS
- Não prometa aprovação de financiamento, descontos, condições de pagamento ou datas que não estejam no catálogo.
- Nunca informe endereço exato, número do apartamento, nem dados de proprietários. Fale de bairro e cidade.
- Para negociação de valor, proposta ou condição especial: não negocie; transfira para o Édipo.
- Assuntos sem relação com imóveis e com a Holy: responda com gentileza que você ajuda apenas com imóveis da Holy.
- Se o cliente mandar áudio, foto ou arquivo, diga que por aqui você só consegue ler texto e peça para ele escrever; se for importante, ofereça passar para o Édipo.
${cfg.regras ? '- ' + String(cfg.regras).split('\n').filter(Boolean).join('\n- ') : ''}

QUANDO PASSAR PARA O ÉDIPO (transferir = true)
- pediu_visita: quer agendar ou fazer uma visita.
- pediu_humano: pediu para falar com uma pessoa, com o corretor ou com o Édipo.
- negociacao: quer negociar valor, fazer proposta, permuta ou condição especial.
- lead_quente: já informou faixa de valor E prazo, e demonstrou interesse claro em comprar.
Ao transferir, avise com naturalidade que o Édipo vai continuar o atendimento por aqui mesmo, em breve. Não faça mais perguntas nessa mensagem.

FORMATO
Mensagens curtas de WhatsApp (até 4 ou 5 linhas). Sem títulos, tabelas ou markdown; pode usar *negrito* do WhatsApp com moderação. Links sempre completos.
Use SEMPRE a ferramenta "responder".`;
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

export async function pensar(cfg, cat, historico) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Sem ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 900,
      system: prompt(cfg, cat), messages: historico,
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
  const tel = telefoneBR(waId), fim8 = String(waId).replace(/\D/g, '').slice(-8);
  const p = out.perfil || {};
  const perfilTxt = [['Objetivo', p.objetivo], ['Cidades', p.cidades], ['Tipo', p.tipo_imovel], ['Faixa de valor', p.faixa_valor], ['Quartos', p.quartos], ['Prazo', p.prazo], ['Pagamento', p.pagamento], ['Interesse', p.interesse_em]]
    .filter((x) => x[1]).map((x) => x[0] + ': ' + x[1]).join(' · ');
  const bloco = '[WhatsApp] ' + (out.resumo || '') + (perfilTxt ? '\n' + perfilTxt : '');
  let clienteId = conv.cliente_id, novo = false, nomeFinal = '';
  await atualizarDoc('clientes', (lista) => {
    lista = Array.isArray(lista) ? lista : [];
    let c = lista.find((x) => x.id === clienteId) || lista.find((x) => String(x.celular || x.tel || '').replace(/\D/g, '').slice(-8) === fim8);
    if (!c) {
      novo = true;
      const nome = (out.nome_cliente || nomePerfil || 'Contato WhatsApp ' + tel.slice(-4)).trim();
      c = { id: 'cl' + rid(), nome, avatar: nome.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2), email: '', celular: tel, tel: '', cpf: '', nascimento: '', profissao: '', empresa: '', renda: 0, patrimonioEst: 0, origem: 'WhatsApp', stage: 'Prospecção', temp: 'warm', obs: '', interesses: [], interacoes: [], createdAt: hojeISO() };
      lista.unshift(c);
    }
    if (out.nome_cliente && /^Contato WhatsApp/.test(c.nome)) { c.nome = out.nome_cliente.trim(); c.avatar = c.nome.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2); }
    const iAtual = ETAPAS.indexOf(c.stage), iNova = ETAPAS.indexOf(out.etapa_funil);
    if (iNova > iAtual && iNova <= 3) c.stage = out.etapa_funil; // só avança, nunca volta; Pós-venda fica com você
    if (TEMP[out.temperatura]) c.temp = TEMP[out.temperatura];
    c.obs = (String(c.obs || '').split('[WhatsApp]')[0].trim() + '\n\n' + bloco).trim();
    c.perfilWhatsApp = p;
    clienteId = c.id; nomeFinal = c.nome;
    return lista;
  });
  if (!conv.cliente_id || conv.cliente_id !== clienteId) await sql.query('UPDATE wa_conversas SET cliente_id = $2 WHERE wa_id = $1', [waId, clienteId]);
  const eventos = [];
  if (novo) eventos.push({ id: 'int' + rid(), tipo: 'WhatsApp', data: hojeISO(), hora: agoraHM(), desc: 'Primeiro contato pelo WhatsApp (assistente virtual). ' + (out.resumo || ''), imovelId: '', clienteId, cliente: nomeFinal });
  if (out.transferir) eventos.push({ id: 'int' + rid(), tipo: 'Nota interna', data: hojeISO(), hora: agoraHM(), desc: '🔔 Assistente passou o atendimento para você: ' + (MOTIVOS[out.motivo_transferencia] || MOTIVOS.outro) + '. ' + (out.resumo || ''), imovelId: '', clienteId, cliente: nomeFinal });
  if (eventos.length) await atualizarDoc('timeline', (t) => eventos.concat(Array.isArray(t) ? t : []));
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
  const conv = (await sql.query('SELECT * FROM wa_conversas WHERE wa_id = $1', [waId]))[0] || {};
  if (cfg.ativo === false || conv.pausado) return;

  const enviadas = await sql.query("SELECT count(*)::int n FROM wa_mensagens WHERE wa_id = $1 AND papel = 'assistente' AND criado_em > now() - interval '1 hour'", [waId]);
  if (enviadas[0].n >= 30) {
    await sql.query("UPDATE wa_conversas SET pausado = true, aguardando = true, motivo = 'Muitas mensagens em 1 hora: assistente pausado por segurança' WHERE wa_id = $1", [waId]);
    return;
  }

  const msgs = (await sql.query('SELECT papel, texto FROM wa_mensagens WHERE wa_id = $1 ORDER BY id DESC LIMIT 40', [waId])).reverse();
  let out;
  try {
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
  }
  try { await sincronizarCRM(waId, conv, out, nomePerfil); } catch (e) { console.error('CRM falhou', e); }
}
