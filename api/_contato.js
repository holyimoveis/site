// Contato de um toque: link assinado que abre o "Adicionar contato" do celular com os dados do lead (vCard).
// O link só funciona com a assinatura (ninguém consegue "chutar" outros clientes) e vale 60 dias.
import crypto from 'node:crypto';
import { sql } from './_lib.js';

const SEGREDO = () => process.env.SESSION_SECRET || process.env.ADMIN_KEY || process.env.META_APP_SECRET || '';
const b64 = (s) => Buffer.from(s).toString('base64url');
const assinatura = (tipo, dados) => crypto.createHmac('sha256', SEGREDO()).update(tipo + '|' + dados).digest('base64url').slice(0, 22);

// Token assinado genérico: tipo ('contato', 'sair'...) + id + validade em dias
export function assinarToken(tipo, id, dias) {
  if (!id || SEGREDO().length < 8) return '';
  const dados = b64(String(id)) + '.' + Math.floor(Date.now() / 1000 + dias * 86400).toString(36);
  return dados + '.' + assinatura(tipo, dados);
}
export function lerTokenTipo(tipo, t) {
  const p = String(t || '').split('.');
  if (p.length !== 3) return null;
  const dados = p[0] + '.' + p[1];
  const esperado = assinatura(tipo, dados);
  if (p[2].length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(esperado))) return null;
  if (parseInt(p[1], 36) * 1000 < Date.now()) return null;
  try { return Buffer.from(p[0], 'base64url').toString('utf8'); } catch { return null; }
}

export function linkContato(clienteId) {
  const t = assinarToken('contato', clienteId, 60);
  return t ? (process.env.SITE_URL || 'https://www.holyimoveis.com') + '/c/' + t : '';
}
const lerToken = (t) => lerTokenTipo('contato', t);

const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const fone = (t) => { const d = String(t || '').replace(/\D/g, ''); return d ? '+' + (d.length <= 11 ? '55' + d : d) : ''; };

export function montarVcard(c) {
  const nome = String(c.nome || 'Lead Holy').trim();
  const partes = nome.split(/\s+/);
  const p = c.perfilWhatsApp || {};
  const nota = [
    'Lead Holy' + (c.origem ? ' · ' + c.origem : '') + (c.createdAt ? ' · ' + c.createdAt : ''),
    String(c.obs || '').replace(/^Tel:[^|]*\|\s*/, '').replace(/\[WhatsApp\][\s\S]*/, '').trim().slice(0, 600),
    ...Object.entries(p).filter(([, v]) => v).map(([k, v]) => k.replace(/_/g, ' ') + ': ' + v),
  ].filter(Boolean).join('\n');
  return [
    'BEGIN:VCARD', 'VERSION:3.0',
    'N:' + esc(partes.slice(1).join(' ')) + ';' + esc(partes[0]) + ';;;',
    'FN:' + esc(nome),
    'ORG:' + esc('Lead Holy'),
    fone(c.celular || c.tel) ? 'TEL;TYPE=CELL:' + fone(c.celular || c.tel) : '',
    c.email ? 'EMAIL;TYPE=INTERNET:' + esc(c.email) : '',
    'NOTE:' + esc(nota),
    'END:VCARD',
  ].filter(Boolean).join('\r\n') + '\r\n';
}

export async function vcardDoToken(token) {
  const id = lerToken(token);
  if (!id) return null;
  const r = await sql.query("SELECT valor FROM crm_docs WHERE chave = 'clientes'");
  const c = (Array.isArray(r[0] && r[0].valor) ? r[0].valor : []).find((x) => x && x.id === id);
  return c ? { vcf: montarVcard(c), nome: c.nome } : null;
}
