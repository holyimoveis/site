// Leads do site -> CRM
// POST (público): formulário de contato e cliques nos botões de WhatsApp
// GET/PATCH/DELETE (só com X-Admin-Key): o CRM busca os leads e atualiza a etapa
import { sql, ensureSchema, cors, body, ok, err, fail, ipHash, str } from './_lib.js';
import { sessao, pode } from './_auth.js';
import { waitUntil } from '@vercel/functions';
import { sincronizarLeads } from './_sync.js';

let _rastreio = false;
export async function esquemaRastreio() {
  if (_rastreio) return;
  await sql.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS visitante TEXT');
  await sql.query('ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm JSONB');
  await sql.query(`CREATE TABLE IF NOT EXISTS site_eventos (id BIGSERIAL PRIMARY KEY, visitante TEXT NOT NULL, cliente_id TEXT, evento TEXT, kind TEXT, item_id TEXT, item_nome TEXT,
      pagina TEXT, utm JSONB, ip_hash TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await sql.query('CREATE INDEX IF NOT EXISTS site_eventos_vis_idx ON site_eventos (visitante, criado_em DESC)');
  await sql.query('CREATE TABLE IF NOT EXISTS links (code TEXT PRIMARY KEY, url TEXT NOT NULL, cliente_id TEXT, cliente TEXT, item TEXT, criado_por TEXT, aberturas INT NOT NULL DEFAULT 0, ultima TIMESTAMPTZ, criado_em TIMESTAMPTZ NOT NULL DEFAULT now())');
  _rastreio = true;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    await ensureSchema();
    const q = req.query || {};

    if (req.method === 'POST') {
      const b = body(req);
      if (b.website) return ok(res, { id: null }); // campo-armadilha contra robôs
      await esquemaRastreio();
      const vis = /^v[a-z0-9]{6,20}$/.test(String(b.visitante || '')) ? String(b.visitante) : null;
      const utm = b.utm && typeof b.utm === 'object' ? JSON.stringify(Object.fromEntries(Object.entries(b.utm).slice(0, 12).map(([k, v]) => [String(k).slice(0, 20), String(v).slice(0, 120)]))) : null;
      // Navegação no site (só com consentimento do visitante; sem dados pessoais)
      if (b.tipo === 'evento') {
        if (!vis) return ok(res, { id: null });
        const ih0 = ipHash(req);
        const n0 = await sql.query(`SELECT count(*)::int AS n FROM site_eventos WHERE ip_hash = $1 AND criado_em > now() - interval '10 minutes'`, [ih0]);
        if (n0[0].n >= 120) return ok(res, { id: null });
        let cli = null;
        if (/^[A-Za-z0-9]{4,12}$/.test(String(b.hl || ''))) { const l = await sql.query('SELECT cliente_id FROM links WHERE code = $1', [String(b.hl)]).catch(() => []); cli = (l[0] && l[0].cliente_id) || null; }
        await sql.query(`INSERT INTO site_eventos (visitante, cliente_id, evento, kind, item_id, item_nome, pagina, utm, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [vis, cli, str(b.evento, 30) || 'ver', str(b.kind, 4), str(b.item_id, 80), str(b.item_nome, 160), str(b.pagina, 200), utm, ih0]);
        if (cli) await sql.query('UPDATE site_eventos SET cliente_id = $1 WHERE visitante = $2 AND cliente_id IS NULL', [cli, vis]);
        return ok(res, { ok: 1 });
      }
      const nome = str(b.nome, 120), telefone = str(b.telefone, 40), email = str(b.email, 160);
      const tipo = (nome || telefone || email) ? 'formulario' : 'whatsapp';
      if (tipo === 'formulario' && !telefone && !email) return err(res, 400, 'Informe telefone ou e-mail.');
      const ih = ipHash(req);
      const rec = await sql.query(`SELECT count(*)::int AS n FROM leads WHERE ip_hash = $1 AND criado_em > now() - interval '10 minutes'`, [ih]);
      if (rec[0].n >= 20) return err(res, 429, 'Muitas mensagens em pouco tempo. Tente de novo em alguns minutos.');
      const r = await sql.query(
        `INSERT INTO leads (tipo, nome, email, telefone, interesse, mensagem, origem, pagina, imovel, ip_hash, visitante, utm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
        [tipo, nome, email, telefone, str(b.interesse, 160), str(b.mensagem, 2000), str(b.origem, 120), str(b.pagina, 200), str(b.imovel, 160), ih, vis, utm]);
      // leva para o CRM na hora e avisa no WhatsApp pessoal (sem atrasar a resposta ao visitante)
      if (tipo === 'formulario') waitUntil(esquemaRastreio().then(() => sincronizarLeads()).catch((e) => console.error('[leads] sincronizar', e.message)));
      return ok(res, { id: r[0].id }, 201);
    }

    const s = await sessao(req);
    if (!s) return err(res, 401, 'Chave de administrador inválida.');
    if (!pode(s, 'leads')) return err(res, 403, 'Sem permissão.');

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
