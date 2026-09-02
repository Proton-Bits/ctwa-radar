// Regras de negocio do matcher, contra um SQLite em memoria.
//
// config.js e db.js sao lidos no import, entao o ambiente precisa estar
// definido ANTES do primeiro import — dai o await import() em vez de estatico.
process.env.DB_PATH = ':memory:';
process.env.CAPI_ENABLED = 'false'; // trava: nenhum teste pode chamar a Meta
process.env.JANELA_ENTRADA_MIN = '30';
process.env.MATCH_POR_TEMPO = 'true';
process.env.JANELA_MATCH_TEMPO_MIN = '10';
process.env.GRUPOS_MONITORADOS = '';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { db, agora } = await import('../src/db.js');
const { enfileirar } = await import('../src/services/capi.js');
const {
  registrarClique,
  registrarEntrada,
  marcarPerdidos,
  definirNomeEntrada,
} = await import('../src/services/matcher.js');

const GRUPO = '120363000000000000@g.us';
const min = (n) => n * 60;

beforeEach(() => {
  db.exec('DELETE FROM cliques; DELETE FROM entradas; DELETE FROM eventos_capi;');
});

const clique = (extra = {}) =>
  registrarClique({
    ctwaClid: `clid-${Math.random().toString(36).slice(2)}`,
    telefone: '5514991112222',
    nome: 'Maria S.',
    anuncio: { anuncioId: '120210000000011', origemApp: 'instagram', origemTipo: 'ad', titulo: 'Kit 3 perfumes' },
    quandoUnix: agora(),
    instancia: 'promozap',
    ...extra,
  });

const entrada = (extra = {}) =>
  registrarEntrada({
    telefone: '5514991112222',
    nome: null,
    grupoJid: GRUPO,
    grupoNome: 'PromoZap VIP',
    quandoUnix: agora(),
    instancia: 'promozap',
    ...extra,
  });

const lerClique = (id) => db.prepare('SELECT * FROM cliques WHERE id = ?').get(id);
const contarEventos = () => db.prepare('SELECT COUNT(*) AS n FROM eventos_capi').get().n;

test('clique sem entrada vira perdido depois da janela', () => {
  const { clique: c } = clique({ quandoUnix: agora() - min(40) });

  assert.equal(marcarPerdidos(), 1);
  assert.equal(lerClique(c.id).status, 'perdido');
  assert.equal(contarEventos(), 0);
});

test('clique ainda dentro da janela nao vira perdido', () => {
  const { clique: c } = clique({ quandoUnix: agora() - min(5) });

  assert.equal(marcarPerdidos(), 0);
  assert.equal(lerClique(c.id).status, 'aguardando');
});

test('entrada casa com o clique por telefone', () => {
  const { clique: c } = clique({ ctwaClid: 'clid-telefone' });
  const r = entrada();

  assert.equal(r.match.matchTipo, 'telefone');

  const atualizado = lerClique(c.id);
  assert.equal(atualizado.status, 'entrou');
  assert.equal(atualizado.match_tipo, 'telefone');
  assert.equal(atualizado.entrada_id, r.entrada.id);

  const ent = db.prepare('SELECT * FROM entradas WHERE id = ?').get(r.entrada.id);
  assert.equal(ent.clique_id, c.id);

  const eventos = db.prepare('SELECT * FROM eventos_capi').all();
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].event_id, 'entrada-clid-telefone');
  assert.equal(eventos[0].ctwa_clid, 'clid-telefone');
  // CAPI_ENABLED=false: enfileira represado, nunca "pendente".
  assert.equal(eventos[0].status, 'desligado');
});

test('entrada casa por tempo quando o clique e orfao', () => {
  // Clique orfao: veio do anuncio mas ninguem mandou mensagem, entao nao ha telefone.
  const { clique: c } = clique({ ctwaClid: 'clid-orfao', telefone: '', nome: null, quandoUnix: agora() - min(3) });
  assert.equal(c.telefone, null);

  const r = entrada({ telefone: '5514997778888' });

  assert.equal(r.match.matchTipo, 'tempo');

  const atualizado = lerClique(c.id);
  assert.equal(atualizado.status, 'entrou');
  // O telefone so aparece na entrada — o casamento preenche o clique.
  assert.equal(atualizado.telefone, '5514997778888');
  assert.equal(contarEventos(), 1);
});

