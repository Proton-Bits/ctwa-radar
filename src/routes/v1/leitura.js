// Rotas de leitura da API v1. Tudo aqui e GET e nao muda estado —
// e o que o painel maior vai consumir. O contrato esta documentado no README.

import express from 'express';
import { config, pendencias } from '../../config.js';
import { db, agora, hoje } from '../../db.js';
import { estadoDaInstancia } from '../../services/evolution.js';
import { estado as estadoWebhook } from '../webhook.js';

export const router = express.Router();

const JANELAS = { '24h': 86400, '7d': 604800, '30d': 2592000 };
const desde = (req) => agora() - (JANELAS[req.query.periodo] ?? JANELAS['24h']);

const COLUNAS_LEAD = `id, ctwa_clid, telefone, nome, anuncio_id, anuncio_titulo, origem_app,
                      clicado_em, entrou_em, status, match_tipo`;

/** Monta a consulta de leads compartilhada por /leads e /export. */
function buscarLeads(req, limite) {
  const t = desde(req);
  const status = req.query.status;
  const filtrar = status && status !== 'todos';

  return db
    .prepare(
      `SELECT ${COLUNAS_LEAD}
       FROM cliques WHERE clicado_em >= ? ${filtrar ? 'AND status = ?' : ''}
       ORDER BY clicado_em DESC LIMIT ?`
    )
    .all(...(filtrar ? [t, status, limite] : [t, limite]));
}

router.get('/stats', (req, res) => {
  const t = desde(req);

  const funil = db
    .prepare(
      `SELECT
         COUNT(*)                                            AS cliques,
         SUM(CASE WHEN status = 'entrou'     THEN 1 ELSE 0 END) AS entrou,
         SUM(CASE WHEN status = 'perdido'    THEN 1 ELSE 0 END) AS perdido,
         SUM(CASE WHEN status = 'aguardando' THEN 1 ELSE 0 END) AS aguardando
       FROM cliques WHERE clicado_em >= ?`
    )
    .get(t);

  const eventos = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'enviado'   THEN 1 ELSE 0 END) AS enviados,
         SUM(CASE WHEN status = 'erro'      THEN 1 ELSE 0 END) AS erros,
         SUM(CASE WHEN status = 'pendente'  THEN 1 ELSE 0 END) AS pendentes,
         SUM(CASE WHEN status = 'desligado' THEN 1 ELSE 0 END) AS represados
       FROM eventos_capi WHERE criado_em >= ?`
    )
    .get(t);

  const porAnuncio = db
    .prepare(
      `SELECT COALESCE(anuncio_id, 'sem id')   AS anuncio,
              COALESCE(anuncio_titulo, '—')    AS titulo,
              COALESCE(origem_app, '—')        AS origem,
              COUNT(*)                         AS cliques,
              SUM(CASE WHEN status = 'entrou'  THEN 1 ELSE 0 END) AS entrou,
              SUM(CASE WHEN status = 'perdido' THEN 1 ELSE 0 END) AS perdido
       FROM cliques WHERE clicado_em >= ?
       GROUP BY anuncio_id ORDER BY cliques DESC LIMIT 12`
    )
    .all(t);

  const serie = db
    .prepare(
      `SELECT strftime('%Y-%m-%d %H:00', clicado_em, 'unixepoch', 'localtime') AS hora,
              COUNT(*) AS cliques,
              SUM(CASE WHEN status = 'entrou' THEN 1 ELSE 0 END) AS entrou
       FROM cliques WHERE clicado_em >= ?
       GROUP BY hora ORDER BY hora ASC`
    )
    .all(t);

  const cliques = funil.cliques ?? 0;
  const entrou = funil.entrou ?? 0;

  res.json({
    periodo: req.query.periodo ?? '24h',
    funil: { ...funil, cliques, entrou, taxaEntrada: cliques ? +(entrou / cliques * 100).toFixed(1) : 0 },
    eventos,
    porAnuncio,
    serie,
  });
});

router.get('/leads', (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 100, 500);
  res.json(buscarLeads(req, limite));
});

router.get('/entradas', (req, res) => {
  const t = desde(req);
  res.json(
    db
      .prepare(
        `SELECT id, telefone, nome, grupo_jid, grupo_nome, entrou_em, clique_id, match_tipo
         FROM entradas WHERE entrou_em >= ? ORDER BY entrou_em DESC LIMIT 200`
      )
      .all(t)
  );
});

router.get('/eventos', (_req, res) => {
  res.json(
    db
      .prepare(
        `SELECT id, event_id, event_name, ctwa_clid, valor, moeda, status,
                tentativas, http_status, resposta, criado_em, enviado_em
         FROM eventos_capi ORDER BY id DESC LIMIT 100`
      )
      .all()
  );
});

router.get('/alertas', (_req, res) => {
  res.json(
    db
      .prepare('SELECT id, tipo, mensagem, detalhe, enviado_ok, criado_em FROM alertas ORDER BY id DESC LIMIT 50')
      .all()
  );
});

/* ── exportacao CSV ─────────────────────────────── */

const dataBr = (unix) =>
  unix
    ? new Date(unix * 1000)
        .toLocaleString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
        .replace(', ', ' ')
    : '';

/**
 * Campo CSV. O prefixo com aspa simples nao e enfeite: `nome` vem do pushName
 * do WhatsApp, texto livre, e o Excel executa celula que comeca com = + - @.
 */
function campo(valor) {
  let s = valor == null ? '' : String(valor);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/export', (req, res) => {
  const leads = buscarLeads(req, 10000);

  const cabecalho = [
    'id', 'ctwa_clid', 'telefone', 'nome', 'anuncio_id', 'anuncio_titulo',
    'origem', 'clicado_em', 'entrou_em', 'status', 'match_tipo',
  ];

  const linhas = leads.map((l) =>
    [
      l.id, l.ctwa_clid, l.telefone, l.nome, l.anuncio_id, l.anuncio_titulo,
      l.origem_app, dataBr(l.clicado_em), dataBr(l.entrou_em), l.status, l.match_tipo,
    ].map(campo).join(';')
  );

  // BOM + separador ";": abre direto no Excel pt-BR, com acento e colunas certas.
  const csv = '﻿' + [cabecalho.join(';'), ...linhas].join('\r\n') + '\r\n';
  const nome = `leads-${req.query.periodo ?? '24h'}-${hoje()}.csv`;

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${nome}"`);
  res.send(csv);
});

router.get('/health', async (_req, res) => {
  const msgs = db.prepare('SELECT * FROM mensagens_stat WHERE dia = ?').get(hoje()) ?? {
    total: 0,
    com_clid: 0,
  };
  const instancia = await estadoDaInstancia();

  res.json({
    ok: true,
    capiHabilitada: config.meta.habilitado,
    modoTeste: Boolean(config.meta.testEventCode),
    chavesFaltando: pendencias(),
    ultimoWebhook: estadoWebhook.ultimoWebhook,
    ultimoClid: estadoWebhook.ultimoClid,
    instancia,
    mensagensHoje: { total: msgs.total, comClid: msgs.com_clid },
    regras: config.regras,
  });
});

router.get('/log', (_req, res) => {
  res.json(db.prepare('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 60').all());
});
