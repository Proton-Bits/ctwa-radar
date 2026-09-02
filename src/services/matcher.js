// O coracao do radar: ligar "clicou no anuncio" com "entrou no grupo".
//
//  clique sem entrada dentro da janela  -> LEAD PERDIDO
//  clique + entrada do mesmo telefone   -> CONVERSAO (match por telefone)
//  entrada sem clique, mas logo depois
//  de um clique orfao                   -> CONVERSAO (match por tempo)
//  entrada sem nenhum clique            -> ORGANICO (nao conta para a Meta)

import { config } from '../config.js';
import { db, agora } from '../db.js';
import { enfileirar, despachar } from './capi.js';

const grupoMonitorado = (jid) =>
  config.regras.gruposMonitorados.length === 0 ||
  config.regras.gruposMonitorados.includes(jid);

/** Passo 1: a primeira mensagem vinda do anuncio. So a primeira carrega o clid. */
export function registrarClique({ ctwaClid, telefone, nome, anuncio, quandoUnix, instancia }) {
  const existente = db.prepare('SELECT * FROM cliques WHERE ctwa_clid = ?').get(ctwaClid);
  if (existente) {
    // Mensagem seguinte da mesma pessoa: nao sobrescreve, so completa o nome.
    if (!existente.nome && nome) {
      db.prepare('UPDATE cliques SET nome = ? WHERE id = ?').run(nome, existente.id);
    }
    return { novo: false, clique: existente };
  }

  const info = db
    .prepare(
      `INSERT INTO cliques
       (ctwa_clid, telefone, nome, anuncio_id, origem_app, origem_tipo,
        anuncio_titulo, instancia, clicado_em, status, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando', ?)`
    )
    .run(
      ctwaClid,
      telefone || null,
      nome || null,
      anuncio?.anuncioId ?? null,
      anuncio?.origemApp ?? null,
      anuncio?.origemTipo ?? null,
      anuncio?.titulo ?? null,
      instancia || null,
      quandoUnix,
      agora()
    );

  const clique = db.prepare('SELECT * FROM cliques WHERE id = ?').get(info.lastInsertRowid);

  // Pode ser que a pessoa ja tenha entrado no grupo antes de mandar a mensagem.
  conciliarEntradaPendente(clique);

  return { novo: true, clique };
}

