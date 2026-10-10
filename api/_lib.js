// Funções compartilhadas da API (arquivos com "_" não viram rota na Vercel)
import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const sql = globalThis.__HOLY_TEST_SQL__ || (DB_URL ? neon(DB_URL) : null);

let ready = null;
export function ensureSchema() {
  if (!sql) return Promise.reject(new Error('DB_NAO_CONFIGURADO'));
  if (!ready) {
    ready = (async () => {
      await sql.query(`CREATE TABLE IF NOT EXISTS empreendimentos (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          publicado BOOLEAN NOT NULL DEFAULT true,
          ordem INT NOT NULL DEFAULT 0,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
          atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
      // Dados do CRM (imoveis, clientes, timeline...) guardados como documentos com controle de versão
      await sql.query(`CREATE TABLE IF NOT EXISTS crm_docs (
          chave TEXT PRIMARY KEY,
          valor JSONB NOT NULL,
          versao INT NOT NULL DEFAULT 1,
          atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await sql.query(`CREATE TABLE IF NOT EXISTS crm_historico (
          id BIGSERIAL PRIMARY KEY,
          chave TEXT NOT NULL,
          valor JSONB NOT NULL,
          versao INT NOT NULL,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await sql.query(`CREATE TABLE IF NOT EXISTS leads (
          id BIGSERIAL PRIMARY KEY,
          tipo TEXT NOT NULL,
          nome TEXT, email TEXT, telefone TEXT,
          interesse TEXT, mensagem TEXT,
          origem TEXT, pagina TEXT, imovel TEXT,
          etapa TEXT NOT NULL DEFAULT 'Novo lead',
          sincronizado BOOLEAN NOT NULL DEFAULT false,
          ip_hash TEXT,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
          atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await sql.query(`CREATE INDEX IF NOT EXISTS leads_criado_idx ON leads (criado_em DESC)`);
      // WhatsApp: conversas e mensagens do assistente
      await sql.query(`CREATE TABLE IF NOT EXISTS wa_conversas (
          wa_id TEXT PRIMARY KEY,
          nome TEXT,
          cliente_id TEXT,
          pausado BOOLEAN NOT NULL DEFAULT false,
          motivo TEXT,
          aguardando BOOLEAN NOT NULL DEFAULT false,
          ultima_msg TIMESTAMPTZ NOT NULL DEFAULT now(),
          ultima_cliente TIMESTAMPTZ,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await sql.query(`CREATE TABLE IF NOT EXISTS wa_mensagens (
          id BIGSERIAL PRIMARY KEY,
          wa_id TEXT NOT NULL,
          wamid TEXT UNIQUE,
          papel TEXT NOT NULL,
          texto TEXT NOT NULL,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await sql.query(`CREATE INDEX IF NOT EXISTS wa_msg_idx ON wa_mensagens (wa_id, id DESC)`);
      // Usuários do CRM (login individual por perfil)
      await sql.query(`CREATE TABLE IF NOT EXISTS usuarios (
          id TEXT PRIMARY KEY,
          nome TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          perfil TEXT NOT NULL,
          senha_hash TEXT NOT NULL,
          ativo BOOLEAN NOT NULL DEFAULT true,
          ultimo_acesso TIMESTAMPTZ,
          criado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key, X-Holy-Token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

// Só o CRM (que conhece a ADMIN_KEY) pode gravar/editar/apagar
export function isAdmin(req) {
  const key = process.env.ADMIN_KEY || '';
  const got = String(req.headers['x-admin-key'] || '');
  if (key.length < 12) return false;
  const a = Buffer.from(key), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function body(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  if (Buffer.isBuffer(b)) { try { b = JSON.parse(b.toString('utf8')); } catch { b = {}; } }
  return b && typeof b === 'object' ? b : {};
}

export const ok = (res, obj = {}, code = 200) => res.status(code).json({ success: true, ...obj });
export const err = (res, code, msg) => res.status(code).json({ success: false, error: msg });

export function fail(res, e) {
  if (e && e.message === 'DB_NAO_CONFIGURADO') return err(res, 503, 'Banco de dados não conectado. Veja o LEIA-ME, passo 3.');
  console.error(e);
  return err(res, 500, 'Erro interno no servidor.');
}

export function cleanId(v) {
  return String(v ?? '').trim().slice(0, 80).replace(/[^\w\-]/g, '-');
}
export function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}
export function ipHash(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'desconhecido';
  return crypto.createHash('sha256').update(ip + (process.env.ADMIN_KEY || 'holy')).digest('hex').slice(0, 24);
}
export const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

// Atualiza um documento do CRM pelo servidor (ex.: o assistente do WhatsApp cadastrando clientes),
// com controle de versão: se o CRM salvar ao mesmo tempo, tenta de novo sobre a versão nova.
export async function atualizarDoc(chave, fn, padrao = []) {
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const r = await sql.query('SELECT valor, versao FROM crm_docs WHERE chave = $1', [chave]);
    const atual = r[0] ? r[0].valor : padrao;
    const versao = r[0] ? r[0].versao : 0;
    const novo = await fn(JSON.parse(JSON.stringify(atual)));
    if (novo === undefined) return atual;
    const json = JSON.stringify(novo);
    let ok;
    if (!versao) {
      ok = await sql.query(`INSERT INTO crm_docs (chave, valor, versao) VALUES ($1, $2::jsonb, 1) ON CONFLICT (chave) DO NOTHING RETURNING versao`, [chave, json]);
    } else {
      await sql.query('INSERT INTO crm_historico (chave, valor, versao) VALUES ($1, $2::jsonb, $3)', [chave, JSON.stringify(atual), versao]);
      // guarda só as 30 últimas cópias por documento (antes crescia sem fim a cada gravação automática)
      if (Math.random() < 0.2) await sql.query('DELETE FROM crm_historico WHERE chave = $1 AND id NOT IN (SELECT id FROM crm_historico WHERE chave = $1 ORDER BY id DESC LIMIT 30)', [chave]).catch(() => null);
      ok = await sql.query(`UPDATE crm_docs SET valor = $2::jsonb, versao = versao + 1, atualizado_em = now() WHERE chave = $1 AND versao = $3 RETURNING versao`, [chave, json, versao]);
    }
    if (ok.length) return novo;
  }
  throw new Error('Não foi possível salvar ' + chave + ' (muitas alterações simultâneas).');
}
