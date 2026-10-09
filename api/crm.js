// Dados do CRM na nuvem, com permissões por perfil
// GET  /api/crm?chave=imoveis            -> { data, versao }
// GET  /api/crm?chaves=imoveis,clientes  -> { docs: { imoveis:{data,versao}, ... } }
// POST /api/crm { chave, valor, versao }  -> grava se a versão bater; senão 409 com a versão atual
// POST /api/crm { acao:'sincronizarLeads' } -> leva os contatos do site e da Meta para Clientes (com rodízio)
// Admin e gerente gravam o documento inteiro. Corretor e secretária gravam por mesclagem no servidor:
// só o que podem editar é aceito, nada é excluído e a resposta traz os dados atualizados.
import { sql, ensureSchema, cors, body, ok, err, fail, atualizarDoc } from './_lib.js';
import { sessao, ehDoUsuario, proximoResponsavel } from './_auth.js';
import usuarios from './_usuarios.js';
import crypto from 'node:crypto';
import { esquemaLinks } from './_links.js';
import { sincronizarLeads } from './_sync.js';
import { enviarAviso, avisoConfigurado } from './_avisos.js';
import { linkContato } from './_contato.js';
import { personalizarLote } from './_investidores.js';
import { criarDossie, listarDossies } from './_dossie.js';
import { statusCliente, iniciarSequencia, pausarSequencia, emailTeste, emailConfigurado } from './_email.js';
import { esquemaRastreio } from './leads.js'; // /api/usuarios é atendido aqui (limite de 12 funções do plano Hobby da Vercel)

const CHAVE_OK = /^[a-z_]{1,40}$/;
const HIST_MAX = 30; // cópias guardadas por chave (desfazer em caso de erro)
const LISTAS = ['imoveis', 'clientes', 'timeline', 'empreendimentos', 'campanhas', 'posts_aprovacao'];

async function ler(chave) {
  const r = await sql.query('SELECT valor, versao FROM crm_docs WHERE chave = $1', [chave]);
  return r[0] ? { data: r[0].valor, versao: r[0].versao } : { data: null, versao: 0 };
}
const arr = (v) => (Array.isArray(v) ? v : []);

// ── Leitura conforme o perfil ─────────────────────────────────────────
async function clientesDe(s) {
  const c = arr((await ler('clientes')).data);
  return s.perfil === 'corretor' ? c.filter((x) => ehDoUsuario(x, s.uid)) : c;
}
async function filtrar(s, chave, data) {
  const p = s.perfil;
  if (p === 'admin') return data;
  if (chave === 'clientes') return p === 'corretor' ? arr(data).filter((x) => ehDoUsuario(x, s.uid)) : data;
  if (chave === 'timeline') {
    if (p !== 'corretor') return data;
    const meus = new Set((await clientesDe(s)).map((c) => c.id));
    return arr(data).filter((t) => (t && t.clienteId && meus.has(t.clienteId)) || (t && t.autorId === s.uid));
  }
  if (chave === 'campanhas') return p === 'gerente' ? data : [];
  if (chave === 'posts_aprovacao') return p === 'gerente' ? data : arr(data).filter((x) => x && x.autorId === s.uid);
  if (chave === 'wa_config') return p === 'gerente' ? data : {};
  return data; // imoveis, empreendimentos, site_config, equipe_config: leitura liberada
}

// ── Escrita conforme o perfil ─────────────────────────────────────────
// 'total': grava o documento inteiro · 'mesclar': só o permitido · null: sem permissão
function modoEscrita(s, chave) {
  const p = s.perfil;
  if (p === 'admin') return 'total';
  if (p === 'gerente') return ['campanhas', 'equipe_config', 'wa_config', 'site_config'].includes(chave) ? null : 'total';
  if (p === 'corretor') return ['clientes', 'imoveis', 'timeline', 'posts_aprovacao'].includes(chave) ? 'mesclar' : null;
  if (p === 'secretaria') return ['clientes', 'imoveis', 'timeline'].includes(chave) ? 'mesclar' : null;
  return null;
}
function podeEditar(s, chave, item) {
  if (!item) return false;
  if (s.perfil === 'secretaria') return chave !== 'timeline';
  if (chave === 'clientes') return ehDoUsuario(item, s.uid);
  if (chave === 'imoveis') return item.criadoPor === s.uid;
  return false; // timeline e posts: só acrescenta
}
// Campos que só admin e gerente mudam
const PROTEGIDOS = { clientes: ['criadoPor', 'responsavelId', 'responsavelNome'], imoveis: ['criadoPor'], timeline: [], posts_aprovacao: [] };

