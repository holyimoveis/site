// Links rastreados (/l/CODIGO): saber quando o cliente abriu a página do imóvel que você mandou.
// Arquivo com "_" (não conta no limite de 12 funções da Vercel).
import { sql, ensureSchema, atualizarDoc } from './_lib.js';

let pronto = false;
export async function esquemaLinks() {
  if (pronto) return;
  await ensureSchema();
  await sql.query(`CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY, url TEXT NOT NULL, cliente_id TEXT, cliente TEXT, item TEXT, criado_por TEXT,
      aberturas INT NOT NULL DEFAULT 0, ultima TIMESTAMPTZ, criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
  pronto = true;
}

// Robôs que abrem o link só para montar a prévia (WhatsApp, Facebook, Telegram…) não contam como abertura
const ROBO = /whatsapp|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|linkedinbot|discordbot|skypeuripreview|googlebot|bingbot|bot\b|crawler|spider|preview/i;

export async function abrirLink(code, req) {
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) return null;
  await esquemaLinks();
  const r = (await sql.query('SELECT * FROM links WHERE code = $1', [code]))[0];
  if (!r) return null;
  const ua = String(req.headers['user-agent'] || '');
  if (!ROBO.test(ua)) {
    const ant = r.ultima ? new Date(r.ultima).getTime() : 0;
    await sql.query('UPDATE links SET aberturas = aberturas + 1, ultima = now() WHERE code = $1', [code]);
    // registra na Timeline do cliente na 1ª abertura e depois no máximo a cada 6 horas
    if (r.cliente_id && Date.now() - ant > 6 * 3600 * 1000) {
      const agora = new Date();
      const ev = { id: 'int' + Math.random().toString(36).slice(2, 9), tipo: 'Nota interna',
        data: agora.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }),
        hora: agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }),
        desc: '👀 Abriu o link enviado' + (r.item ? ': ' + r.item : '') + (r.aberturas ? ' (' + (r.aberturas + 1) + 'ª vez)' : ''),
        imovelId: '', clienteId: r.cliente_id, cliente: r.cliente || '', autor: 'Sistema' };
      await atualizarDoc('timeline', (t) => [ev].concat(Array.isArray(t) ? t : [])).catch(() => null);
    }
  }
  // marca a visita com o código do link: o site associa a navegação deste visitante ao cliente
  try { const u = new URL(r.url); u.searchParams.set('hl', code); return u.toString(); } catch (e) { return r.url; }
}