/** Passo 2: alguem entrou no grupo. */
export function registrarEntrada({ telefone, nome, grupoJid, grupoNome, quandoUnix, instancia }) {
  if (!grupoMonitorado(grupoJid)) return { ignorado: 'grupo fora da lista' };

  const info = db
    .prepare(
      `INSERT INTO entradas
       (telefone, nome, grupo_jid, grupo_nome, instancia, entrou_em, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(telefone, nome || null, grupoJid, grupoNome || null, instancia || null, quandoUnix, agora());

  const entrada = db.prepare('SELECT * FROM entradas WHERE id = ?').get(info.lastInsertRowid);
  const clique = acharCliqueDaEntrada(entrada);

  if (!clique) return { entrada, match: null }; // organico

  const match = casar(clique, entrada, clique._matchTipo);

  // Reler: o casamento pode ter trazido o nome do clique para a entrada.
  return { entrada: db.prepare('SELECT * FROM entradas WHERE id = ?').get(entrada.id), match };
}

/** Acha o clique correspondente a uma entrada: telefone primeiro, tempo depois. */
function acharCliqueDaEntrada(entrada) {
  const porTelefone = db
    .prepare(
      `SELECT * FROM cliques
       WHERE telefone = ? AND status = 'aguardando'
       ORDER BY clicado_em DESC LIMIT 1`
    )
    .get(entrada.telefone);

  if (porTelefone) return { ...porTelefone, _matchTipo: 'telefone' };

  if (!config.regras.matchPorTempo) return null;

  // Ninguem mandou mensagem: procura um clique orfao (sem telefone conhecido)
  // que aconteceu poucos minutos antes desta entrada.
  const janela = config.regras.janelaMatchTempoMin * 60;
  const porTempo = db
    .prepare(
      `SELECT * FROM cliques
       WHERE status = 'aguardando'
         AND (telefone IS NULL OR telefone = '')
         AND clicado_em BETWEEN ? AND ?
       ORDER BY clicado_em DESC LIMIT 1`
    )
    .get(entrada.entrou_em - janela, entrada.entrou_em);

  return porTempo ? { ...porTempo, _matchTipo: 'tempo' } : null;
}

/** Um clique recem-registrado pode casar com uma entrada que ja aconteceu. */
function conciliarEntradaPendente(clique) {
  if (!clique.telefone) return;
  const janela = config.regras.janelaEntradaMin * 60;

  const entrada = db
    .prepare(
      `SELECT * FROM entradas
       WHERE telefone = ? AND clique_id IS NULL
         AND entrou_em BETWEEN ? AND ?
       ORDER BY entrou_em DESC LIMIT 1`
    )
    .get(clique.telefone, clique.clicado_em - janela, clique.clicado_em + janela);

  if (entrada) casar(clique, entrada, 'telefone');
}

/** Fecha o par, marca a conversao e enfileira o evento para a Meta. */
function casar(clique, entrada, matchTipo) {
  db.prepare(
    `UPDATE cliques
     SET status = 'entrou', entrou_em = ?, entrada_id = ?, match_tipo = ?,
         telefone = COALESCE(NULLIF(telefone, ''), ?),
         nome = COALESCE(nome, ?)
     WHERE id = ?`
  ).run(entrada.entrou_em, entrada.id, matchTipo, entrada.telefone, entrada.nome, clique.id);

  // O evento de entrada no grupo so traz o JID. Se o clique ja tem o pushName,
  // aproveita — evita uma consulta na Evolution para o mesmo nome.
  db.prepare(
    `UPDATE entradas SET clique_id = ?, match_tipo = ?, nome = COALESCE(NULLIF(nome, ''), ?)
     WHERE id = ?`
  ).run(clique.id, matchTipo, clique.nome, entrada.id);

  const { id, duplicado } = enfileirar({
    eventId: `entrada-${clique.ctwa_clid}`,
    cliqueId: clique.id,
    ctwaClid: clique.ctwa_clid,
    eventName: config.meta.eventName,
  });

  if (!duplicado) despachar(id).catch((e) => console.error('[capi]', e.message));

  return { cliqueId: clique.id, entradaId: entrada.id, matchTipo, eventoId: id };
}

/**
 * Nome que veio depois, da consulta de contatos da Evolution.
 * Nunca sobrescreve: o pushName da mensagem e mais confiavel que a agenda.
 */
export function definirNomeEntrada(entradaId, nome) {
  const limpo = String(nome ?? '').trim();
  if (!limpo) return false;

  const info = db
    .prepare(`UPDATE entradas SET nome = ? WHERE id = ? AND (nome IS NULL OR nome = '')`)
    .run(limpo, entradaId);

  if (!info.changes) return false;

  // Entrada casada leva o nome para o lead, que e o que o painel mostra.
  db.prepare(
    `UPDATE cliques SET nome = ?
     WHERE (nome IS NULL OR nome = '')
       AND id = (SELECT clique_id FROM entradas WHERE id = ?)`
  ).run(limpo, entradaId);

  return true;
}

/**
 * Passo 3: quem clicou, nao entrou e ja passou da janela vira lead perdido.
 * Roda no scheduler de minuto em minuto.
 */
export function marcarPerdidos() {
  const limite = agora() - config.regras.janelaEntradaMin * 60;
  const info = db
    .prepare(`UPDATE cliques SET status = 'perdido' WHERE status = 'aguardando' AND clicado_em < ?`)
    .run(limite);
  return info.changes;
}

/**
 * Gancho para o resto do funil (venda, pedido pago...).
 * O painel maior chama isso via POST /api/conversao.
 */
export function conversaoManual({ telefone, eventName, valor, moeda, eventId }) {
  const tel = String(telefone || '').replace(/\D/g, '');
  const clique = db
    .prepare(`SELECT * FROM cliques WHERE telefone = ? ORDER BY clicado_em DESC LIMIT 1`)
    .get(tel);

  if (!clique) return { erro: 'sem clique de anuncio para esse telefone' };

  const { id, duplicado } = enfileirar({
    eventId: eventId || `${eventName}-${clique.ctwa_clid}`,
    cliqueId: clique.id,
    ctwaClid: clique.ctwa_clid,
    eventName,
    valor,
    moeda,
  });

  if (!duplicado) despachar(id).catch((e) => console.error('[capi]', e.message));
  return { eventoId: id, duplicado, ctwaClid: clique.ctwa_clid };
}
