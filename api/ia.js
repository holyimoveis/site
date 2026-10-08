// Consultor IA do CRM: a chave da Anthropic fica no servidor (variável ANTHROPIC_API_KEY)
import { cors, body, ok, err } from './_lib.js';
import { sessao, pode } from './_auth.js';
export const maxDuration = 60;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') return err(res, 405, 'Use POST.');
  const s = await sessao(req).catch(() => null);
  if (!pode(s, 'ia')) return err(res, 401, 'Senha do CRM inválida.');
  const b = body(req);
  const key = process.env.ANTHROPIC_API_KEY || (String(b.apiKey || '').startsWith('sk-ant-') ? b.apiKey : '');
  if (!key) return err(res, 400, 'IA sem chave. Cadastre ANTHROPIC_API_KEY na Vercel (LEIA-ME, passo 5).');
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
