// Conversas do WhatsApp para o CRM (só com X-Admin-Key)
import { sql, ensureSchema, cors, isAdmin, body, ok, err, fail } from './_lib.js';
import { enviarTexto, salvarMensagem, whatsappConfigurado, lerConfig, pensar, catalogo, montarHistorico } from './_wa.js';
export const maxDuration = 60;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!isAdmin(req)) return err(res, 401, 'Senha do CRM inválida.');
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const q = req.query || {};
    if (req.method === 'GET') {
      if (q.wa_id) {
        const msgs = (await sql.query('SELECT id, papel, texto, criado_em FROM wa_mensagens WHERE wa_id = $1 ORDER BY id DESC LIMIT 300', [String(q.wa_id)])).reverse();
        const conv = (await sql.query('SELECT * FROM wa_conversas WHERE wa_id = $1', [String(q.wa_id)]))[0] || null;
        return ok(res, { conversa: conv, mensagens: msgs });
      }
      const lista = await sql.query(`SELECT c.*, (SELECT texto FROM wa_mensagens m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS ultimo_texto,
          (SELECT papel FROM wa_mensagens m WHERE m.wa_id = c.wa_id ORDER BY id DESC LIMIT 1) AS ultimo_papel
          FROM wa_conversas c ORDER BY ultima_msg DESC LIMIT 300`);
      const cfg = await lerConfig();
      return ok(res, { conversas: lista, whatsapp: whatsappConfigurado(), assistente_ativo: cfg.ativo !== false,
        webhook: process.env.WHATSAPP_VERIFY_TOKEN ? 'configurado' : 'falta WHATSAPP_VERIFY_TOKEN' });
    }
    const b = body(req);
    if (req.method === 'PATCH') {
      if (!b.wa_id) return err(res, 400, 'Informe wa_id.');
      await sql.query('UPDATE wa_conversas SET pausado = $2, aguardando = CASE WHEN $2 THEN aguardando ELSE false END, motivo = CASE WHEN $2 THEN COALESCE($3, motivo) ELSE NULL END WHERE wa_id = $1',
        [String(b.wa_id), !!b.pausado, b.motivo || (b.pausado ? 'Pausado por você no CRM' : null)]);
      if (b.lido) await sql.query('UPDATE wa_conversas SET aguardando = false WHERE wa_id = $1', [String(b.wa_id)]);
      return ok(res);
    }
    if (req.method === 'POST') {
      // Testar o assistente sem WhatsApp (simulador do CRM)
      if (b.acao === 'simular') {
        const hist = (Array.isArray(b.historico) ? b.historico : []).slice(-30).map((m) => ({ papel: m.papel === 'cliente' ? 'cliente' : 'assistente', texto: String(m.texto || '').slice(0, 2000) }));
        if (!hist.length || hist[hist.length - 1].papel !== 'cliente') return err(res, 400, 'Escreva uma mensagem como cliente.');
        const cfg = Object.assign(await lerConfig(), b.config || {});
        const site = process.env.SITE_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host));
        const out = await pensar(cfg, await catalogo(site), montarHistorico(hist));
        return ok(res, { saida: out });
      }
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
      const conv = (await sql.query('SELECT ultima_cliente FROM wa_conversas WHERE wa_id = $1', [String(b.wa_id)]))[0];
      if (!conv || !conv.ultima_cliente || Date.now() - new Date(conv.ultima_cliente).getTime() > 24 * 3600 * 1000) {
        return err(res, 400, 'Já se passaram 24 horas desde a última mensagem do cliente. Pelas regras do WhatsApp, responda pelo app do celular ou espere ele escrever.');
      }
      const wamid = await enviarTexto(String(b.wa_id), String(b.texto).trim());
      await salvarMensagem(String(b.wa_id), 'humano', String(b.texto).trim(), wamid);
      await sql.query("UPDATE wa_conversas SET pausado = true, aguardando = false, motivo = 'Você assumiu pelo CRM' WHERE wa_id = $1", [String(b.wa_id)]);
      return ok(res);
    }
    return err(res, 405, 'Método não permitido.');
  } catch (e) { return fail(res, e); }
}
