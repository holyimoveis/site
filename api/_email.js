// E-mails automáticos para leads: boas-vindas na hora e uma sequência leve, com conteúdo do interesse de cada um.
// Envio pelo Resend (gratuito até 3 mil e-mails/mês). Na Vercel: RESEND_API_KEY, EMAIL_REMETENTE
// (ex.: "Édipo | Holy Imóveis <edipo@holyimoveis.com>", domínio verificado no Resend) e EMAIL_RESPOSTA
// (para onde vão as respostas do cliente). Liga e desliga em CRM > Configurações (site_config.emailAuto).
// Regras saudáveis: no máximo 1 e-mail a cada 2 dias, para quando o cliente avança no funil, quando o corretor pausa
// ou quando o cliente se descadastra (link em todo e-mail, LGPD). Depois de 6 etapas, só manda novidades reais 1x por mês.
import crypto from 'node:crypto';
import { sql, ensureSchema, atualizarDoc } from './_lib.js';
import { assinarToken, lerTokenTipo } from './_contato.js';
import { esquemaLinks } from './_links.js';
import { paraSite as imSite } from './imoveis.js';
import { paraSite as emSite } from './empreendimentos.js';
import { slug } from './_seo.js';

const SITE = () => process.env.SITE_URL || 'https://www.holyimoveis.com';
const WA_PADRAO = '5549988454873';
const arr = (v) => (Array.isArray(v) ? v : []);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => (v ? 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '');
const primeiro = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '')) && !/@(meta|fb|facebook)\.com$/i.test(String(e));

// dias depois do cadastro em que cada etapa sai (a 0 sai na hora)
export const ETAPAS = [
  { dia: 0, tipo: 'boas_vindas', nome: 'Boas-vindas' },
  { dia: 2, tipo: 'imovel', nome: 'O imóvel em detalhe' },
  { dia: 5, tipo: 'guia', nome: 'Guia da forma de pagamento' },
  { dia: 9, tipo: 'opcoes', nome: 'Outras opções compatíveis' },
  { dia: 16, tipo: 'convite', nome: 'Convite pessoal' },
  { dia: 30, tipo: 'novidades', nome: 'Novidades do mês' },
];
const MAX_DIAS = 180;
const ESTAGIOS_PARAM = ['Proposta', 'Negociação', 'Pós-venda'];

