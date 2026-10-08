// Leva os contatos do site e da Meta (tabela leads) para Clientes, com rodízio, e avisa o Édipo no WhatsApp pessoal.
// Usado pelo CRM (/api/crm), pelo formulário do site (/api/leads) e pelo webhook de leads da Meta (/api/whatsapp).
import { sql, atualizarDoc } from './_lib.js';
import { proximoResponsavel } from './_auth.js';
import { avisarLead } from './_avisos.js';

const arr = (v) => (Array.isArray(v) ? v : []);
// ── Contatos do site e da Meta -> Clientes (no servidor, com rodízio) ──
const dig = (v) => String(v || '').replace(/\D/g, '');
const rid = () => Math.random().toString(36).slice(2, 9);
// Respostas do formulário do anúncio -> perfil de qualificação (o mesmo que a Helena preenche)
function perfilDoFormulario(msg) {
  const p = {};
  String(msg || '').split(' | ').forEach((par) => {
    const i = par.indexOf('?'); if (i < 0) return;
    const q = par.slice(0, i).toLowerCase(), r = par.slice(i + 1).trim(); if (!r) return;
    if (/objetivo|finalidade/.test(q)) p.objetivo = r;
    else if (/prazo|quando/.test(q)) p.prazo = r;
    else if (/pagamento|pretende realizar|como pretende|forma de/.test(q)) p.pagamento = r;
    else if (/faixa|investimento|valor|or[cç]amento/.test(q)) p.faixa_valor = r;
    else if (/entrada/.test(q)) p.entrada = r;
    else if (/quartos|dormit/.test(q)) p.quartos = r;
  });
  return p;
}
export async function sincronizarLeads() {
  const leads = await sql.query(`SELECT * FROM leads WHERE tipo = 'formulario' AND sincronizado = false ORDER BY criado_em ASC LIMIT 100`);
  if (!leads.length) return { novos: 0, nomes: [] };
  let tl = [], nomes = [], avisos = [];
  await atualizarDoc('clientes', async (lista) => {
    lista = arr(lista); tl = []; nomes = []; avisos = [];
    for (const l of leads) {
      const tel = dig(l.telefone), mail = String(l.email || '').toLowerCase();
      const deMeta = /^Meta/.test(l.origem || '');
      const u = l.utm || {};
      const deGoogle = !deMeta && (!!(u.gclid || u.gbraid || u.wbraid) || /google/i.test(u.utm_source || ''));
      const campUtm = u.utm_campaign ? ' · campanha ' + u.utm_campaign : '';
      const camp = deMeta ? String(l.origem).replace(/^Meta Ads:?\s*/, '').trim() : '';
      const contato = [l.telefone ? 'Tel: ' + l.telefone : '', l.email ? 'E-mail: ' + l.email : ''].filter(Boolean).join(' · ');
      const desc = (contato ? contato + ' | ' : '') + (deMeta
        ? 'Lead de anúncio na Meta' + (camp ? ' · ' + camp : '') + (l.imovel && l.imovel !== camp ? ' | Imóvel: ' + l.imovel : '') + (l.mensagem ? ' | Respostas: ' + l.mensagem : '')
        : 'Contato pelo site' + (deGoogle ? ' (Google Ads' + campUtm + ')' : u.utm_source ? ' (' + u.utm_source + campUtm + ')' : '') + (l.interesse ? ' | Interesse: ' + l.interesse : '') + (l.imovel ? ' | Imóvel: ' + l.imovel : '') + (l.mensagem ? ' | "' + l.mensagem + '"' : ''));
      let c = lista.find((x) => (tel.length >= 8 && dig(x.celular || x.tel).slice(-8) === tel.slice(-8)) || (mail && String(x.email || '').toLowerCase() === mail));
      if (!c) {
        const nome = l.nome || 'Lead do site';
        const r = await proximoResponsavel();
        c = { id: 'cl' + rid(), nome, avatar: nome.trim().split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2), email: l.email || '', celular: l.telefone || '', tel: '', cpf: '', nascimento: '', profissao: '', empresa: '', renda: 0, patrimonioEst: 0,
          origem: deMeta ? 'Meta Ads' : deGoogle ? 'Google Ads' : 'Site', stage: 'Prospecção', ...(l.visitante ? { visitante: l.visitante } : {}), ...(l.utm ? { utm: l.utm } : {}), temp: 'warm', obs: desc, interesses: [], interacoes: [], createdAt: String(l.criado_em ? new Date(l.criado_em).toISOString() : new Date().toISOString()).slice(0, 10), leadSite: l.id,
          ...(r ? { responsavelId: r.id, responsavelNome: r.nome } : {}) };
        lista.unshift(c);
        nomes.push(nome);
        avisos.push({ nome, telefone: l.telefone, email: l.email, origem: deMeta ? 'Anúncio Meta' + (camp ? ' · ' + camp : '') : deGoogle ? 'Google Ads' : 'Site', imovel: l.imovel || '', respostas: deMeta ? l.mensagem : [l.interesse, l.mensagem].filter(Boolean).join(' · '), responsavel: c.responsavelNome || '', clienteId: c.id });
      } else if (l.visitante && !c.visitante) { c.visitante = l.visitante; }
      if (deMeta && l.mensagem) { const pf = perfilDoFormulario(l.mensagem); if (Object.keys(pf).length) c.perfilWhatsApp = Object.assign({}, pf, c.perfilWhatsApp || {}); }
      if (l.visitante) await sql.query('UPDATE site_eventos SET cliente_id = $1 WHERE visitante = $2 AND cliente_id IS NULL', [c.id, l.visitante]).catch(() => null);
      const d = l.criado_em ? new Date(l.criado_em) : new Date();
      tl.push({ id: 'int' + rid(), tipo: 'Nota interna', data: d.toISOString().slice(0, 10), hora: d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }), desc: desc + (c.responsavelNome ? ' · Responsável: ' + c.responsavelNome : ''), imovelId: '', clienteId: c.id, cliente: c.nome, autor: 'Sistema' });
    }
    return lista;
  });
  await atualizarDoc('timeline', (t) => tl.concat(arr(t)));
  await sql.query('UPDATE leads SET sincronizado = true, atualizado_em = now() WHERE id = ANY($1::bigint[])', [leads.map((l) => l.id)]);
  for (const a of avisos) await avisarLead(a);
  return { novos: leads.length, nomes };
}