function carimbarNovos(s, chave, atual, valor) {
  if (!Array.isArray(valor) || !['clientes', 'imoveis', 'timeline', 'posts_aprovacao'].includes(chave)) return valor;
  const ja = new Set(arr(atual).map((x) => x && x.id));
  return valor.map((x) => {
    if (!x || x.id == null || ja.has(x.id)) return x;
    if (chave === 'timeline' || chave === 'posts_aprovacao') return { ...x, autorId: x.autorId || s.uid, autor: x.autor || s.nome };
    const y = { ...x, criadoPor: x.criadoPor || s.uid };
    if (chave === 'clientes' && s.perfil === 'corretor') { y.responsavelId = s.uid; y.responsavelNome = s.nome; }
    return y;
  });
}
function mesclar(s, chave, servidor, enviado) {
  servidor = arr(servidor); enviado = arr(enviado);
  const E = new Map(enviado.filter((x) => x && x.id != null).map((x) => [x.id, x]));
  const S = new Set(servidor.map((x) => x && x.id));
  const fixos = PROTEGIDOS[chave] || [];
  const out = servidor.map((x) => {
    const e = x && E.get(x.id);
    if (!e || !podeEditar(s, chave, x)) return x;
    const y = { ...e };
    fixos.forEach((f) => { if (x[f] !== undefined) y[f] = x[f]; else delete y[f]; });
    return y;
  });
  const novos = carimbarNovos(s, chave, servidor, enviado.filter((x) => x && x.id != null && !S.has(x.id)));
  return novos.concat(out);
}

