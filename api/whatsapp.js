// Webhook do WhatsApp, Instagram e Messenger: recebe as mensagens dos clientes e aciona a Helena.
// Cada chegada fica registrada (últimas 30) para o Diagnóstico em Conversas, e aparece nos Logs da Vercel como [webhook].
// Endereço para cadastrar na Meta/360dialog: https://SEU-SITE/api/whatsapp?k=WHATSAPP_VERIFY_TOKEN
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { sql, ensureSchema, fail } from './_lib.js';
import { salvarMensagem, processarConversa, marcarLida, perfilMeta, retomadas } from './_wa.js';
import { puxarLeads } from './meta.js';
import { sincronizarLeads } from './_sync.js';

// Lead de formulário da Meta chegou: busca na hora, leva para Clientes e avisa no WhatsApp pessoal
async function leadNaHora(formIds) {
  try {
    let item = {};
    try {
      const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'campanhas'");
      (Array.isArray(r[0] && r[0].valor) ? r[0].valor : []).forEach((c) => { if (c && c.formulario) item[String(c.formulario)] = c.itemNome; });
    } catch (e) {}
    const novos = await puxarLeads(formIds.map((id) => ({ id, item: item[String(id)] })));
    if (novos) await sincronizarLeads();
  } catch (e) { console.error('[leadgen]', e.message); }
}

export const maxDuration = 60;

