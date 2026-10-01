// Dados do CRM na nuvem (só com X-Admin-Key)
// GET  /api/crm?chave=imoveis            -> { data, versao }
// GET  /api/crm?chaves=imoveis,clientes  -> { docs: { imoveis:{data,versao}, ... } }
// POST /api/crm { chave, valor, versao }  -> grava se a versão bater; senão 409 com a versão atual
import { sql, ensureSchema, cors, isAdmin, body, ok, err, fail } from './_lib.js';

const CHAVE_OK = /^[a-z_]{1,40}$/;
const HIST_MAX = 30; // cópias guardadas por chave (desfazer em caso de erro)

async function ler(chave) {
  const r = await sql.query('SELECT valor, versao FROM crm_docs WHERE chave = $1', [chave]);
  return r[0] ? { data: r[0].valor, versao: r[0].versao } : { data: null, versao: 0 };
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (!isAdmin(req)) return err(res, 401, 'Senha do CRM inválida.');
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const q = req.query || {};

    if (req.method === 'GET') {
      if (q.chaves) {
        const chaves = String(q.chaves).split(',').filter((c) => CHAVE_OK.test(c)).slice(0, 20);
        const docs = {};
        for (const c of chaves) docs[c] = await ler(c);
        return ok(res, { docs });
      }
      if (!CHAVE_OK.test(q.chave || '')) return err(res, 400, 'Chave inválida.');
      return ok(res, await ler(q.chave));
    }

    if (req.method === 'POST') {
      const b = body(req);
      if (!CHAVE_OK.test(b.chave || '')) return err(res, 400, 'Chave inválida.');
      if (b.valor === undefined) return err(res, 400, 'Informe "valor".');
      const json = JSON.stringify(b.valor);
      if (json.length > 4_000_000) return err(res, 413, 'Dados grandes demais. Fotos precisam ir pelo envio de fotos, não dentro do cadastro.');
      const base = Number.isFinite(+b.versao) ? Math.trunc(+b.versao) : null;

      // guarda a versão anterior no histórico antes de sobrescrever
      const atual = await ler(b.chave);
      if (base !== null && base !== atual.versao) {
        return res.status(409).json({ success: false, error: 'conflito', data: atual.data, versao: atual.versao });
      }
      let r;
      if (atual.versao === 0) {
        r = await sql.query(
          `INSERT INTO crm_docs (chave, valor, versao) VALUES ($1, $2::jsonb, 1)
           ON CONFLICT (chave) DO NOTHING RETURNING versao`, [b.chave, json]);
      } else {
        await sql.query('INSERT INTO crm_historico (chave, valor, versao) VALUES ($1, $2::jsonb, $3)', [b.chave, JSON.stringify(atual.data), atual.versao]);
        await sql.query(
          `DELETE FROM crm_historico WHERE chave = $1 AND id NOT IN (SELECT id FROM crm_historico WHERE chave = $1 ORDER BY id DESC LIMIT ${HIST_MAX})`, [b.chave]);
        r = await sql.query(
          `UPDATE crm_docs SET valor = $2::jsonb, versao = versao + 1, atualizado_em = now()
           WHERE chave = $1 AND versao = $3 RETURNING versao`, [b.chave, json, atual.versao]);
      }
      if (!r.length) {
        const agora = await ler(b.chave);
        return res.status(409).json({ success: false, error: 'conflito', data: agora.data, versao: agora.versao });
      }
      return ok(res, { versao: r[0].versao });
    }

    return err(res, 405, 'Método não permitido.');
  } catch (e) { return fail(res, e); }
}
