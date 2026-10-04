// Proxy de imagens para o criador de posts (permite desenhar fotos da nuvem no canvas sem bloqueio de CORS)
const PERMITIDOS = [/\.public\.blob\.vercel-storage\.com$/, /^images\.unsplash\.com$/];
export default async function handler(req, res) {
  const u = String((req.query || {}).url || '');
  let host = '';
  try { const x = new URL(u); if (x.protocol !== 'https:') throw 0; host = x.hostname; } catch { return res.status(400).end(); }
  if (!PERMITIDOS.some((r) => r.test(host))) return res.status(403).end();
  const r = await fetch(u);
  if (!r.ok) return res.status(502).end();
  res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(200).send(Buffer.from(await r.arrayBuffer()));
}
