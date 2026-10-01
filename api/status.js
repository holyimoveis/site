// Diagnóstico: abra /api/status no navegador para ver se está tudo conectado
import { sql, ensureSchema, cors, ok } from './_lib.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  const st = {
    banco: 'não conectado',
    fotos: (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN) ? 'conectado' : 'não conectado',
    senha_crm: (process.env.ADMIN_KEY || '').length >= 12 ? 'configurada' : 'não configurada (mínimo 12 caracteres)',
    ia: process.env.ANTHROPIC_API_KEY ? 'configurada' : 'não configurada',
  };
  try {
    await ensureSchema();
    const docs = await sql.query("SELECT chave, jsonb_array_length(CASE WHEN jsonb_typeof(valor)='array' THEN valor ELSE '[]'::jsonb END) n FROM crm_docs");
    const pub = await sql.query("SELECT count(*)::int n FROM crm_docs, jsonb_array_elements(CASE WHEN jsonb_typeof(valor)='array' THEN valor ELSE '[]'::jsonb END) im WHERE chave='imoveis' AND im->>'publicarSite'='true' AND im->>'status'='Disponível'");
    const l = await sql.query('SELECT count(*)::int n FROM leads');
    const emp = await sql.query("SELECT count(*)::int n FROM crm_docs, jsonb_array_elements(CASE WHEN jsonb_typeof(valor)='array' THEN valor ELSE '[]'::jsonb END) e WHERE chave='empreendimentos' AND COALESCE(e->>'publicarSite','true') <> 'false'");
    st.banco = 'conectado';
    st.total = Object.fromEntries(docs.map((d) => [d.chave, d.n]));
    st.total.imoveis_no_site = pub[0].n;
    st.total.leads = l[0].n;
    st.total.empreendimentos_no_site = emp[0].n;
  } catch (e) {
    if (e.message !== 'DB_NAO_CONFIGURADO') st.banco = 'erro: ' + e.message;
  }
  res.setHeader('Cache-Control', 'no-store');
  return ok(res, { status: st });
}