let pronto = false;
export async function esquemaEmail() {
  if (pronto) return;
  await ensureSchema();
  await sql.query(`CREATE TABLE IF NOT EXISTS email_seq (
    cliente_id TEXT PRIMARY KEY, email TEXT NOT NULL, nome TEXT, item TEXT, etapa INT NOT NULL DEFAULT 0,
    proximo_em TIMESTAMPTZ, ativo BOOLEAN NOT NULL DEFAULT true, motivo TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await sql.query(`CREATE TABLE IF NOT EXISTS email_envios (
    id BIGSERIAL PRIMARY KEY, cliente_id TEXT, etapa INT, assunto TEXT, para TEXT, provedor_id TEXT, status TEXT,
    erro TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await sql.query('CREATE INDEX IF NOT EXISTS email_seq_prox ON email_seq (proximo_em) WHERE ativo');
  pronto = true;
}

export function emailConfigurado() {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_REMETENTE);
}
async function doc(chave) {
  const r = await sql.query('SELECT valor FROM crm_docs WHERE chave = $1', [chave]);
  return r[0] ? r[0].valor : null;
}
async function config() {
  const sc = (await doc('site_config')) || {};
  const e = sc.emailAuto || {};
  return {
    ativo: e.ativo === true,
    assinatura: String(e.assinatura || 'Édipo Junior\nHoly Curadoria Imobiliária'),
    whatsapp: String(e.whatsapp || WA_PADRAO).replace(/\D/g, '') || WA_PADRAO,
    apresentacao: String(e.apresentacao || ''),
  };
}

// ── Envio ──────────────────────────────────────────────────────────────
export async function enviarEmail({ para, assunto, html, texto, sairUrl }) {
  if (!emailConfigurado()) return { ok: false, erro: 'e-mail não configurado na Vercel' };
  const corpo = { from: process.env.EMAIL_REMETENTE, to: [para], subject: assunto, html, text: texto };
  if (process.env.EMAIL_RESPOSTA) corpo.reply_to = process.env.EMAIL_RESPOSTA;
  if (sairUrl) corpo.headers = { 'List-Unsubscribe': `<${sairUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, erro: (j && (j.message || j.name)) || 'HTTP ' + r.status };
    return { ok: true, id: j.id };
  } catch (e) { return { ok: false, erro: e.message }; }
}

// ── Contexto do cliente: imóvel de interesse, perfil e opções compatíveis ──
async function contexto(cli, itemNome) {
  const [ims, ems] = await Promise.all([doc('imoveis'), doc('empreendimentos')]);
  const imPub = arr(ims).filter((i) => i && i.publicarSite === true && i.status === 'Disponível');
  const emPub = arr(ems).filter((e) => e && e.publicarSite !== false);
  const nomeItem = String(itemNome || '').toLowerCase().trim();
  let item = null, kind = 'im';
  if (nomeItem) {
    const im = imPub.find((i) => String(i.nome || '').toLowerCase().trim() === nomeItem) || imPub.find((i) => nomeItem.includes(String(i.nome || '').toLowerCase().slice(0, 20)));
    const em = !im && emPub.find((e) => String(e.nome || '').toLowerCase().trim() === nomeItem);
    if (im) { item = imSite(im); kind = 'im'; } else if (em) { item = emSite(em); kind = 'em'; }
  }
  const p = cli.perfilWhatsApp || {};
  const cidade = item ? String(item.cidade || '').toLowerCase() : '';
  const valorRef = item && item.valor ? item.valor : 0;
  const outros = imPub.map(imSite).filter((i) => !item || i.id !== item.id)
    .map((i) => ({ i, k: 'im', s: (cidade && String(i.cidade).toLowerCase() === cidade ? 2 : 0) + (item && i.tipo === item.tipo ? 1 : 0) + (valorRef && i.valor && Math.abs(i.valor - valorRef) / valorRef < 0.35 ? 2 : 0) }))
    .concat(emPub.map(emSite).filter((e) => !item || e.id !== item.id).map((e) => ({ i: e, k: 'em', s: (cidade && String(e.cidade).toLowerCase() === cidade ? 2 : 0) + 1 })))
    .filter((o) => o.s >= 2).sort((a, b) => b.s - a.s).slice(0, 3);
  return { item, kind, perfil: p, outros };
}
const urlItem = (kind, it) => `${SITE()}/${kind === 'im' ? 'imovel' : 'empreendimento'}/${encodeURIComponent(it.id)}/${slug(it.nome)}`;
const resumoItem = (kind, it) => !it ? '' : kind === 'im'
  ? [it.tipo + (it.bairro ? ' no ' + it.bairro : '') + (it.cidade ? ', ' + it.cidade : ''), it.quartos ? it.quartos + ' quartos' + (it.suites ? ' (' + it.suites + ' suítes)' : '') : '', it.areaPrivativa || it.area ? (it.areaPrivativa || it.area) + ' m²' : '', it.vagas ? it.vagas + ' vagas' : '', it.valor ? brl(it.valor) : ''].filter(Boolean).join(' · ')
  : [it.cidade, it.tipoLabel, it.preco].filter(Boolean).join(' · ');

async function linkRastreado(url, cli, item) {
  await esquemaLinks();
  const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 7);
  await sql.query('INSERT INTO links (code, url, cliente_id, cliente, item, criado_por) VALUES ($1, $2, $3, $4, $5, $6)',
    [code, url, cli.id, String(cli.nome || '').slice(0, 120), String(item || 'E-mail').slice(0, 160), 'E-mail automático']);
  return SITE() + '/l/' + code;
}

// ── Texto com IA (só com os fatos do cadastro; se a IA falhar, usa o texto pronto) ──
const GUIA = (pag) => /financ/i.test(pag) ? 'financiamento: como funcionam entrada, uso do FGTS quando cabe, diferença entre tabela SAC e Price e a importância de simular em mais de um banco — sem citar taxas nem prometer aprovação'
  : /permut/i.test(pag) ? 'permuta: como a Holy avalia o imóvel do cliente sem compromisso, como se estrutura permuta + complemento e quais documentos separar'
  : /vista|pr[oó]prio/i.test(pag) ? 'compra à vista: como negociar bem, quais certidões e documentos conferir antes de assinar e por que a curadoria evita surpresas'
  : 'três cuidados antes de comprar um imóvel: documentação, custos além do preço (ITBI, escritura, registro) e visitar com calma';
async function textoIA(etapa, cli, ctx, cfg) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const e = ETAPAS.at(etapa) || ETAPAS.at(-1);
  const p = ctx.perfil || {};
  const fatos = [
    'Nome do cliente: ' + (primeiro(cli.nome) || '(sem nome)'),
    ctx.item ? 'Imóvel de interesse: ' + ctx.item.nome + ' — ' + resumoItem(ctx.kind, ctx.item) : 'Imóvel de interesse: não identificado',
    ctx.item && ctx.item.diferenciais && ctx.item.diferenciais.length ? 'Diferenciais: ' + ctx.item.diferenciais.slice(0, 8).join(', ') : '',
    ctx.item && ctx.item.lazer && ctx.item.lazer.length ? 'Lazer: ' + ctx.item.lazer.slice(0, 8).join(', ') : '',
    ctx.item && ctx.item.descricao ? 'Descrição do anúncio: ' + String(ctx.item.descricao).slice(0, 900) : '',
    p.objetivo ? 'Objetivo: ' + p.objetivo : '', p.prazo ? 'Prazo: ' + p.prazo : '', p.pagamento ? 'Forma de pagamento: ' + p.pagamento : '',
    cfg.apresentacao ? 'Como o corretor se apresenta: ' + cfg.apresentacao : '',
  ].filter(Boolean).join('\n');
  const objetivo = {
    boas_vindas: 'agradecer o cadastro, dizer em uma frase quem escreve, confirmar o imóvel de interesse e avisar que vai chamar no WhatsApp para enviar as fotos e tirar dúvidas',
    imovel: 'mostrar 2 ou 3 pontos fortes REAIS do imóvel ligados ao objetivo do cliente e convidar para ver todas as fotos ou visitar',
    guia: 'um mini guia útil sobre ' + GUIA(p.pagamento || ''),
    opcoes: ctx.outros.length ? 'dizer que separou outras opções que combinam com a busca, sem descrevê-las em detalhe (os cartões vão abaixo do texto)' : 'perguntar o que é mais importante na busca para a curadoria separar opções sob medida',
    convite: 'uma mensagem curta e pessoal perguntando se a busca ainda faz sentido e oferecendo um horário para conversar ou visitar, sem pressão',
    novidades: 'contar que chegaram novidades na carteira que podem interessar (os cartões vão abaixo do texto) e lembrar que a curadoria segue à disposição',
  }[e.tipo];
  const prompt = `Escreva um e-mail em português do Brasil, em nome do corretor, para um cliente que se cadastrou num anúncio de imóvel.
Objetivo deste e-mail: ${objetivo}.
Regras: tom humano, cordial e consultivo, sem pressão e sem exageros de marketing; no máximo 120 palavras no corpo; use SOMENTE os fatos abaixo (nunca invente metragem, preço, prazo, condição, taxa ou dado de mercado); trate o cliente pelo primeiro nome; não inclua assinatura nem links (eles são acrescentados depois).
Fatos:
${fatos}
Responda só com JSON: {"assunto": "até 60 caracteres, sem emoji", "previa": "até 90 caracteres", "paragrafos": ["...", "..."]}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(25000),
    });
    const d = await r.json();
    const t = (d.content || []).map((c) => c.text || '').join('');
    const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    if (!j.assunto || !Array.isArray(j.paragrafos) || !j.paragrafos.length) return null;
    return { assunto: String(j.assunto).slice(0, 80), previa: String(j.previa || '').slice(0, 120), paragrafos: j.paragrafos.map(String).slice(0, 5) };
  } catch (e) { return null; }
}
function textoPronto(etapa, cli, ctx) {
  const n = primeiro(cli.nome), item = ctx.item ? ctx.item.nome : 'o imóvel que você viu';
  const T = {
    boas_vindas: { assunto: 'Recebemos seu interesse' + (n ? ', ' + n : ''), paragrafos: [`Oi${n ? ', ' + n : ''}! Obrigado pelo seu cadastro em ${item}.`, 'Aqui é da Holy Curadoria Imobiliária. Vou te chamar no WhatsApp para enviar as fotos completas e tirar suas dúvidas, no seu tempo.', 'Enquanto isso, a página do imóvel tem todos os detalhes.'] },
    imovel: { assunto: 'Os detalhes de ' + String(item).slice(0, 40), paragrafos: [`${n ? n + ', ' : ''}separei os principais pontos de ${item} para você ver com calma.`, 'Se quiser conhecer pessoalmente, é só responder este e-mail ou me chamar no WhatsApp.'] },
    guia: { assunto: 'Um guia rápido para a sua compra', paragrafos: [`${n ? n + ', ' : ''}preparei algumas orientações para a sua compra ser tranquila: conferir a documentação, considerar os custos de ITBI, escritura e registro, e visitar com calma.`, 'Se quiser, faço uma simulação para o seu caso.'] },
    opcoes: { assunto: 'Separei outras opções para você', paragrafos: [`${n ? n + ', ' : ''}pela sua busca, separei outras opções que podem combinar com você.`] },
    convite: { assunto: 'Ainda faz sentido para você?', paragrafos: [`${n ? n + ', ' : ''}passando para saber como está sua busca. Se ainda fizer sentido, posso separar um horário para conversarmos ou visitarmos.`] },
    novidades: { assunto: 'Novidades na carteira da Holy', paragrafos: [`${n ? n + ', ' : ''}chegaram novidades que podem combinar com o que você procura.`] },
  };
  return T[(ETAPAS.at(etapa) || ETAPAS.at(-1)).tipo];
}

