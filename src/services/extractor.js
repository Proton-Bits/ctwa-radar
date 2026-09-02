// Tudo que sabe ler o payload cru da Evolution mora aqui.
// Se a Evolution mudar o formato, e o unico arquivo que precisa mudar.

export const digitos = (s = '') => String(s).replace(/\D/g, '');

/** Numero limpo a partir de um JID ("5514999998888@s.whatsapp.net"). */
export function telefoneDoJid(jid = '') {
  const bruto = String(jid).split('@')[0].split(':')[0];
  return digitos(bruto);
}

/** Nomes de evento chegam como MESSAGES_UPSERT ou messages.upsert. */
export function normalizarEvento(evento = '') {
  return String(evento).toLowerCase().replace(/_/g, '.');
}

/**
 * Acha o ctwa_clid numa mensagem recebida.
 * Baileys  -> message.*.contextInfo.externalAdReply.ctwaClid  (camelCase)
 * Cloud API -> data.referral.ctwa_clid                        (snake_case)
 * O contextInfo muda de lugar conforme o tipo de mensagem, por isso a cascata.
 */
export function extrairAnuncio(data) {
  if (!data) return null;
  const m = data.message ?? {};

  const ctx =
    m.extendedTextMessage?.contextInfo ??
    m.imageMessage?.contextInfo ??
    m.videoMessage?.contextInfo ??
    m.audioMessage?.contextInfo ??
    m.documentMessage?.contextInfo ??
    m.buttonsResponseMessage?.contextInfo ??
    m.listResponseMessage?.contextInfo ??
    m.contextInfo ??
    data.contextInfo ??
    data.messageContextInfo;

  const ad = ctx?.externalAdReply;
  const ref = data.referral ?? data.adReferral ?? ctx?.referral;

  const ctwaClid = ref?.ctwa_clid ?? ad?.ctwaClid ?? ctx?.ctwaClid ?? null;
  if (!ctwaClid) return null;

  return {
    ctwaClid,
    anuncioId: ref?.source_id ?? ad?.sourceId ?? null,
    origemApp: ref?.source_app ?? ad?.sourceApp ?? null,
    origemTipo: ref?.source_type ?? ad?.sourceType ?? null,
    titulo: ref?.headline ?? ad?.title ?? null,
  };
}

/** Dados uteis de uma mensagem recebida (ignora as que voce mesmo mandou). */
export function lerMensagem(body) {
  const data = Array.isArray(body?.data) ? body.data[0] : body?.data;
  if (!data || data.key?.fromMe) return null;

  const jid = data.key?.remoteJid ?? '';
  return {
    telefone: telefoneDoJid(jid),
    nome: data.pushName ?? null,
    ehGrupo: jid.endsWith('@g.us'),
    quandoUnix: Number(data.messageTimestamp) || Math.floor(Date.now() / 1000),
    anuncio: extrairAnuncio(data),
    instancia: body?.instance ?? null,
  };
}

/**
 * Entradas em grupo. A Evolution manda:
 * { event: "group-participants.update",
 *   data: { id: "1203...@g.us", action: "add", participants: [...] } }
 */
export function lerEntradaEmGrupo(body) {
  const d = body?.data ?? {};
  const acao = String(d.action ?? '').toLowerCase();
  if (!['add', 'invite', 'join'].includes(acao)) return null;

  const participantes = []
    .concat(d.participants ?? d.participant ?? [])
    .map(telefoneDoJid)
    .filter(Boolean);

  if (!participantes.length) return null;

  return {
    grupoJid: d.id ?? d.groupJid ?? d.remoteJid ?? '',
    grupoNome: d.subject ?? d.groupName ?? null,
    participantes,
    quandoUnix: Number(d.timestamp) || Math.floor(Date.now() / 1000),
    instancia: body?.instance ?? null,
  };
}
