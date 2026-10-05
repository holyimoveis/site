// Webhook do WhatsApp: recebe as mensagens dos clientes e aciona o assistente.
// Endereço para cadastrar na Meta/360dialog: https://SEU-SITE/api/whatsapp?k=WHATSAPP_VERIFY_TOKEN
import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { sql, ensureSchema, fail } from './_lib.js';
import { salvarMensagem, processarConversa, marcarLida, perfilMeta } from './_wa.js';

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
  if (!kapsoOk(req, bruto) && !assinaturaOk(req, bruto) && !chaveOk(req)) return res.status(401).json({ ok: false });
  let body; try { body = JSON.parse(bruto || '{}'); } catch { return res.status(400).json({ ok: false }); }

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
            const id = await salvarMensagem(pre + cli, 'humano', textoMeta(m) || '[mensagem]', m.mid);
            if (id) await sql.query("UPDATE wa_conversas SET pausado = true, aguardando = false, motivo = 'Você assumiu pelo app' WHERE wa_id = $1", [pre + cli]);
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
  if (tarefas.length) waitUntil(Promise.allSettled(tarefas));
  return res.status(200).json({ ok: true });
}
