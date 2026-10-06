// Token da Página gerado pelo login do Édipo (Plano B enquanto o usuário do sistema está bloqueado pela Meta).
// O admin cola no CRM um token de usuário do Explorador da Graph API; o servidor troca por um token longo
// e guarda o token da Página Holy Imóveis, que não expira. Fica em crm_docs com chave "segredo:meta_pagina":
// o ":" impede a leitura pela rota /api/crm, então só o servidor enxerga o token.
// Prioridade: variável META_PAGE_TOKEN na Vercel > token salvo pelo CRM > token do usuário do sistema.
import { sql, ensureSchema } from './_lib.js';

const V = () => process.env.META_API_VERSION || 'v25.0';
const GRAPH = () => `https://graph.facebook.com/${V()}`;
const CHAVE = 'segredo:meta_pagina';
const APP_ID = () => String(process.env.META_APP_ID || '1110281681853167');
let _cache = null;

async function getJSON(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && (j.error.error_user_msg || j.error.message)) || 'HTTP ' + r.status);
  return j;
}

// Token da Página salvo (ou null)
export async function tokenPaginaSalvo() {
  if (process.env.META_PAGE_TOKEN) return process.env.META_PAGE_TOKEN;
  if (_cache && _cache.exp > Date.now()) return _cache.t;
  try {
    await ensureSchema();
    const r = await sql.query('SELECT valor FROM crm_docs WHERE chave = $1', [CHAVE]);
    const t = (r[0] && r[0].valor && r[0].valor.token) || null;
    _cache = { t, exp: Date.now() + 5 * 60000 };
    return t;
  } catch (e) { return null; }
}

// Informações (sem o token) para o diagnóstico
export async function infoTokenPagina() {
  if (process.env.META_PAGE_TOKEN) return { origem: 'variável META_PAGE_TOKEN na Vercel' };
  await ensureSchema();
  const r = await sql.query('SELECT valor FROM crm_docs WHERE chave = $1', [CHAVE]);
  if (!r[0]) return null;
  const { token, ...resto } = r[0].valor || {};
  return { origem: 'salvo pelo CRM', ...resto };
}

// Recebe o token de usuário do Explorador, troca por um longo e salva o token da Página
export async function salvarTokenPagina(tokenUsuario, autor) {
  const segredo = process.env.META_APP_SECRET;
  const pagina = String(process.env.META_PAGE_ID || '');
  if (!segredo) throw new Error('Falta META_APP_SECRET na Vercel.');
  if (!pagina) throw new Error('Falta META_PAGE_ID na Vercel.');
  const curto = String(tokenUsuario || '').trim();
  if (curto.length < 50) throw new Error('Cole o token inteiro do Explorador da Graph API (começa com EAA).');

  // 1) token de usuário longo (60 dias); a Página derivada dele não expira
  const longo = await getJSON(`${GRAPH()}/oauth/access_token?` + new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: APP_ID(), client_secret: segredo, fb_exchange_token: curto,
  })).catch((e) => { throw new Error('A Meta não aceitou o token (' + e.message + '). Gere um novo no Explorador com o app Holy CRM selecionado.'); });

  // 2) token da Página Holy Imóveis
  const contas = await getJSON(`${GRAPH()}/me/accounts?` + new URLSearchParams({ fields: 'id,name,access_token,tasks', limit: '100', access_token: longo.access_token }));
  const p = (contas.data || []).find((x) => String(x.id) === pagina);
  if (!p || !p.access_token) throw new Error('A Página Holy Imóveis não veio no token. No Explorador, ao autorizar, marque a Página Holy Imóveis (e o Instagram, se perguntar).');

  // 3) confere as permissões que a Helena precisa
  const dbg = (await getJSON(`${GRAPH()}/debug_token?` + new URLSearchParams({ input_token: p.access_token, access_token: APP_ID() + '|' + segredo }))).data || {};
  const scopes = dbg.scopes || [];
  const precisa = ['pages_messaging', 'pages_manage_metadata', 'pages_show_list', 'instagram_basic', 'instagram_manage_messages'];
  const faltam = precisa.filter((s) => !scopes.includes(s));
  if (faltam.length) throw new Error('Faltaram permissões no token: ' + faltam.join(', ') + '. Adicione no Explorador, gere de novo e cole aqui.');

  const valor = { token: p.access_token, pagina: p.name, salvo_em: new Date().toISOString(), por: autor || '', expira: dbg.expires_at ? new Date(dbg.expires_at * 1000).toISOString() : 'nunca', permissoes: scopes };
  await ensureSchema();
  await sql.query(`INSERT INTO crm_docs (chave, valor, versao) VALUES ($1, $2::jsonb, 1)
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, versao = crm_docs.versao + 1, atualizado_em = now()`, [CHAVE, JSON.stringify(valor)]);
  _cache = { t: p.access_token, exp: Date.now() + 5 * 60000 };
  const { token, ...semToken } = valor;
  return semToken;
}

export async function apagarTokenPagina() {
  await ensureSchema();
  await sql.query('DELETE FROM crm_docs WHERE chave = $1', [CHAVE]);
  _cache = null;
}
