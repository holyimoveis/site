// Aviso no WhatsApp PESSOAL do Édipo a cada lead novo.
// Enquanto o WhatsApp oficial da Holy não está liberado, usa o CallMeBot (gratuito, só para o próprio número):
//   1) salve +34 623 91 22 04 nos contatos e mande "I allow callmebot to send me messages";
//   2) na Vercel crie AVISO_WHATSAPP (seu número com DDI, ex.: +5549999999999) e AVISO_CALLMEBOT_KEY (a chave que o bot respondeu).
// O aviso nunca bloqueia nada: se falhar, só registra no log.
import { linkContato } from './_contato.js';
const SITE = () => process.env.SITE_URL || 'https://www.holyimoveis.com';
let ultimo = 0;

export function avisoConfigurado() {
  return !!(process.env.AVISO_WHATSAPP && process.env.AVISO_CALLMEBOT_KEY);
}

export async function enviarAviso(texto) {
  const fone = process.env.AVISO_WHATSAPP, key = process.env.AVISO_CALLMEBOT_KEY;
  if (!fone || !key) return { ok: false, motivo: 'aviso não configurado' };
  // o CallMeBot recusa mensagens muito seguidas: espaça alguns segundos
  const espera = ultimo + 4000 - Date.now(); if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimo = Date.now();
  try {
    const url = 'https://api.callmebot.com/whatsapp.php?' + new URLSearchParams({ phone: fone, text: String(texto).slice(0, 1500), apikey: key });
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const t = await r.text().catch(() => '');
    if (!r.ok || /error|invalid/i.test(t.slice(0, 400))) { console.error('[aviso] falhou', r.status, t.slice(0, 200)); return { ok: false, motivo: 'HTTP ' + r.status }; }
    return { ok: true };
  } catch (e) { console.error('[aviso] erro', e.message); return { ok: false, motivo: e.message }; }
}

const fone = (t) => { const d = String(t || '').replace(/\D/g, ''); return d ? '+' + (d.length <= 11 ? '55' + d : d) : ''; };

export async function avisarLead(a) {
  if (!avisoConfigurado()) return;
  const wa = fone(a.telefone);
  const linhas = [
    '🔔 *Novo lead Holy*',
    '*' + (a.nome || 'Sem nome') + '*' + (a.origem ? ' · ' + a.origem : ''),
    wa ? '📱 ' + wa + '  https://wa.me/' + wa.replace('+', '') : '',
    a.email ? '✉️ ' + a.email : '',
    a.imovel ? '🏠 ' + a.imovel : '',
    a.respostas ? '📝 ' + String(a.respostas).replace(/\s*\|\s*/g, '\n• ') : '',
    a.responsavel ? '👤 Responsável: ' + a.responsavel : '',
    a.clienteId && linkContato(a.clienteId) ? '📇 Salvar contato: ' + linkContato(a.clienteId) : '',
    '➡️ ' + SITE() + '/crm',
  ].filter(Boolean);
  await enviarAviso(linhas.join('\n'));
}

// Helena: cliente novo na conversa ou conversa passada para o Édipo
export async function avisarHelena({ nome, canal, motivo, resumo, ficha, telefone, clienteId }) {
  if (!avisoConfigurado()) return;
  const wa = fone(telefone);
  await enviarAviso([
    motivo ? '🙋 *Helena passou um cliente para você*' : '💬 *Novo contato com a Helena*',
    '*' + (nome || 'Cliente') + '*' + (canal ? ' · ' + canal : ''),
    motivo ? 'Motivo: ' + motivo : '',
    wa ? '📱 ' + wa + '  https://wa.me/' + wa.replace('+', '') : '',
    resumo ? '📝 ' + resumo : '',
    ficha ? String(ficha).slice(0, 700) : '',
    wa && clienteId && linkContato(clienteId) ? '📇 Salvar contato: ' + linkContato(clienteId) : '',
    '➡️ ' + SITE() + '/crm',
  ].filter(Boolean).join('\n'));
}
