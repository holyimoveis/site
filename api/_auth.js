// Login individual e perfis do CRM (arquivos com "_" não viram rota na Vercel)
// Perfis: admin (tudo) · gerente (supervisiona a equipe) · corretor (o próprio dia a dia) · secretaria (cadastros e agenda)
// A chave mestra (ADMIN_KEY) continua funcionando como administrador, para o primeiro acesso e emergências.
import crypto from 'node:crypto';
import { sql, ensureSchema, isAdmin, atualizarDoc } from './_lib.js';

export const PERFIS = { admin: 'Administrador', gerente: 'Gerente de vendas', corretor: 'Corretor', secretaria: 'Secretária' };

// O que cada perfil pode fazer no servidor
const REGRAS = {
  'leads': ['admin', 'gerente'],                 // painel de cliques do site / leads brutos
  'meta.ver': ['admin', 'gerente'],              // status e métricas das campanhas
  'meta.publicar': ['admin', 'gerente'],         // publicar no Instagram da Holy
  'meta.campanha': ['admin'],                    // criar, ativar, pausar e investir
  'conversas': ['admin', 'gerente', 'corretor'], // corretor vê só as dos próprios clientes
  'helena.config': ['admin'],
  'ia': ['admin', 'gerente', 'corretor', 'secretaria'],
  'upload': ['admin', 'gerente', 'corretor', 'secretaria'],
  'usuarios': ['admin'],
};
export function pode(s, acao) { return !!s && (REGRAS[acao] || []).includes(s.perfil); }

function segredo() {
  return crypto.createHash('sha256').update('holy-sessao|' + (process.env.SESSION_SECRET || process.env.ADMIN_KEY || '')).digest();
}
const b64 = (b) => Buffer.from(b).toString('base64url');

export function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(senha), sal, 64);
  return 'scrypt$' + sal.toString('hex') + '$' + h.toString('hex');
}
export function confereSenha(senha, hash) {
  const [alg, sal, h] = String(hash || '').split('$');
  if (alg !== 'scrypt' || !sal || !h) return false;
  const calc = crypto.scryptSync(String(senha), Buffer.from(sal, 'hex'), 64);
  const ref = Buffer.from(h, 'hex');
  return ref.length === calc.length && crypto.timingSafeEqual(ref, calc);
}

const VALIDADE_DIAS = 30;
// Marca da senha atual dentro do token: trocar a senha derruba todas as sessões antigas daquele usuário
const marcaSenha = (h) => crypto.createHash('sha256').update('sv|' + String(h || '')).digest('base64url').slice(0, 12);
export function emitirToken(u) {
  const corpo = b64(JSON.stringify({ uid: u.id, h: marcaSenha(u.senha_hash), exp: Date.now() + VALIDADE_DIAS * 86400000 }));
  const sig = crypto.createHmac('sha256', segredo()).update(corpo).digest('base64url');
  return corpo + '.' + sig;
}
function lerToken(t) {
  const [corpo, sig] = String(t || '').split('.');
  if (!corpo || !sig) return null;
  const calc = crypto.createHmac('sha256', segredo()).update(corpo).digest('base64url');
  if (calc.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(sig))) return null;
  try { const p = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch { return null; }
}

// Quem está chamando a API: { uid, nome, email, perfil, mestre? } ou null
export async function sessao(req) {
  if (isAdmin(req)) return { uid: 'admin', nome: 'Administrador', email: '', perfil: 'admin', mestre: true };
  const p = lerToken(req.headers['x-holy-token']);
  if (!p) return null;
  await ensureSchema();
  const r = await sql.query('SELECT id, nome, email, perfil, ativo, senha_hash FROM usuarios WHERE id = $1', [p.uid]);
  const u = r[0];
  if (!u || !u.ativo || !PERFIS[u.perfil]) return null;
  if (p.h !== marcaSenha(u.senha_hash)) return null; // senha trocada (ou token antigo): pede login de novo
  return { uid: u.id, nome: u.nome, email: u.email, perfil: u.perfil };
}

// Cliente "é" do corretor quando ele é o responsável, ou quando ele cadastrou e ninguém foi designado
export function ehDoUsuario(c, uid) {
  return !!c && (c.responsavelId === uid || (!c.responsavelId && c.criadoPor === uid));
}

// Rodízio: escolhe o próximo corretor ativo para um lead novo (ou ninguém, se o rodízio estiver desligado)
export async function proximoResponsavel() {
  const cfg = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'equipe_config'");
  const c = (cfg[0] && cfg[0].valor) || {};
  if (!c.rodizio) return null;
  const us = await sql.query("SELECT id, nome FROM usuarios WHERE ativo AND perfil = 'corretor' ORDER BY criado_em");
  let fila = us;
  if (Array.isArray(c.rodizioIds) && c.rodizioIds.length) fila = us.filter((u) => c.rodizioIds.includes(u.id));
  if (!fila.length) return null;
  let escolhido = null;
  await atualizarDoc('equipe_config', (v) => {
    v = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    const i = Number.isInteger(v.rodizioPos) ? v.rodizioPos : -1;
    const prox = (i + 1) % fila.length;
    escolhido = fila[prox];
    v.rodizioPos = prox;
    return v;
  }, {});
  return escolhido ? { id: escolhido.id, nome: escolhido.nome } : null;
}
