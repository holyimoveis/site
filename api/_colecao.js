// Rota genérica para imóveis e empreendimentos (mesmo comportamento para os dois)
import { sql, ensureSchema, cors, isAdmin, body, ok, err, fail, cleanId, newId } from './_lib.js';

const INATIVOS = ['vendido', 'alugado', 'inativo', 'arquivado', 'reservado'];

export function colecao(tabela, prefixo) {
  return async function handler(req, res) {
    if (cors(req, res)) return;
    try {
      await ensureSchema();
      const q = req.query || {};
      const admin = isAdmin(req);

      if (req.method === 'GET') {
        if (q.id) {
          const r = await sql.query(`SELECT id, data, publicado, ordem FROM ${tabela} WHERE id = $1`, [cleanId(q.id)]);
          const row = r[0];
          if (!row || (!row.publicado && !admin)) return err(res, 404, 'Não encontrado.');
          return ok(res, { data: { ...row.data, id: row.id, publicado: row.publicado, ordem: row.ordem } });
        }
        const todos = admin && (q.todos === '1' || q.todos === 'true');
        const r = await sql.query(
          `SELECT id, data, publicado, ordem FROM ${tabela} ${todos ? '' : 'WHERE publicado'} ORDER BY ordem ASC, atualizado_em DESC LIMIT 500`);
        let data = r.map((row) => ({ ...row.data, id: row.id, publicado: row.publicado, ordem: row.ordem }));
        if (!todos) data = data.filter((d) => !INATIVOS.includes(String(d.status || '').toLowerCase()));
        res.setHeader('Cache-Control', todos ? 'no-store' : 's-maxage=30, stale-while-revalidate=300');
        return ok(res, { data });
      }

      if (!admin) return err(res, 401, 'Chave de administrador inválida.');

      if (req.method === 'POST') {
        // Aceita um item ou { items: [...] } para sincronizar vários de uma vez
        const b = body(req);
        const items = Array.isArray(b.items) ? b.items : [b];
        if (!items.length || items.length > 300) return err(res, 400, 'Envie de 1 a 300 itens.');
        const salvos = [];
        for (const it of items) {
          if (!it || typeof it !== 'object' || !it.nome) return err(res, 400, 'Todo item precisa de "nome".');
          const id = cleanId(it.id) || newId(prefixo);
          const publicado = it.publicado === undefined ? true : !!it.publicado;
          const ordem = Number.isFinite(+it.ordem) ? Math.trunc(+it.ordem) : 0;
          const { id: _i, publicado: _p, ordem: _o, ...data } = it;
          const json = JSON.stringify(data);
          if (json.length > 900000) return err(res, 413, `Item "${it.nome}" muito grande. Envie as fotos pelo /api/upload e use os links.`);
          await sql.query(
            `INSERT INTO ${tabela} (id, data, publicado, ordem) VALUES ($1, $2::jsonb, $3, $4)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, publicado = EXCLUDED.publicado, ordem = EXCLUDED.ordem, atualizado_em = now()`,
            [id, json, publicado, ordem]);
          salvos.push(id);
        }
        return ok(res, { ids: salvos });
      }

      if (req.method === 'PATCH') {
        const id = cleanId(q.id);
        if (!id) return err(res, 400, 'Informe ?id=');
        const b = body(req);
        const r = await sql.query(
          `UPDATE ${tabela} SET publicado = COALESCE($2, publicado), ordem = COALESCE($3, ordem), atualizado_em = now() WHERE id = $1 RETURNING id`,
          [id, typeof b.publicado === 'boolean' ? b.publicado : null, Number.isFinite(+b.ordem) ? Math.trunc(+b.ordem) : null]);
        return r.length ? ok(res, { id }) : err(res, 404, 'Não encontrado.');
      }

      if (req.method === 'DELETE') {
        const id = cleanId(q.id);
        if (!id) return err(res, 400, 'Informe ?id=');
        const r = await sql.query(`DELETE FROM ${tabela} WHERE id = $1 RETURNING id`, [id]);
        return r.length ? ok(res, { id }) : err(res, 404, 'Não encontrado.');
      }

      return err(res, 405, 'Método não permitido.');
    } catch (e) { return fail(res, e); }
  };
}