async function corpoBruto(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  const partes = [];
  for await (const c of req) partes.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(partes).toString('utf8');
}
function assinaturaOk(req, bruto) {
  const sig = String(req.headers['x-hub-signature-256'] || '');
  if (!sig.startsWith('sha256=')) return false;
  // WHATSAPP_APP_SECRET (app do WhatsApp) ou META_APP_SECRET (app Holy CRM: Instagram e Messenger)
  return [process.env.WHATSAPP_APP_SECRET, process.env.META_APP_SECRET].filter(Boolean).some((segredo) => {
    const esperado = 'sha256=' + crypto.createHmac('sha256', segredo).update(bruto, 'utf8').digest('hex');
    return esperado.length === sig.length && crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(sig));
  });
}
// Diário do webhook: guarda as últimas 30 chegadas (sem o texto das mensagens) para o Diagnóstico do CRM
async function registrar(item) {
  const reg = { em: new Date().toISOString(), ...item };
  console.log('[webhook]', JSON.stringify(reg));
  try {
    await ensureSchema();
    await sql.query(`INSERT INTO crm_docs (chave, valor, versao) VALUES ('webhook_log', jsonb_build_array($1::jsonb), 1)
      ON CONFLICT (chave) DO UPDATE SET atualizado_em = now(), valor = (
        SELECT COALESCE(jsonb_agg(t.x ORDER BY t.n), '[]'::jsonb)
        FROM jsonb_array_elements(jsonb_build_array($1::jsonb) || CASE WHEN jsonb_typeof(crm_docs.valor) = 'array' THEN crm_docs.valor ELSE '[]'::jsonb END) WITH ORDINALITY AS t(x, n)
        WHERE t.n <= 30)`, [JSON.stringify(reg)]);
  } catch (e) { console.error('[webhook] não consegui registrar', e && e.message); }
}
// O que veio numa entrega (para o diário): tipo de evento por entrada, sem conteúdo
function resumoEntrega(body) {
  const ev = [];
  for (const entry of body.entry || []) {
    for (const e of entry.messaging || []) ev.push(e.message ? (e.message.is_echo ? 'eco' : 'mensagem') : e.read ? 'leitura' : e.delivery ? 'entrega' : e.postback ? 'botão' : e.reaction ? 'reação' : 'outro');
    for (const e of entry.standby || []) ev.push(e.message ? (e.message.is_echo ? 'standby-eco' : 'standby-mensagem') : 'standby-outro');
    for (const c of entry.changes || []) ev.push('changes:' + c.field);
  }
  return ev;
}
// Eco de mensagem enviada pela conta da Holy (Instagram nem sempre informa o app que enviou).
// Espera a Helena gravar o que enviou; se o eco for dela, ignora. Se não, foi você pelo app -> Helena pausa.
async function tratarEco(conv, m) {
  await new Promise((r) => setTimeout(r, 3500));
  const texto = String(textoMeta(m) || '').trim();
  if (m.mid && (await sql.query('SELECT 1 FROM wa_mensagens WHERE wamid = $1', [m.mid])).length) return;
  if (texto) {
    const recentes = await sql.query("SELECT texto FROM wa_mensagens WHERE wa_id = $1 AND papel = 'assistente' AND criado_em > now() - interval '5 minutes' ORDER BY id DESC LIMIT 5", [conv]);
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    if (recentes.some((r) => norm(r.texto).includes(norm(texto)))) return; // era a própria Helena (resposta em partes)
  }
  const id = await salvarMensagem(conv, 'humano', texto || '[mensagem]', m.mid);
  if (id) await sql.query("UPDATE wa_conversas SET pausado = true, aguardando = false, motivo = 'Você assumiu pelo app' WHERE wa_id = $1", [conv]);
}
// Instagram e Messenger: texto de uma mensagem direta
function textoMeta(m) {
  if (!m) return null;
  if (m.text) return m.text;
  const a = (m.attachments || [])[0];
  if (!a) return m.is_deleted ? null : '[mensagem não suportada]';
  return { image: '[o cliente enviou uma foto]', video: '[o cliente enviou um vídeo]', audio: '[o cliente enviou um áudio]', file: '[o cliente enviou um arquivo]', share: '[o cliente compartilhou uma publicação]', story_mention: '[o cliente mencionou a Holy em um story]', ig_reel: '[o cliente compartilhou um reels]', reel: '[o cliente compartilhou um reels]' }[a.type] || '[o cliente enviou um anexo]';
}
// Kapso assina cada entrega: HMAC-SHA256 do corpo, em hex, no cabeçalho X-Webhook-Signature
function kapsoOk(req, bruto) {
  const segredo = process.env.WHATSAPP_VERIFY_TOKEN || '';
  const sig = String(req.headers['x-webhook-signature'] || '');
  if (segredo.length < 12 || !sig) return false;
  const esperado = crypto.createHmac('sha256', segredo).update(bruto, 'utf8').digest('hex');
  return esperado.length === sig.length && crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(sig));
}
function chaveOk(req) {
  const t = process.env.WHATSAPP_VERIFY_TOKEN || '';
  const k = String((req.query || {}).k || '');
  return t.length >= 12 && k.length === t.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(t));
}
function textoDe(m) {
  switch (m.type) {
    case 'text': return m.text && m.text.body;
    case 'button': return m.button && m.button.text;
    case 'interactive': { const i = m.interactive || {}; return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || '[resposta interativa]'; }
    case 'audio': return '[o cliente enviou um áudio]';
    case 'image': return '[o cliente enviou uma foto]' + (m.image && m.image.caption ? ' Legenda: ' + m.image.caption : '');
    case 'video': return '[o cliente enviou um vídeo]';
    case 'document': return '[o cliente enviou um arquivo]';
    case 'sticker': return '[figurinha]';
    case 'location': return `[localização enviada: ${m.location && m.location.latitude}, ${m.location && m.location.longitude}]`;
    case 'contacts': return '[o cliente enviou um contato]';
    case 'reaction': return null;
    default: return '[mensagem não suportada]';
  }
}