// ── Montagem do e-mail ─────────────────────────────────────────────────
function montar(t, cli, ctx, cfg, links, sairUrl) {
  const n = primeiro(cli.nome);
  const wa = `https://wa.me/${cfg.whatsapp}?text=${encodeURIComponent('Oi! Recebi o e-mail da Holy' + (ctx.item ? ' sobre ' + ctx.item.nome : '') + ' e quero conversar.')}`;
  const botao = (href, rot, cheio) => `<a href="${esc(href)}" style="display:inline-block;padding:12px 20px;border-radius:8px;font-weight:600;font-size:15px;text-decoration:none;${cheio ? 'background:#2d3a1f;color:#ffffff' : 'background:#ffffff;color:#2d3a1f;border:1px solid #2d3a1f'}">${esc(rot)}</a>`;
  const cartao = (o) => `<tr><td style="padding:10px 0;border-top:1px solid #e6e2d8"><a href="${esc(o.link)}" style="color:#2d3a1f;font-weight:600;text-decoration:none;font-size:15px">${esc(o.i.nome)}</a><div style="color:#6b6f63;font-size:13px">${esc(resumoItem(o.k, o.i))}</div></td></tr>`;
  const cards = links.cards && links.cards.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px">${links.cards.map(cartao).join('')}</table>` : '';
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(t.assunto)}</title></head>
<body style="margin:0;background:#f5f3ee;font-family:Arial,Helvetica,sans-serif;color:#1a1c18">
<div style="display:none;max-height:0;overflow:hidden">${esc(t.previa || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#2d3a1f;padding:18px 24px;color:#d4b86a;font-family:Georgia,serif;font-size:22px;font-weight:bold;letter-spacing:2px">HOLY<span style="display:block;font-family:Arial,sans-serif;font-size:10px;letter-spacing:3px;color:#c9c3b0;font-weight:normal">CURADORIA IMOBILIÁRIA</span></td></tr>
${links.foto ? `<tr><td><img src="${esc(links.foto)}" alt="${esc(ctx.item ? ctx.item.nome : '')}" width="560" style="display:block;width:100%;max-width:560px;height:auto"></td></tr>` : ''}
<tr><td style="padding:24px 24px 8px;font-size:15px;line-height:1.6">
${t.paragrafos.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('')}
${cards}
<p style="margin:18px 0 6px">${links.item ? botao(links.item, ctx.kind === 'im' ? 'Ver o imóvel' : 'Ver o empreendimento', true) + ' &nbsp; ' : ''}${botao(wa, 'Falar no WhatsApp', !links.item)}</p>
<p style="margin:22px 0 0;white-space:pre-line;color:#3d4237">${esc(cfg.assinatura)}</p>
</td></tr>
<tr><td style="padding:18px 24px 22px;font-size:12px;color:#8a8d82;line-height:1.5;border-top:1px solid #eeeae0">Você recebeu este e-mail porque se cadastrou${ctx.item ? ' em ' + esc(ctx.item.nome) : ' em um anúncio da Holy'}. Basta responder para falar comigo.<br><a href="${esc(sairUrl)}" style="color:#8a8d82">Não quero mais receber estes e-mails</a></td></tr>
</table></td></tr></table></body></html>`;
  const texto = [...t.paragrafos, ...(links.cards || []).map((o) => `• ${o.i.nome} — ${resumoItem(o.k, o.i)}: ${o.link}`),
    links.item ? 'Ver: ' + links.item : '', 'WhatsApp: ' + wa, '', cfg.assinatura, '', 'Não quer mais receber? ' + sairUrl].filter((x) => x !== undefined).join('\n');
  return { html, texto };
}

async function nota(cli, desc) {
  const d = new Date();
  const ev = { id: 'int' + Math.random().toString(36).slice(2, 9), tipo: 'Nota interna', data: d.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }),
    hora: d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), desc, imovelId: '', clienteId: cli.id, cliente: cli.nome || '', autor: 'Sistema' };
  await atualizarDoc('timeline', (t) => [ev].concat(arr(t))).catch(() => null);
}

// Envia a etapa atual de um cliente e agenda a próxima. Devolve o que aconteceu.
async function enviarEtapa(seq, cli, cfg, forcar) {
  const etapa = seq.etapa;
  const ctx = await contexto(cli, seq.item);
  const e = ETAPAS.at(Math.min(etapa, ETAPAS.length - 1));
  const sairUrl = SITE() + '/e/sair/' + assinarToken('sair', cli.id, 400);
  // novidades: só manda se houver algo novo de verdade
  let cards = [];
  if (e.tipo === 'opcoes' || e.tipo === 'novidades') {
    for (const o of ctx.outros) cards.push({ ...o, link: await linkRastreado(urlItem(o.k, o.i), cli, o.i.nome) });
    if (e.tipo === 'novidades' && !cards.length && !forcar) return { pulou: 'sem novidades compatíveis' };
  }
  const links = { cards, item: ctx.item ? await linkRastreado(urlItem(ctx.kind, ctx.item), cli, ctx.item.nome) : '', foto: ctx.item && ctx.item.fotos && ctx.item.fotos[0] && ['boas_vindas', 'imovel'].includes(e.tipo) ? ctx.item.fotos[0] : '' };
  const t = (await textoIA(etapa, cli, ctx, cfg)) || textoPronto(etapa, cli, ctx);
  const { html, texto } = montar(t, cli, ctx, cfg, links, sairUrl);
  const r = await enviarEmail({ para: seq.email, assunto: t.assunto, html, texto, sairUrl });
  await sql.query('INSERT INTO email_envios (cliente_id, etapa, assunto, para, provedor_id, status, erro) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [cli.id, etapa, t.assunto, seq.email, r.id || null, r.ok ? 'enviado' : 'erro', r.ok ? null : String(r.erro).slice(0, 300)]);
  if (r.ok) await nota(cli, `📧 E-mail automático (${e.nome}): "${t.assunto}"`);
  return r.ok ? { enviado: t.assunto } : { erro: r.erro };
}
function proximaData(criado, etapa) {
  const e = ETAPAS.at(etapa);
  if (e) return new Date(new Date(criado).getTime() + e.dia * 86400000);
  // depois das 6 etapas: novidades a cada 30 dias, até 180 dias do cadastro
  const d = new Date(Date.now() + 30 * 86400000);
  return d.getTime() - new Date(criado).getTime() > MAX_DIAS * 86400000 ? null : d;
}

// Começa a sequência (boas-vindas na hora). Chamado quando um lead novo entra, ou pelo botão no CRM.
export async function iniciarSequencia(cli, itemNome, opts = {}) {
  if (!cli || !emailOk(cli.email)) return { ok: false, motivo: 'cliente sem e-mail válido' };
  if (!emailConfigurado()) return { ok: false, motivo: 'e-mail não configurado na Vercel' };
  const cfg = await config();
  if (!cfg.ativo && !opts.manual) return { ok: false, motivo: 'e-mails automáticos desligados em Configurações' };
  await esquemaEmail();
  const ja = (await sql.query('SELECT * FROM email_seq WHERE cliente_id = $1', [cli.id]))[0];
  if (ja && (ja.ativo || ja.motivo === 'descadastrou')) return { ok: false, motivo: ja.motivo === 'descadastrou' ? 'cliente se descadastrou' : 'sequência já ativa' };
  await sql.query(`INSERT INTO email_seq (cliente_id, email, nome, item, etapa, proximo_em, ativo, motivo, criado_em) VALUES ($1,$2,$3,$4,0,now(),true,null,now())
    ON CONFLICT (cliente_id) DO UPDATE SET email = EXCLUDED.email, nome = EXCLUDED.nome, item = COALESCE(EXCLUDED.item, email_seq.item), etapa = 0, proximo_em = now(), ativo = true, motivo = null, criado_em = now(), atualizado_em = now()`,
    [cli.id, String(cli.email).trim().toLowerCase(), cli.nome || '', itemNome || null]);
  const seq = (await sql.query('SELECT * FROM email_seq WHERE cliente_id = $1', [cli.id]))[0];
  const r = await enviarEtapa(seq, cli, cfg);
  const prox = proximaData(seq.criado_em, 1);
  await sql.query('UPDATE email_seq SET etapa = 1, proximo_em = $2, atualizado_em = now(), motivo = $3 WHERE cliente_id = $1', [cli.id, prox, r.erro ? 'erro no envio: ' + String(r.erro).slice(0, 120) : null]);
  return { ok: !r.erro, ...r };
}

// Cron diário: envia as etapas vencidas (no máximo 60 por execução)
export async function processarEmails() {
  if (!emailConfigurado()) return { ok: false, motivo: 'não configurado' };
  await esquemaEmail();
  const cfg = await config();
  if (!cfg.ativo) return { ok: false, motivo: 'desligado' };
  const fila = await sql.query('SELECT * FROM email_seq WHERE ativo AND proximo_em <= now() ORDER BY proximo_em LIMIT 60');
  if (!fila.length) return { ok: true, enviados: 0 };
  const clientes = arr(await doc('clientes'));
  let enviados = 0, parados = 0;
  for (const seq of fila) {
    const cli = clientes.find((c) => c && c.id === seq.cliente_id);
    const parar = !cli ? 'cliente removido do CRM' : cli.emailPausado ? 'pausado no CRM' : ESTAGIOS_PARAM.includes(cli.stage) ? 'cliente avançou no funil (' + cli.stage + ')' : !emailOk(cli.email) ? 'sem e-mail' : null;
    if (parar) { await sql.query('UPDATE email_seq SET ativo = false, motivo = $2, atualizado_em = now() WHERE cliente_id = $1', [seq.cliente_id, parar]); parados++; continue; }
    const r = await enviarEtapa({ ...seq, email: String(cli.email).trim().toLowerCase() }, cli, cfg);
    if (r.enviado) enviados++;
    const prox = proximaData(seq.criado_em, seq.etapa + 1);
    await sql.query('UPDATE email_seq SET etapa = etapa + 1, proximo_em = $2, ativo = $3, motivo = $4, atualizado_em = now() WHERE cliente_id = $1',
      [seq.cliente_id, prox, !!prox, !prox ? 'sequência concluída' : r.erro ? 'erro no envio: ' + String(r.erro).slice(0, 120) : null]);
  }
  return { ok: true, enviados, parados };
}

export async function statusCliente(clienteId) {
  await esquemaEmail();
  const seq = (await sql.query('SELECT etapa, proximo_em, ativo, motivo, email FROM email_seq WHERE cliente_id = $1', [clienteId]))[0] || null;
  const envios = await sql.query('SELECT etapa, assunto, status, erro, criado_em FROM email_envios WHERE cliente_id = $1 ORDER BY id DESC LIMIT 10', [clienteId]);
  return { configurado: emailConfigurado(), seq, envios, etapas: ETAPAS.map((e) => e.nome) };
}
export async function pausarSequencia(clienteId, ativo) {
  await esquemaEmail();
  await sql.query('UPDATE email_seq SET ativo = $2, motivo = $3, proximo_em = CASE WHEN $2 THEN GREATEST(proximo_em, now()) ELSE proximo_em END, atualizado_em = now() WHERE cliente_id = $1 AND motivo IS DISTINCT FROM \'descadastrou\'',
    [clienteId, !!ativo, ativo ? null : 'pausado no CRM']);
}

// Link "não quero mais receber" (assinado; vale 400 dias)
export async function descadastrar(token) {
  const id = lerTokenTipo('sair', token);
  if (!id) return false;
  await esquemaEmail();
  const r = await sql.query("UPDATE email_seq SET ativo = false, motivo = 'descadastrou', atualizado_em = now() WHERE cliente_id = $1 RETURNING nome", [id]);
  if (r.length) await nota({ id, nome: r[0].nome }, '🚫 Pediu para não receber mais e-mails automáticos (descadastro).');
  return true;
}

// E-mail de teste para o próprio corretor (mostra exatamente como o cliente recebe)
export async function emailTeste(para, nomeTeste) {
  if (!emailConfigurado()) return { ok: false, erro: 'Falta RESEND_API_KEY e EMAIL_REMETENTE na Vercel (e Redeploy).' };
  const cfg = await config();
  const ims = arr(await doc('imoveis')).filter((i) => i && i.publicarSite === true && i.status === 'Disponível');
  const cli = { id: 'teste', nome: nomeTeste || 'Teste', email: para, perfilWhatsApp: { objetivo: 'Morar', prazo: 'Até 6 meses', pagamento: 'Financiamento' } };
  const ctx = await contexto(cli, ims[0] && ims[0].nome);
  const links = { cards: [], item: ctx.item ? urlItem(ctx.kind, ctx.item) : '', foto: ctx.item && ctx.item.fotos ? ctx.item.fotos[0] : '' };
  const t = (await textoIA(0, cli, ctx, cfg)) || textoPronto(0, cli, ctx);
  const { html, texto } = montar({ ...t, assunto: '[Teste] ' + t.assunto }, cli, ctx, cfg, links, SITE() + '/e/sair/teste');
  return enviarEmail({ para, assunto: '[Teste] ' + t.assunto, html, texto });
}

// ── Oferta em massa (Investidores): um e-mail personalizado por pessoa, mesma oferta ──
// Respeita o descadastro; o link do produto é rastreado por cliente; registra na timeline.
export async function descadastrado(clienteId) {
  await esquemaEmail();
  const r = await sql.query("SELECT 1 FROM email_seq WHERE cliente_id = $1 AND motivo = 'descadastrou'", [clienteId]);
  return r.length > 0;
}
export async function enviarOferta(cli, t, item, kind, rotulo) {
  if (!emailConfigurado()) return { ok: false, erro: 'e-mail não configurado na Vercel' };
  if (!emailOk(cli.email)) return { ok: false, erro: 'sem e-mail válido' };
  if (cli.emailOptOut || await descadastrado(cli.id)) return { ok: false, erro: 'descadastrado' };
  const cfg = await config();
  const ctx = { item, kind, perfil: cli.perfilWhatsApp || {}, outros: [] };
  const sairUrl = SITE() + '/e/sair/' + assinarToken('sair', cli.id, 400);
  const links = { cards: [], item: item ? await linkRastreado(urlItem(kind, item), cli, item.nome) : '', foto: item && item.fotos && item.fotos[0] ? item.fotos[0] : '' };
  const { html, texto } = montar({ assunto: t.assunto, previa: t.previa || '', paragrafos: t.paragrafos }, cli, ctx, cfg, links, sairUrl);
  const r = await enviarEmail({ para: String(cli.email).trim().toLowerCase(), assunto: t.assunto, html, texto, sairUrl });
  await esquemaEmail();
  await sql.query('INSERT INTO email_envios (cliente_id, etapa, assunto, para, provedor_id, status, erro) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [cli.id, -1, t.assunto, cli.email, r.id || null, r.ok ? 'enviado' : 'erro', r.ok ? null : String(r.erro).slice(0, 300)]);
  if (r.ok) await nota(cli, `📧 Oferta${rotulo ? ' (' + rotulo + ')' : ''} por e-mail: "${t.assunto}"`);
  return r;
}
