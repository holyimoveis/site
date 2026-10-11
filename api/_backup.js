// 🛡️ Backup diário do banco (Neon) para um armazenamento PRIVADO da Vercel Blob, fora do Neon.
// Conexão: na Vercel, crie um Blob Store PRIVADO e conecte ao projeto com o prefixo "BACKUP"
// (cria BACKUP_BLOB_READ_WRITE_TOKEN ou BACKUP_BLOB_STORE_ID). Guarda os últimos 30 backups.
import zlib from 'node:zlib';
import { put, list, del, get } from '@vercel/blob';
import { sql } from './_lib.js';
import { enviarAviso } from './_avisos.js';

const PASTA = 'holy-backup/';
const MANTER = 30;

function acesso() {
  const token = process.env.BACKUP_BLOB_READ_WRITE_TOKEN, storeId = process.env.BACKUP_BLOB_STORE_ID;
  if (token) return { token };
  if (storeId) return { storeId };
  return null;
}
export const backupConfigurado = () => !!acesso();

export async function listarBackups() {
  const a = acesso();
  if (!a) return [];
  const out = [];
  let cursor;
  do {
    const r = await list(Object.assign({ prefix: PASTA, limit: 1000, cursor }, a));
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out.sort((x, y) => new Date(y.uploadedAt) - new Date(x.uploadedAt))
    .map((b) => ({ pathname: b.pathname, tamanho: b.size, criado: b.uploadedAt, url: b.url }));
}

export async function fazerBackup(motivo = 'diario') {
  const a = acesso();
  if (!a) return { ok: false, erro: 'Armazenamento privado de backup não conectado.' };
  const t0 = Date.now();
  try {
    const tabs = await sql.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    const dados = {}, contagem = {};
    for (const { table_name: n } of tabs) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(n)) continue;
      const linhas = await sql.query(`SELECT * FROM "${n}"`);
      dados[n] = linhas; contagem[n] = linhas.length;
    }
    const json = JSON.stringify({ versao: 1, sistema: 'Holy Intelligence CRM', criado: new Date().toISOString(), motivo, contagem, dados });
    const gz = zlib.gzipSync(Buffer.from(json), { level: 9 });
    const nome = PASTA + 'holy-backup-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (motivo === 'manual' ? '-manual' : '') + '.json.gz';
    await put(nome, gz, Object.assign({ access: 'private', contentType: 'application/gzip', addRandomSuffix: false, allowOverwrite: true }, a));
    // Guarda só os mais recentes
    const todos = await listarBackups();
    const velhos = todos.slice(MANTER).map((b) => b.url);
    if (velhos.length) await del(velhos, a).catch((e) => console.error('[backup] limpeza', e.message));
    const r = { ok: true, arquivo: nome, tamanho: gz.length, tabelas: Object.keys(contagem).length, linhas: Object.values(contagem).reduce((s, n) => s + n, 0), ms: Date.now() - t0 };
    console.log('[backup] ok', JSON.stringify(r));
    return r;
  } catch (e) {
    console.error('[backup] falhou', e);
    await enviarAviso('⚠️ Holy CRM: o backup automático do banco FALHOU (' + String(e.message || e).slice(0, 200) + '). Abra o CRM › Configurações › Backup e tente "Fazer backup agora".').catch(() => {});
    return { ok: false, erro: String(e.message || e) };
  }
}

export async function baixarBackup(pathname) {
  const a = acesso();
  if (!a) return null;
  const p = String(pathname || '');
  if (!p.startsWith(PASTA) || p.includes('..') || !/^[\w\-/.]+$/.test(p)) return null;
  const r = await get(p, Object.assign({ access: 'private', useCache: false }, a));
  if (!r || !r.stream) return null;
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}