test('clique orfao fora da janela de tempo nao casa', () => {
  clique({ ctwaClid: 'clid-velho', telefone: '', quandoUnix: agora() - min(20) });

  const r = entrada({ telefone: '5514997778888' });

  assert.equal(r.match, null);
  assert.equal(contarEventos(), 0);
});

test('entrada sem clique nenhum fica orfa e nao gera evento', () => {
  const r = entrada({ telefone: '5514993334444' });

  assert.equal(r.match, null);

  const ent = db.prepare('SELECT * FROM entradas WHERE id = ?').get(r.entrada.id);
  assert.equal(ent.clique_id, null);
  assert.equal(ent.match_tipo, null);
  assert.equal(contarEventos(), 0);
});

test('mesmo ctwa_clid duas vezes nao duplica clique nem evento', () => {
  const quando = agora() - min(2);
  const primeiro = clique({ ctwaClid: 'clid-repetido', quandoUnix: quando });
  assert.equal(primeiro.novo, true);

  // Webhook reenviado: mesma mensagem, dados diferentes. Nao pode sobrescrever.
  const segundo = clique({ ctwaClid: 'clid-repetido', quandoUnix: agora(), telefone: '5514990000000' });
  assert.equal(segundo.novo, false);

  const linhas = db.prepare('SELECT * FROM cliques').all();
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].clicado_em, quando);
  assert.equal(linhas[0].telefone, '5514991112222');

  entrada();
  assert.equal(contarEventos(), 1);

  // A trava de dedupe e nossa: a Meta nao deduplica no canal de mensagens.
  const repetido = enfileirar({
    eventId: 'entrada-clid-repetido',
    cliqueId: linhas[0].id,
    ctwaClid: 'clid-repetido',
    eventName: 'Lead',
  });
  assert.equal(repetido.duplicado, true);
  assert.equal(contarEventos(), 1);
});

test('entrada que chega antes da mensagem casa mesmo assim', () => {
  // A pessoa entrou no grupo pelo link e so depois mandou a primeira mensagem.
  const r = entrada({ quandoUnix: agora() - min(1) });
  assert.equal(r.match, null);

  const { clique: c } = clique({ ctwaClid: 'clid-atrasado' });

  const atualizado = lerClique(c.id);
  assert.equal(atualizado.status, 'entrou');
  assert.equal(atualizado.match_tipo, 'telefone');
  assert.equal(atualizado.entrada_id, r.entrada.id);
  assert.equal(contarEventos(), 1);
});

test('casamento leva o nome do clique para a entrada', () => {
  clique({ ctwaClid: 'clid-nome', nome: 'Joana P.' });
  const r = entrada({ nome: null });

  const ent = db.prepare('SELECT * FROM entradas WHERE id = ?').get(r.entrada.id);
  assert.equal(ent.nome, 'Joana P.');
});

test('definirNomeEntrada preenche entrada e clique sem sobrescrever', () => {
  const { clique: c } = clique({ ctwaClid: 'clid-sem-nome', telefone: '', nome: null, quandoUnix: agora() - min(2) });
  const r = entrada({ telefone: '5514995556666', nome: null });
  assert.equal(r.match.matchTipo, 'tempo');

  definirNomeEntrada(r.entrada.id, 'Carla M.');

  assert.equal(db.prepare('SELECT nome FROM entradas WHERE id = ?').get(r.entrada.id).nome, 'Carla M.');
  assert.equal(lerClique(c.id).nome, 'Carla M.');

  definirNomeEntrada(r.entrada.id, 'Outro Nome');
  assert.equal(db.prepare('SELECT nome FROM entradas WHERE id = ?').get(r.entrada.id).nome, 'Carla M.');
});
