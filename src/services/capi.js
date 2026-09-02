import { config } from '../config.js';
import { db, agora } from '../db.js';

const MAX_TENTATIVAS = 5;
const JANELA_META_SEG = 7 * 24 * 60 * 60; // event_time aceita ate 7 dias atras

/**
 * Enfileira uma conversao. O event_id e a chave de deduplicacao:
 * a Meta NAO deduplica sozinha no canal de mensagens, entao a trava e aqui.
 */
export function enfileirar({ eventId, cliqueId, ctwaClid, eventName, valor, moeda = 'BRL' }) {
  const jaExiste = db.prepare('SELECT id FROM eventos_capi WHERE event_id = ?').get(eventId);
  if (jaExiste) return { duplicado: true, id: jaExiste.id };

  const info = db
    .prepare(
      `INSERT INTO eventos_capi
       (event_id, clique_id, ctwa_clid, event_name, valor, moeda, status, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eventId,
      cliqueId ?? null,
      ctwaClid,
      eventName || config.meta.eventName,
      valor ?? null,
      valor != null ? moeda : null,
      config.meta.habilitado ? 'pendente' : 'desligado',
      agora()
    );

  return { duplicado: false, id: info.lastInsertRowid };
}

function montarPayload(evento, quandoUnix) {
  const corpo = {
    data: [
      {
        event_name: evento.event_name,
        event_time: quandoUnix,
        event_id: evento.event_id,
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: {
          whatsapp_business_account_id: config.meta.wabaId,
          ctwa_clid: evento.ctwa_clid,
        },
      },
    ],
    partner_agent: 'ctwa-radar',
  };

  if (evento.valor != null) {
    corpo.data[0].custom_data = { currency: evento.moeda || 'BRL', value: evento.valor };
  }
  if (config.meta.testEventCode) corpo.test_event_code = config.meta.testEventCode;

  return corpo;
}

/** Dispara um evento pendente. Devolve o registro atualizado. */
export async function despachar(id) {
  const evento = db.prepare('SELECT * FROM eventos_capi WHERE id = ?').get(id);
  if (!evento) return null;

  if (!config.meta.habilitado) {
    db.prepare('UPDATE eventos_capi SET status = ? WHERE id = ?').run('desligado', id);
    return { ...evento, status: 'desligado' };
  }

  // Respeita a janela de 7 dias: evento mais velho que isso a Meta recusa.
  const idade = agora() - evento.criado_em;
  const quando = idade > JANELA_META_SEG ? agora() - JANELA_META_SEG + 60 : evento.criado_em;

  const payload = montarPayload(evento, quando);
  const url = `https://graph.facebook.com/${config.meta.versao}/${config.meta.datasetId}/events`;

  let httpStatus = 0;
  let resposta = '';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.meta.token}`,
      },
      body: JSON.stringify(payload),
    });
    httpStatus = r.status;
    resposta = (await r.text()).slice(0, 1000);
  } catch (err) {
    resposta = `falha de rede: ${err.message}`;
  }

  const ok = httpStatus >= 200 && httpStatus < 300;
  db.prepare(
    `UPDATE eventos_capi
     SET status = ?, tentativas = tentativas + 1, http_status = ?,
         resposta = ?, payload = ?, enviado_em = ?
     WHERE id = ?`
  ).run(
    ok ? 'enviado' : 'erro',
    httpStatus,
    resposta,
    JSON.stringify(payload),
    ok ? agora() : null,
    id
  );

  return db.prepare('SELECT * FROM eventos_capi WHERE id = ?').get(id);
}

/** Varre a fila: pendentes primeiro, depois erros que ainda tem tentativa. */
export async function processarFila() {
  if (!config.meta.habilitado) return { processados: 0, motivo: 'CAPI_ENABLED=false' };

  const fila = db
    .prepare(
      `SELECT id FROM eventos_capi
       WHERE (status = 'pendente' OR status = 'desligado')
          OR (status = 'erro' AND tentativas < ?)
       ORDER BY id ASC LIMIT 25`
    )
    .all(MAX_TENTATIVAS);

  for (const { id } of fila) await despachar(id);
  return { processados: fila.length };
}
