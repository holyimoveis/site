// Consultor IA do CRM: a chave da Anthropic fica no servidor (variável ANTHROPIC_API_KEY)
import { sql, ensureSchema, cors, body, ok, err } from './_lib.js';
import { sessao, pode } from './_auth.js';
export const maxDuration = 60;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return err(res, 405, 'Use POST.');
  const s = await sessao(req).catch(() => null);
  if (!pode(s, 'ia')) return err(res, 401, 'Senha do CRM inválida.');
  const b = body(req);
  // Só a chave do servidor: o navegador não pode mais enviar uma chave própria
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return err(res, 400, 'IA sem chave. Cadastre ANTHROPIC_API_KEY na Vercel.');
  // Limite por pessoa (protege a conta da Anthropic se um login vazar): IA_LIMITE_HORA chamadas por hora (padrão 200)
  try {
    await ensureSchema();
    await sql.query('CREATE TABLE IF NOT EXISTS ia_uso (uid TEXT NOT NULL, hora TIMESTAMPTZ NOT NULL, n INT NOT NULL DEFAULT 0, PRIMARY KEY (uid, hora))');
    const lim = Math.max(20, +process.env.IA_LIMITE_HORA || 200);
    const u = (await sql.query("INSERT INTO ia_uso (uid, hora, n) VALUES ($1, date_trunc('hour', now()), 1) ON CONFLICT (uid, hora) DO UPDATE SET n = ia_uso.n + 1 RETURNING n", [String(s.uid)]))[0];
    if (u && u.n > lim) return err(res, 429, 'Limite de uso da IA atingido nesta hora. Tente de novo em alguns minutos.');
    if (Math.random() < 0.02) await sql.query("DELETE FROM ia_uso WHERE hora < now() - interval '3 days'");
  } catch (e) { console.error('[ia] limite', e.message); }
  const msg = String(b.msg || '').slice(0, 60000);
  if (!msg) return err(res, 400, 'Mensagem vazia.');
  // Fotos para a IA analisar (estúdio de fotos): até 16 imagens JPEG/PNG pequenas, em base64
  const imgs = (Array.isArray(b.imagens) ? b.imagens : []).slice(0, 16)
    .map((i) => ({ data: String((i && i.data) || '').replace(/^data:[^,]+,/, ''), media: /png/.test(String(i && i.media)) ? 'image/png' : 'image/jpeg' }))
    .filter((i) => i.data.length > 100 && i.data.length < 600000);
  const content = imgs.length ? imgs.map((i, k) => [{ type: 'text', text: 'Foto ' + k + ':' }, { type: 'image', source: { type: 'base64', media_type: i.media, data: i.data } }]).flat().concat([{ type: 'text', text: msg }]) : msg;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        max_tokens: Math.min(Math.max(+b.max || 900, 50), 4000),
        system: String(b.system || '').slice(0, 20000) || undefined,
        messages: [{ role: 'user', content }],
      }),
    });
    const d = await r.json();
    if (d.error) return err(res, 502, 'Erro da IA: ' + (d.error.message || 'desconhecido'));
    return ok(res, { text: (d.content || []).map((c) => c.text || '').join('') });
  } catch (e) {
    return err(res, 502, 'Falha ao falar com a IA: ' + e.message);
  }
}