export default async function handler(req, res) {
  if ((req.query || {}).modulo === 'usuarios') return usuarios(req, res);
  if (cors(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const s = await sessao(req);
    if (!s) return err(res, 401, 'Senha do CRM inválida.');
    const q = req.query || {};

    if (req.method === 'GET') {
      if (q.acao === 'emailStatus') { // 📧 sequência de e-mails do cliente
        if (!q.cliente) return ok(res, { configurado: emailConfigurado() });
        const cid = String(q.cliente);
        if (s.perfil === 'corretor' && !(await clientesDe(s)).some((c) => c.id === cid)) return err(res, 403, 'Cliente de outro corretor.');
        return ok(res, await statusCliente(cid));
      }
      if (q.acao === 'dossies') { // dossiês já enviados a um cliente, com aberturas
        const cid = String(q.cliente || '');
        if (s.perfil === 'corretor' && !(await clientesDe(s)).some((c) => c.id === cid)) return err(res, 403, 'Cliente de outro corretor.');
        const base = process.env.SITE_URL || ('https://' + (req.headers['x-forwarded-host'] || req.headers.host));
        return ok(res, { dossies: (await listarDossies(cid)).map((d) => Object.assign({}, d, { url: base + '/d/' + d.code })) });
      }
      if (q.acao === 'linkContato') { // 📇 salvar o cliente nos contatos do celular
        const cid = String(q.cliente || '');
        if (s.perfil === 'corretor' && !(await clientesDe(s)).some((c) => c.id === cid)) return err(res, 403, 'Cliente de outro corretor.');
        const url = linkContato(cid);
        return url ? ok(res, { url }) : err(res, 400, 'Configure SESSION_SECRET ou ADMIN_KEY na Vercel.');
      }
      if (q.acao === 'navegacao') { // o que um cliente viu no site
        await esquemaRastreio();
        const cid = String(q.cliente || ''), vis = /^v[a-z0-9]{6,20}$/.test(String(q.visitante || '')) ? String(q.visitante) : '';
        if (s.perfil === 'corretor' && !(await clientesDe(s)).some((c) => c.id === cid)) return err(res, 403, 'Cliente de outro corretor.');
        const r = await sql.query(`SELECT kind, item_id, item_nome, count(*)::int AS vezes, max(criado_em) AS ultima, min(criado_em) AS primeira
            FROM site_eventos WHERE (cliente_id = $1 OR ($2 <> '' AND visitante = $2)) AND item_id <> '' GROUP BY kind, item_id, item_nome ORDER BY max(criado_em) DESC LIMIT 30`, [cid, vis]);
        const t = await sql.query(`SELECT count(DISTINCT date_trunc('day', criado_em))::int AS dias, max(criado_em) AS ultima, (array_agg(utm ORDER BY criado_em) FILTER (WHERE utm IS NOT NULL))[1] AS utm
            FROM site_eventos WHERE cliente_id = $1 OR ($2 <> '' AND visitante = $2)`, [cid, vis]);
        return ok(res, { itens: r, resumo: t[0] || {} });
      }
      if (q.acao === 'siteTop') { // mais vistos no site
        await esquemaRastreio();
        const dias = Math.min(Math.max(parseInt(q.dias, 10) || 30, 1), 365);
        const r = await sql.query(`SELECT kind, item_id, max(item_nome) AS item_nome, count(*)::int AS vezes, count(DISTINCT visitante)::int AS pessoas
            FROM site_eventos WHERE item_id <> '' AND criado_em > now() - ($1 || ' days')::interval GROUP BY kind, item_id ORDER BY pessoas DESC, vezes DESC LIMIT 10`, [String(dias)]);
        const v = await sql.query(`SELECT count(DISTINCT visitante)::int AS visitantes, count(DISTINCT visitante) FILTER (WHERE utm->>'gclid' IS NOT NULL OR utm->>'utm_source' ILIKE 'google%')::int AS google,
            count(DISTINCT visitante) FILTER (WHERE utm->>'fbclid' IS NOT NULL OR utm->>'utm_source' ILIKE ANY (ARRAY['facebook%','instagram%','meta%','fb%','ig%']))::int AS meta
            FROM site_eventos WHERE criado_em > now() - ($1 || ' days')::interval`, [String(dias)]);
        return ok(res, { top: r, visitantes: v[0] || {} });
      }
      if (q.acao === 'links') {
        await esquemaLinks();
        let r = await sql.query(`SELECT cliente_id, count(*)::int AS links, sum(aberturas)::int AS aberturas, max(ultima) AS ultima,
            json_agg(json_build_object('item', item, 'aberturas', aberturas, 'ultima', ultima, 'criado', criado_em) ORDER BY criado_em DESC) AS itens
          FROM links WHERE cliente_id IS NOT NULL GROUP BY cliente_id`);
        if (s.perfil === 'corretor') { const meus = new Set((await clientesDe(s)).map((c) => c.id)); r = r.filter((x) => meus.has(x.cliente_id)); }
        return ok(res, { links: r });
      }
      if (q.chaves) {
        const chaves = String(q.chaves).split(',').filter((c) => CHAVE_OK.test(c)).slice(0, 20);
        const docs = {};
        for (const c of chaves) { const d = await ler(c); docs[c] = { data: await filtrar(s, c, d.data), versao: d.versao }; }
        return ok(res, { docs });
      }
      if (!CHAVE_OK.test(q.chave || '')) return err(res, 400, 'Chave inválida.');
      const d = await ler(q.chave);
      return ok(res, { data: await filtrar(s, q.chave, d.data), versao: d.versao });
    }

    if (req.method === 'POST') {
      const b = body(req);
      if (b.acao === 'sincronizarLeads') return ok(res, await sincronizarLeads());
      if (b.acao === 'emailIniciar' || b.acao === 'emailPausar') {
        const cid = String(b.clienteId || '');
        const meus = await clientesDe(s);
        const cli = meus.find((c) => c.id === cid);
        if (!cli) return err(res, 403, 'Cliente não encontrado ou de outro corretor.');
        if (b.acao === 'emailPausar') { await pausarSequencia(cid, !!b.ativo); return ok(res, await statusCliente(cid)); }
        const r = await iniciarSequencia(cli, String(b.item || '').slice(0, 160) || ((String(cli.obs || '').match(/Lead de anúncio na Meta · ([^|]+)/) || [])[1] || '').trim(), { manual: true });
        if (!r.ok) return err(res, 400, r.motivo || r.erro || 'Não foi possível iniciar.');
        return ok(res, await statusCliente(cid));
      }
      if (b.acao === 'investPersonalizar') { // 💼 mesma oferta, uma mensagem por investidor
        const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).slice(0, 6);
        const oferta = String(b.oferta || '').trim().slice(0, 2000);
        const canal = ['email', 'whatsapp', 'ligacao'].includes(b.canal) ? b.canal : 'whatsapp';
        if (!ids.length || oferta.length < 10) return err(res, 400, 'Selecione investidores e escreva a oferta.');
        const meus = await clientesDe(s);
        const clientes = ids.map((id) => meus.find((c) => c.id === id)).filter(Boolean);
        const r = await personalizarLote({ clientes, oferta, itemRef: b.item || null, canal, enviar: !!b.enviar && canal === 'email', eu: s.nome || 'o corretor', rotulo: String(b.rotulo || '').slice(0, 80) });
        return ok(res, { mensagens: r });
      }
      if (b.acao === 'emailTeste') {
        if (s.perfil !== 'admin') return err(res, 403, 'Só o administrador.');
        const para = String(b.para || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(para)) return err(res, 400, 'Informe um e-mail válido.');
        const r = await emailTeste(para, b.nome);
        return r.ok ? ok(res, { enviado: true }) : err(res, 502, 'Não enviou: ' + r.erro);
      }
      if (b.acao === 'avisoStatus') return ok(res, { configurado: avisoConfigurado() });
      if (b.acao === 'testarAvisoPessoal') {
        if (s.perfil !== 'admin') return err(res, 403, 'Só o administrador.');
        if (!avisoConfigurado()) return err(res, 400, 'Falta criar AVISO_WHATSAPP e AVISO_CALLMEBOT_KEY na Vercel (e fazer Redeploy).');
        const r = await enviarAviso('✅ Teste do Holy CRM: os avisos de lead novo vão chegar aqui.');
        return r.ok ? ok(res, { enviado: true }) : err(res, 502, 'O CallMeBot não aceitou (' + r.motivo + '). Confira o número e a chave.');
      }
      if (b.acao === 'dossie') { // 📘 dossiê exclusivo do imóvel para um cliente
        if (!b.imovelId) return err(res, 400, 'Escolha o imóvel.');
        if (b.clienteId && s.perfil === 'corretor') { const c = arr((await ler('clientes')).data).find((x) => x.id === b.clienteId); if (!c || !ehDoUsuario(c, s.uid)) return err(res, 403, 'Cliente de outro corretor.'); }
        const d = await criarDossie({ clienteId: b.clienteId || null, imovelId: String(b.imovelId), intro: b.intro, autor: s.nome || '' });
        return ok(res, d);
      }
      if (b.acao === 'link') {
        const url = String(b.url || '');
        let u; try { u = new URL(url); } catch { return err(res, 400, 'Link inválido.'); }
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        if (u.protocol !== 'https:' || !(/holyimoveis\.com$/.test(u.hostname) || /vercel\.app$/.test(u.hostname) || u.hostname === host)) return err(res, 400, 'Só links do site da Holy podem ser rastreados.');
        await esquemaLinks();
        const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, 'x').slice(0, 7);
        await sql.query('INSERT INTO links (code, url, cliente_id, cliente, item, criado_por) VALUES ($1, $2, $3, $4, $5, $6)',
          [code, url, b.clienteId || null, String(b.cliente || '').slice(0, 120), String(b.item || '').slice(0, 160), s.nome || '']);
        const base = process.env.SITE_URL || ('https://' + host);
        return ok(res, { code, url: base + '/l/' + code });
      }
      if (!CHAVE_OK.test(b.chave || '')) return err(res, 400, 'Chave inválida.');
      if (b.valor === undefined) return err(res, 400, 'Informe "valor".');
      const json = JSON.stringify(b.valor);
      if (json.length > 4_000_000) return err(res, 413, 'Dados grandes demais. Fotos precisam ir pelo envio de fotos, não dentro do cadastro.');
      const modo = modoEscrita(s, b.chave);
      if (!modo) return err(res, 403, 'Seu perfil não pode alterar esta área.');

      if (modo === 'mesclar') {
        const novo = await atualizarDoc(b.chave, (atual) => mesclar(s, b.chave, atual, b.valor), []);
        const d = await ler(b.chave);
        return ok(res, { versao: d.versao, data: await filtrar(s, b.chave, novo) });
      }

      const base = Number.isFinite(+b.versao) ? Math.trunc(+b.versao) : null;
      const atual = await ler(b.chave);
      if (base !== null && base !== atual.versao) {
        return res.status(409).json({ success: false, error: 'conflito', data: await filtrar(s, b.chave, atual.data), versao: atual.versao });
      }
      const valor = carimbarNovos(s, b.chave, atual.data, b.valor);
      const jsonFinal = JSON.stringify(valor);
      let r;
      if (atual.versao === 0) {
        r = await sql.query(
          `INSERT INTO crm_docs (chave, valor, versao) VALUES ($1, $2::jsonb, 1)
           ON CONFLICT (chave) DO NOTHING RETURNING versao`, [b.chave, jsonFinal]);
      } else {
        await sql.query('INSERT INTO crm_historico (chave, valor, versao) VALUES ($1, $2::jsonb, $3)', [b.chave, JSON.stringify(atual.data), atual.versao]);
        await sql.query(
          `DELETE FROM crm_historico WHERE chave = $1 AND id NOT IN (SELECT id FROM crm_historico WHERE chave = $1 ORDER BY id DESC LIMIT ${HIST_MAX})`, [b.chave]);
        r = await sql.query(
          `UPDATE crm_docs SET valor = $2::jsonb, versao = versao + 1, atualizado_em = now()
           WHERE chave = $1 AND versao = $3 RETURNING versao`, [b.chave, jsonFinal, atual.versao]);
      }
      if (!r.length) {
        const agora = await ler(b.chave);
        return res.status(409).json({ success: false, error: 'conflito', data: await filtrar(s, b.chave, agora.data), versao: agora.versao });
      }
      // Se o servidor carimbou algo (autor, quem cadastrou), devolve para o aparelho ficar igual
      return ok(res, { versao: r[0].versao, ...(jsonFinal !== json ? { data: valor } : {}) });
    }

    return err(res, 405, 'Método não permitido.');
  } catch (e) { return fail(res, e); }
}
