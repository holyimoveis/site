// Configurações públicas do site (banner da página inicial), editadas no CRM > Configurações
import { sql, ensureSchema, cors, ok, err, fail } from './_lib.js';
const https = (u) => typeof u === 'string' && /^https:\/\//.test(u);
export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') return err(res, 405, 'Somente leitura.');
  try {
    await ensureSchema();
    const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'site_config'");
    const c = (r[0] && r[0].valor) || {};
    const b = c.banners || {};
    const banners = {};
    for (const k of ['litoral', 'holy', 'venda']) if (https(b[k])) banners[k] = b[k];
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');
    return ok(res, { banners });
  } catch (e) { return fail(res, e); }
}
