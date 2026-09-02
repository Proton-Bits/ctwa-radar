// GRUPOS_MONITORADOS congela no import do config, entao este caso precisa
// de processo proprio — node --test roda um processo por arquivo.
process.env.DB_PATH = ':memory:';
process.env.CAPI_ENABLED = 'false';
process.env.GRUPOS_MONITORADOS = '120363000000000000@g.us';

import test from 'node:test';
import assert from 'node:assert/strict';

const { db, agora } = await import('../src/db.js');
const { registrarClique, registrarEntrada } = await import('../src/services/matcher.js');

test('entrada em grupo fora da lista e ignorada', () => {
  registrarClique({
    ctwaClid: 'clid-grupo',
    telefone: '5514991112222',
    nome: 'Maria S.',
    anuncio: null,
    quandoUnix: agora(),
    instancia: 'promozap',
  });

  const r = registrarEntrada({
    telefone: '5514991112222',
    nome: null,
    grupoJid: '999999999999@g.us',
    grupoNome: 'Outro grupo',
    quandoUnix: agora(),
    instancia: 'promozap',
  });

  assert.equal(r.ignorado, 'grupo fora da lista');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entradas').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM eventos_capi').get().n, 0);
  assert.equal(db.prepare('SELECT status FROM cliques').get().status, 'aguardando');
});

test('entrada no grupo monitorado casa normalmente', () => {
  registrarClique({
    ctwaClid: 'clid-grupo-ok',
    telefone: '5514993334444',
    nome: null,
    anuncio: null,
    quandoUnix: agora(),
    instancia: 'promozap',
  });

  const r = registrarEntrada({
    telefone: '5514993334444',
    nome: null,
    grupoJid: '120363000000000000@g.us',
    grupoNome: 'PromoZap VIP',
    quandoUnix: agora(),
    instancia: 'promozap',
  });

  assert.equal(r.match.matchTipo, 'telefone');
});
