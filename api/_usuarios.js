// Usuários do CRM (rota /api/usuarios, atendida por api/crm.js via vercel.json)
// POST { acao:'login', email, senha }           -> { token, usuario }   (público)
// GET  ?me=1                                     -> { usuario }          (qualquer usuário logado)
// GET                                            -> { usuarios }         (admin e gerente; e-mail só para o admin)
// POST { acao:'criar', nome, email, perfil, senha }                     (admin)
// PATCH { id, nome?, perfil?, ativo?, senha? }                          (admin)
// POST { acao:'minhaSenha', atual, nova }                               (o próprio usuário)
import { sql, ensureSchema, cors, body, ok, err, fail, newId, str } from './_lib.js';
import { PERFIS, sessao, pode, hashSenha, confereSenha, emitirToken } from './_auth.js';

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const pub = (u, comEmail) => ({ id: u.id, nome: u.nome, perfil: u.perfil, perfilNome: PERFIS[u.perfil] || u.perfil, ativo: u.ativo, ...(comEmail ? { email: u.email, ultimo_acesso: u.ultimo_acesso } : {}) });

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const b = req.method === 'GET' ? {} : body(req);

    if (req.method === 'POST' && b.acao === 'login') {
      const email = String(b.email || '').trim().toLowerCase();
      const r = await sql.query('SELECT * FROM usuarios WHERE lower(email) = $1', [email]);
      const u = r[0];
      if (!u || !u.ativo || !confereSenha(String(b.senha || ''), u.senha_hash)) {
        await new Promise((ok2) => setTimeout(ok2, 800)); // freia tentativas de adivinhar a senha
        return err(res, 401, 'E-mail ou senha incorretos.');
      }
      await sql.query('UPDATE usuarios SET ultimo_acesso = now() WHERE id = $1', [u.id]);
      return ok(res, { token: emitirToken(u), usuario: pub(u, true) });
    }

    const s = await sessao(req);
    if (!s) return err(res, 401, 'Faça login de novo.');

    if (req.method === 'GET') {
      if (req.query && req.query.me) return ok(res, { usuario: { id: s.uid, nome: s.nome, email: s.email, perfil: s.perfil, perfilNome: PERFIS[s.perfil], mestre: !!s.mestre } });
      if (!['admin', 'gerente'].includes(s.perfil)) return err(res, 403, 'Sem permissão.');
      const r = await sql.query('SELECT * FROM usuarios ORDER BY ativo DESC, nome');
      return ok(res, { usuarios: r.map((u) => pub(u, s.perfil === 'admin')), perfis: PERFIS });
    }

    if (req.method === 'POST' && b.acao === 'minhaSenha') {
      if (s.mestre) return err(res, 400, 'A chave mestra é trocada na Vercel (variável ADMIN_KEY).');
      if (String(b.nova || '').length < 8) return err(res, 400, 'A nova senha precisa de pelo menos 8 caracteres.');
      const r = await sql.query('SELECT senha_hash FROM usuarios WHERE id = $1', [s.uid]);
      if (!r[0] || !confereSenha(String(b.atual || ''), r[0].senha_hash)) return err(res, 400, 'Senha atual incorreta.');
      await sql.query('UPDATE usuarios SET senha_hash = $2 WHERE id = $1', [s.uid, hashSenha(b.nova)]);
      return ok(res);
    }

    if (!pode(s, 'usuarios')) return err(res, 403, 'Só o administrador gerencia usuários.');

    if (req.method === 'POST' && b.acao === 'criar') {
      const nome = str(b.nome, 80), email = String(b.email || '').trim().toLowerCase(), perfil = String(b.perfil || '');
      if (!nome) return err(res, 400, 'Informe o nome.');
      if (!emailOk(email)) return err(res, 400, 'E-mail inválido.');
      if (!PERFIS[perfil]) return err(res, 400, 'Perfil inválido.');
      if (String(b.senha || '').length < 8) return err(res, 400, 'A senha inicial precisa de pelo menos 8 caracteres.');
      const ja = await sql.query('SELECT 1 FROM usuarios WHERE lower(email) = $1', [email]);
      if (ja.length) return err(res, 409, 'Já existe um usuário com esse e-mail.');
      const id = newId('us');
      const r = await sql.query('INSERT INTO usuarios (id, nome, email, perfil, senha_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *', [id, nome, email, perfil, hashSenha(b.senha)]);
      return ok(res, { usuario: pub(r[0], true) }, 201);
    }

    if (req.method === 'PATCH') {
      const id = String(b.id || '');
      const r0 = await sql.query('SELECT * FROM usuarios WHERE id = $1', [id]);
      if (!r0[0]) return err(res, 404, 'Usuário não encontrado.');
      if (b.perfil !== undefined && !PERFIS[b.perfil]) return err(res, 400, 'Perfil inválido.');
      if (b.senha !== undefined && String(b.senha).length < 8) return err(res, 400, 'A senha precisa de pelo menos 8 caracteres.');
      const r = await sql.query(
        `UPDATE usuarios SET nome = COALESCE($2, nome), perfil = COALESCE($3, perfil), ativo = COALESCE($4, ativo), senha_hash = COALESCE($5, senha_hash) WHERE id = $1 RETURNING *`,
        [id, str(b.nome, 80), b.perfil || null, typeof b.ativo === 'boolean' ? b.ativo : null, b.senha ? hashSenha(b.senha) : null]);
      return ok(res, { usuario: pub(r[0], true) });
    }

    return err(res, 405, 'Método não permitido.');
  } catch (e) { return fail(res, e); }
}
