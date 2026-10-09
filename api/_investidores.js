// Investidores: a mesma oferta para muitos, com cada mensagem personalizada pela IA (nome, cidades, perfil).
// Usado por /api/crm (acao 'investPersonalizar'). Arquivo com "_" (não conta no limite de funções).
import { sql } from './_lib.js';
import { paraSite as imSite } from './imoveis.js';
import { paraSite as emSite } from './empreendimentos.js';
import { enviarOferta } from './_email.js';

const arr = (v) => (Array.isArray(v) ? v : []);
const primeiro = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const brl = (v) => (v ? 'R$ ' + Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : '');

export async function carregarItem(ref) {
  if (!ref || !ref.id) return null;
  const chave = ref.kind === 'em' ? 'empreendimentos' : 'imoveis';
  const r = await sql.query('SELECT valor FROM crm_docs WHERE chave = $1', [chave]);
  const bruto = arr(r[0] && r[0].valor).find((x) => x && String(x.id) === String(ref.id));
  if (!bruto) return null;
  return { item: ref.kind === 'em' ? emSite(bruto) : imSite(bruto), kind: ref.kind === 'em' ? 'em' : 'im' };
}
const resumo = (kind, it) => !it ? '' : kind === 'im'
  ? [it.nome, it.tipo + (it.bairro ? ' no ' + it.bairro : '') + (it.cidade ? ', ' + it.cidade : ''), it.quartos ? it.quartos + ' quartos' : '', it.areaPrivativa || it.area ? (it.areaPrivativa || it.area) + ' m²' : '', it.valor ? brl(it.valor) : ''].filter(Boolean).join(' · ')
  : [it.nome, it.cidade, it.tipoLabel, it.preco, (it.diferenciais || []).slice(0, 4).join(', ')].filter(Boolean).join(' · ');

function fatosCliente(c) {
  const i = c.investidor || {}, p = c.perfilWhatsApp || {};
  return [
    'Primeiro nome: ' + (primeiro(c.nome) || '(sem nome)'),
    i.cidades || p.cidades ? 'Cidades de interesse: ' + (i.cidades || p.cidades) : '',
    i.tipos && i.tipos.length ? 'Tipo de investimento que prefere: ' + arr(i.tipos).join(', ') : '',
    i.objetivo || p.objetivo ? 'Objetivo: ' + (i.objetivo || p.objetivo) : '',
    i.faixa || p.faixa_valor ? 'Faixa de investimento: ' + (i.faixa || p.faixa_valor) : '',
    p.interesse_em ? 'Já demonstrou interesse em: ' + p.interesse_em : '',
    i.obs ? 'Observação do corretor: ' + String(i.obs).slice(0, 300) : '',
  ].filter(Boolean).join('\n');
}

async function personalizarUm(c, oferta, itemTxt, canal, eu) {
  const key = process.env.ANTHROPIC_API_KEY;
  const pn = primeiro(c.nome);
  const reserva = canal === 'email'
    ? { assunto: (pn ? pn + ', ' : '') + 'uma oportunidade para você', paragrafos: [(pn ? 'Oi, ' + pn + '! ' : 'Oi! ') + oferta] }
    : { texto: (pn ? 'Oi, ' + pn + '! ' : 'Oi! ') + oferta };
  if (!key) return reserva;
  const forma = canal === 'email'
    ? 'Responda só com JSON: {"assunto": "até 60 caracteres, sem emoji", "previa": "até 90 caracteres", "paragrafos": ["...", "..."]} — corpo com no máximo 130 palavras, sem assinatura e sem links.'
    : canal === 'ligacao'
      ? 'Responda só com JSON: {"texto": "roteiro curto para o corretor ligar: abertura com o nome, 2 ou 3 pontos da oferta ligados ao perfil do cliente e uma pergunta de fechamento; até 500 caracteres"}'
      : 'Responda só com JSON: {"texto": "mensagem de WhatsApp de até 600 caracteres, tom de conversa, pode usar *negrito* com moderação, termina com uma pergunta simples, sem link"}';
  const prompt = `Você é ${eu}, corretor, e vai enviar a MESMA oferta para vários investidores. Personalize a oferta abaixo para este cliente.
Regras: mantenha exatamente o mesmo produto, valores, condições e prazos da oferta; chame pelo primeiro nome; acrescente no máximo uma frase que conecte a oferta ao perfil do cliente, usando SOMENTE os fatos dele abaixo (se não houver fatos relevantes, não invente: apenas personalize o cumprimento); português do Brasil, natural e sem exageros.
Produto: ${itemTxt || '(ver oferta)'}
Oferta (texto base do corretor): ${oferta}
Fatos do cliente:
${fatosCliente(c)}
${forma}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(25000),
    });
    const d = await r.json();
    const t = (d.content || []).map((x) => x.text || '').join('');
    const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    if (canal === 'email') return j.assunto && Array.isArray(j.paragrafos) && j.paragrafos.length ? { assunto: String(j.assunto).slice(0, 80), previa: String(j.previa || '').slice(0, 120), paragrafos: j.paragrafos.map(String).slice(0, 5) } : reserva;
    return j.texto ? { texto: String(j.texto).slice(0, 1200) } : reserva;
  } catch (e) { return reserva; }
}

// clientes = já filtrados pela permissão de quem chama; ate 6 por chamada (cabe no limite de tempo)
export async function personalizarLote({ clientes, oferta, itemRef, canal, enviar, eu, rotulo }) {
  const it = await carregarItem(itemRef);
  const itemTxt = it ? resumo(it.kind, it.item) : '';
  const lote = clientes.slice(0, 6);
  return Promise.all(lote.map(async (c) => {
    const msg = await personalizarUm(c, oferta, itemTxt, canal, eu);
    const out = { id: c.id, nome: c.nome, ...msg };
    if (canal === 'email' && enviar) {
      const r = await enviarOferta(c, msg, it && it.item, it && it.kind, rotulo).catch((e) => ({ ok: false, erro: e.message }));
      out.enviado = !!r.ok; if (!r.ok) out.erro = r.erro;
    }
    return out;
  }));
}
