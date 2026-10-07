// Conversas do WhatsApp para o CRM (só com X-Admin-Key)
import { sql, ensureSchema, cors, body, ok, err, fail } from './_lib.js';
import { sessao, pode, ehDoUsuario } from './_auth.js';
import { enviarTexto, salvarMensagem, whatsappConfigurado, provedor, conectarWebhookKapso, lerConfig, pensar, catalogo, montarHistorico, avisarEdipo, criarModeloAviso } from './_wa.js';
export const maxDuration = 60;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const s = await sessao(req);
    if (!s) return err(res, 401, 'Senha do CRM inválida.');
    if (!pode(s, 'conversas')) return err(res, 403, 'Seu perfil não tem acesso às conversas.');
    const q = req.query || {};
    // Corretor: só as conversas dos clientes que são dele
    let meus = null;
    if (s.perfil === 'corretor') {
      const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'clientes'");
      meus = new Set((Array.isArray(r[0] && r[0].valor) ? r[0].valor : []).filter((c) => ehDoUsuario(c, s.uid)).map((c) => c.id));
    }
    const permitida = async (waId) => {
      if (!meus) return true;
      const c = (await sql.query('SELECT cliente_id FROM wa_conversas WHERE wa_id = $1', [String(waId)]))[0];
      return !!(c && c.cliente_id && meus.has(c.cliente_id));
    };
    if (req.method === 'GET') {
      // Métricas para o Dashboard de leads: tempo de resposta da Helena e da equipe, por canal
      if (q.metricas) {
        const dias = Math.min(Math.max(parseInt(q.dias, 10) || 30, 1), 3650);
        const rows = await sql.query(`SELECT m.wa_id, c.cliente_id, c.pausado,
            min(m.criado_em) FILTER (WHERE m.papel = 'cliente') AS c1,
            min(m.criado_em) FILTER (WHERE m.papel = 'assistente') AS a1,
            min(m.criado_em) FILTER (WHERE m.papel = 'humano') AS h1,
            count(*) FILTER (WHERE m.papel = 'cliente')::int AS nc
          FROM wa_mensagens m LEFT JOIN wa_conversas c ON c.wa_id = m.wa_id
          WHERE m.wa_id IN (SELECT wa_id FROM wa_mensagens WHERE papel = 'cliente' GROUP BY wa_id HAVING min(criado_em) > now() - ($1 || ' days')::interval)
          GROUP BY m.wa_id, c.cliente_id, c.pausado`, [String(dias)]);
        const lista = meus ? rows.filter((r) => r.cliente_id && meus.has(r.cliente_id)) : rows;
        const canal = (id) => (String(id).startsWith('ig:') ? 'Instagram' : String(id).startsWith('fb:') ? 'Messenger' : 'WhatsApp');
        const seg = (a, b) => (a && b && new Date(b) > new Date(a) ? (new Date(b) - new Date(a)) / 1000 : null);
        const media = (v) => { const x = v.filter((n) => n != null); return x.length ? Math.round(x.reduce((s, n) => s + n, 0) / x.length) : null; };
        const porCanal = {};
        for (const r of lista) {
          const k = canal(r.wa_id); const o = porCanal[k] || (porCanal[k] = { conversas: 0, soHelena: 0, comEquipe: 0 });
          o.conversas++; if (r.h1) o.comEquipe++; else if (r.a1) o.soHelena++;
        }
        return ok(res, { dias, conversas: lista.length, porCanal,
          respostaHelena: media(lista.map((r) => seg(r.c1, r.a1))),
          respostaEquipe: media(lista.map((r) => seg(r.c1, r.h1))),
          soHelena: lista.filter((r) => r.a1 && !r.h1).length,
          comEquipe: lista.filter((r) => r.h1).length });
      }
      if (q.wa_id) {
        if (!(await permitida(q.wa_id))) return err(res, 403, 'Esta conversa não é de um cliente seu.');
        const msgs = (await sql.query('SELECT id, papel, texto, criado_em FROM wa_mensagens WHERE wa_id = $1 ORDER BY id DESC LIMIT 300', [String(q.wa_id)])).reverse();
        const conv = (await sql.query('SELECT * FROM wa_conversas WHERE wa_id = $1', [String(q.wa_id)]))[0] || null;
        return ok(res, { conversa: conv, mensagens: msgs });
      }
      const lista = await sql.query(`SELECT c.*, (SELECT texto FROM wa_mensagens m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS ultimo_texto,
          (SELECT papel FROM wa_mensagens m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS ultimo_papel
          FROM wa_conversas c ORDER BY ultima_msg DESC LIMIT 300`);
      const cfg = await lerConfig();
      return ok(res, { conversas: meus ? lista.filter((c) => c.cliente_id && meus.has(c.cliente_id)) : lista, whatsapp: whatsappConfigurado(), provedor: provedor(), assistente_ativo: cfg.ativo !== false,
        webhook: process.env.WHATSAPP_VERIFY_TOKEN ? 'configurado' : 'falta WHATSAPP_VERIFY_TOKEN' });
    }
    const b = body(req);
    if (req.method === 'PATCH') {
      if (!b.wa_id) return err(res, 400, 'Informe wa_id.');
      if (!(await permitida(b.wa_id))) return err(res, 403, 'Esta conversa não é de um cliente seu.');
      await sql.query('UPDATE wa_conversas SET pausado = $2, aguardando = CASE WHEN $2 THEN aguardando ELSE false END, motivo = CASE WHEN $2 THEN COALESCE($3, motivo) ELSE NULL END WHERE wa_id = $1',
        [String(b.wa_id), !!b.pausado, b.motivo || (b.pausado ? 'Pausado por você no CRM' : null)]);
      if (b.lido) await sql.query('UPDATE wa_conversas SET aguardando = false WHERE wa_id = $1', [String(b.wa_id)]);
      return ok(res);
    }
    if (req.method === 'POST') {
      if (['simular', 'modeloAviso', 'testarAviso', 'webhook', 'webhook360'].includes(b.acao) && !pode(s, 'helena.config')) return err(res, 403, 'Só o administrador configura a Helena.');
      // Testar o assistente sem WhatsApp (simulador do CRM)
      if (b.acao === 'simular') {
        const hist = (Array.isArray(b.historico) ? b.historico : []).slice(-30).map((m) => ({ papel: m.papel === 'cliente' ? 'cliente' : 'assistente', texto: String(m.texto || '').slice(0, 2000) }));
        if (!hist.length || hist[hist.length - 1].papel !== 'cliente') return err(res, 400, 'Escreva uma mensagem como cliente.');
        const cfg = Object.assign(await lerConfig(), b.config || {});
        const site = process.env.SITE_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host));
        const out = await pensar(cfg, await catalogo(site), montarHistorico(hist));
        return ok(res, { saida: out });
      }
      // Modelo de aviso (Meta) e teste do aviso no WhatsApp pessoal
      if (b.acao === 'modeloAviso') {
        try { return ok(res, await criarModeloAviso()); } catch (e) { return err(res, 400, e.message); }
      }
      if (b.acao === 'testarAviso') {
        if (!whatsappConfigurado()) return err(res, 400, 'O WhatsApp da Holy ainda não está conectado.');
        try {
          const r = await avisarEdipo(Object.assign(await lerConfig(), b.config || {}), { nome: 'Cliente de teste', telefone: '(49) 99999-0000', motivo: 'Teste do aviso', resumo: 'Este é um teste do aviso da Helena.' });
          return r.enviado ? ok(res, r) : err(res, 400, r.motivo);
        } catch (e) { return err(res, 502, e.message); }
      }
      // Conectar o webhook (Kapso ou 360dialog, conforme a chave cadastrada)
      if (b.acao === 'webhook' && process.env.KAPSO_API_KEY) {
        if ((process.env.WHATSAPP_VERIFY_TOKEN || '').length < 12) return err(res, 400, 'Falta WHATSAPP_VERIFY_TOKEN (mínimo 12 letras e números) na Vercel.');
        const url = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host) + '/api/whatsapp';
        try { const id = await conectarWebhookKapso(url, process.env.WHATSAPP_VERIFY_TOKEN); return ok(res, { url, numero: id, provedor: 'Kapso' }); }
        catch (e) { return err(res, 502, e.message); }
      }
      if (b.acao === 'webhook') b.acao = 'webhook360';
      // Configurar o webhook no parceiro 360dialog
      if (b.acao === 'webhook360') {
        if (!process.env.WHATSAPP_D360_KEY) return err(res, 400, 'Falta WHATSAPP_D360_KEY na Vercel.');
        if (!process.env.WHATSAPP_VERIFY_TOKEN) return err(res, 400, 'Falta WHATSAPP_VERIFY_TOKEN na Vercel.');
        const url = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host) + '/api/whatsapp?k=' + encodeURIComponent(process.env.WHATSAPP_VERIFY_TOKEN);
        const r = await fetch('https://waba-v2.360dialog.io/v1/configs/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'D360-API-KEY': process.env.WHATSAPP_D360_KEY }, body: JSON.stringify({ url }) });
        const j = await r.json().catch(() => ({}));
        return r.ok ? ok(res, { url: url.replace(/k=.*/, 'k=•••') }) : err(res, 502, '360dialog recusou: ' + JSON.stringify(j).slice(0, 200));
      }
      // Enviar mensagem sua pelo CRM
      if (!b.wa_id || !String(b.texto || '').trim()) return err(res, 400, 'Informe wa_id e texto.');
      if (!(await permitida(b.wa_id))) return err(res, 403, 'Esta conversa não é de um cliente seu.');
      const conv = (await sql.query('SELECT ultima_cliente FROM wa_conversas WHERE wa_id = $1', [String(b.wa_id)]))[0];
      if (!conv || !conv.ultima_cliente || Date.now() - new Date(conv.ultima_cliente).getTime() > 24 * 3600 * 1000) {
        return err(res, 400, 'Já se passaram 24 horas desde a última mensagem do cliente. Pelas regras do WhatsApp, responda pelo app do celular ou espere ele escrever.');
      }
      const wamid = await enviarTexto(String(b.wa_id), String(b.texto).trim());
      await salvarMensagem(String(b.wa_id), 'humano', String(b.texto).trim(), wamid);
      await sql.query("UPDATE wa_conversas SET pausado = true, aguardando = false, motivo = $2 WHERE wa_id = $1", [String(b.wa_id), (s.mestre ? 'Você' : s.nome) + ' assumiu pelo CRM']);
      return ok(res);
    }
    return err(res, 405, 'Método não permitido.');
  } catch (e) { return fail(res, e); }
}