export default async function handler(req, res) {
  const q = req.query || {};
  // 1) Verificação do webhook pela Meta
  if (req.method === 'GET') {
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && q['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return res.status(200).send(String(q['hub.challenge'] || ''));
    }
    return res.status(403).send('forbidden');
  }
  if (req.method !== 'POST') return res.status(405).end();

  const bruto = await corpoBruto(req);
  if (!kapsoOk(req, bruto) && !assinaturaOk(req, bruto) && !chaveOk(req)) {
    let obj = ''; try { obj = JSON.parse(bruto || '{}').object || ''; } catch {}
    const temSig = !!req.headers['x-hub-signature-256'];
    await registrar({ status: 401, object: obj, motivo: temSig ? 'assinatura não confere: META_APP_SECRET na Vercel diferente da Chave Secreta do app (ou faltou Redeploy)' : 'chegou sem assinatura', tamanho: bruto.length });
    return res.status(401).json({ ok: false });
  }
  let body; try { body = JSON.parse(bruto || '{}'); } catch { await registrar({ status: 400, motivo: 'corpo não é JSON', tamanho: bruto.length }); return res.status(400).json({ ok: false }); }
  if (body.object === 'instagram' || body.object === 'page') await registrar({ status: 200, object: body.object, eventos: resumoEntrega(body) });

  const site = process.env.SITE_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host));
  const tarefas = [];
  try {
    await ensureSchema();
    // Instagram (object = instagram) e Messenger (object = page): mensagens diretas para a Holy
    if (body.object === 'instagram' || body.object === 'page') {
      const pre = body.object === 'instagram' ? 'ig:' : 'fb:';
      const nossoApp = String(process.env.META_APP_ID || '1110281681853167'); // app Holy CRM
      for (const entry of body.entry || []) {
        const proprio = String(entry.id || '');
        for (const ev of entry.messaging || []) {
          const m = ev.message; if (!m) continue;
          if (m.is_echo) {
            // mensagem enviada pela própria Holy: se não foi este sistema, foi você pelo app/Business Suite -> Helena pausa
            const cli = ev.recipient && ev.recipient.id; if (!cli) continue;
            if (nossoApp && String(m.app_id || '') === nossoApp) continue;
            tarefas.push(tratarEco(pre + cli, m));
            continue;
          }
          const de = ev.sender && ev.sender.id;
          if (!de || de === proprio) continue;
          const texto = textoMeta(m); if (!texto) continue;
          const conv = pre + de;
          const nome = await perfilMeta(conv);
          const id = await salvarMensagem(conv, 'cliente', texto, m.mid, nome);
          if (id) tarefas.push(processarConversa(conv, site, nome));
        }
      }
    }
    // Leads dos formulários instantâneos (campo leadgen da Página)
    if (body.object === 'page') {
      const forms = [...new Set((body.entry || []).flatMap((e) => (e.changes || []).filter((c) => c.field === 'leadgen' && c.value && c.value.form_id).map((c) => String(c.value.form_id))))];
      if (forms.length) tarefas.push(leadNaHora(forms));
    }
    for (const entry of body.entry || []) {
      for (const ch of entry.changes || []) {
        const v = ch.value || {};
        // Mensagens dos clientes
        if (ch.field === 'messages' && Array.isArray(v.messages)) {
          const perfil = {}; (v.contacts || []).forEach((c) => { perfil[c.wa_id] = c.profile && c.profile.name; });
          for (const m of v.messages) {
            const texto = textoDe(m);
            const de = m.from || m.from_user_id;
            if (!texto || !de) continue;
            const id = await salvarMensagem(de, 'cliente', texto, m.id, perfil[de] || m.username);
            if (id) {
              tarefas.push(marcarLida(m.id));
              tarefas.push(processarConversa(de, site, perfil[de] || m.username));
            }
          }
        }
        // Coexistência: mensagens que VOCÊ enviou pelo app do celular
        if (ch.field === 'smb_message_echoes' && Array.isArray(v.message_echoes)) {
          for (const m of v.message_echoes) {
            const texto = textoDe(m); if (!texto || !m.to) continue;
            const id = await salvarMensagem(m.to, 'humano', texto, m.id);
            if (id) await sql.query("UPDATE wa_conversas SET pausado = true, aguardando = false, motivo = 'Você assumiu pelo celular' WHERE wa_id = $1", [m.to]);
          }
        }
      }
    }
  } catch (e) { return fail(res, e); }
  // responde rápido para a Meta e continua o trabalho em segundo plano
  tarefas.push(retomadas(site).catch(() => null));
  waitUntil(Promise.allSettled(tarefas));
  return res.status(200).json({ ok: true });
}
