// Leads do site -> CRM
// POST (público): formulário de contato e cliques nos botões de WhatsApp
// GET/PATCH/DELETE (só com X-Admin-Key): o CRM busca os leads e atualiza a etapa
import { sql, ensureSchema, cors, isAdmin, body, ok, err, fail, ipHash, str } from './_lib.js';

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureSchema();
    const q = req.query || {};

    if (req.method === 'POST') {
      const b = body(req);
      if (b.website) return ok(res, { id: null }); // campo-armadilha contra robôs
      const nome = str(b.nome, 120), telefone = str(b.telefone, 40), email = str(b.email, 160);
      const tipo = (nome || telefone || email) ? 'formulario' : 'whatsapp';
      if (tipo === 'formulario' && !telefone && !email) return err(res, 400, 'Informe telefone ou e-mail.');
      const ih = ipHash(req);
      const rec = await sql.query(`SELECT count(*)::int AS n FROM leads WHERE ip_hash = $1 AND criado_em > now() - interval '10 minutes'`, [ih]);
      if (rec[0].n >= 20) return err(res, 429, 'Muitas mensagens em pouco tempo. Tente de novo em alguns minutos.');
      const r = await sql.query(
        `INSERT INTO leads (tipo, nome, email, telefone, interesse, mensagem, origem, pagina, imovel, ip_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [tipo, nome, email, telefone, str(b.interesse, 160), str(b.mensagem, 2000), str(b.origem, 120), str(b.pagina, 200), str(b.imovel, 160), ih]);
      return ok(res, { id: r[0].id }, 201);
    }

    if (!isAdmin(req)) return err(res, 401, 'Chave de administrador inválida.');

    if (req.method === 'GET') {
      const desde = q.desde && !isNaN(Date.parse(q.desde)) ? new Date(q.desde).toISOString() : '1970-01-01T00:00:00Z';
      const soNovos = q.novos === '1' || q.novos === 'true';
      const tipo = q.tipo === 'formulario' || q.tipo === 'whatsapp' ? q.tipo : null;
      const r = await sql.query(
        `SELECT id, tipo, nome, email, telefone, interesse, mensagem, origem, pagina, imovel, etapa, sincronizado, criado_em
         FROM leads WHERE criado_em > $1 AND ($2::boolean IS NOT TRUE OR sincronizado = false) AND ($3::text IS NULL OR tipo = $3)
         ORDER BY criado_em DESC LIMIT 500`, [desde, soNovos, tipo]);
      return ok(res, { data: r });
    }

    if (req.method === 'PATCH') {
      // ?id=123 ou { ids:[...] } para marcar vários como sincronizados
      const b = body(req);
      const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isFinite) : (q.id ? [Number(q.id)] : []);
      if (!ids.length) return err(res, 400, 'Informe ?id= ou { ids: [...] }');
      await sql.query(
        `UPDATE leads SET etapa = COALESCE($2, etapa), sincronizado = COALESCE($3, sincronizado), atualizado_em = now() WHERE id = ANY($1::bigint[])`,
        [ids, str(b.etapa, 60), typeof b.sincronizado === 'boolean' ? b.sincronizado : null]);
      return ok(res, { ids });
    }

    if (req.method === 'DELETE') {
      const id = Number(q.id);
      if (!Number.isFinite(id)) return err(res, 400, 'Informe ?id=');
      await sql.query(`DELETE FROM leads WHERE id = $1`, [id]);
      return ok(res, { id });
    }

    return err(res, 405, 'Método não permitido.');
  } catch (e) { return fail(res, e); }
}
