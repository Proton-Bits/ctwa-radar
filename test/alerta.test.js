// Alerta de queda. ALERTA_WHATSAPP fica vazio de proposito: assim
// verificarQueda() registra e para antes do envio, sem tocar a rede.
process.env.DB_PATH = ':memory:';
process.env.CAPI_ENABLED = 'false';
process.env.ALERTA_WHATSAPP = '';
process.env.ALERTA_QUEDA_PCT = '30';
process.env.ALERTA_MIN_CLIQUES = '10';
process.env.ALERTA_INTERVALO_MIN = '60';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { db, agora } = await import('../src/db.js');
const { avaliarQueda, verificarQueda } = await import('../src/jobs/alerta-queda.js');

const HORA = 3600;
let seq = 0;

/** Cria n cliques numa faixa de tempo, dos quais `entraram` viraram conversao. */
function semear({ quantos, entraram, deIdade, ateIdade, status }) {
  const ins = db.prepare(
    `INSERT INTO cliques (ctwa_clid, telefone, clicado_em, status, criado_em)
     VALUES (?, ?, ?, ?, ?)`
  );
  const faixa = ateIdade - deIdade;
  for (let i = 0; i < quantos; i++) {
    const quando = agora() - deIdade - Math.floor((faixa * i) / Math.max(quantos, 1));
    ins.run(`clid-${++seq}`, `5514990000${seq}`, quando, status ?? (i < entraram ? 'entrou' : 'perdido'), quando);
  }
}

const ultimaHora = (quantos, entraram, status) =>
  semear({ quantos, entraram, deIdade: 60, ateIdade: HORA - 60, status });

const vinteQuatroHorasAnteriores = (quantos, entraram) =>
  semear({ quantos, entraram, deIdade: HORA + 60, ateIdade: HORA + 86400 - 60 });

beforeEach(() => {
  db.exec('DELETE FROM cliques; DELETE FROM alertas;');
});

test('queda acima do limite dispara', () => {
  vinteQuatroHorasAnteriores(100, 60); // 60%
  ultimaHora(20, 2); // 10%

  const a = avaliarQueda();

  assert.equal(a.recente.cliques, 20);
  assert.equal(a.base.cliques, 100);
  assert.equal(a.quedaPct, 83.3);
  assert.equal(a.disparar, true);
});

test('taxa estavel nao dispara', () => {
  vinteQuatroHorasAnteriores(100, 60);
  ultimaHora(20, 12); // mesma taxa de 60%

  const a = avaliarQueda();

  assert.equal(a.quedaPct, 0);
  assert.equal(a.disparar, false);
  assert.equal(a.motivo, 'taxa dentro do esperado');
});

test('queda menor que o limite nao dispara', () => {
  vinteQuatroHorasAnteriores(100, 60); // 60%
  ultimaHora(20, 10); // 50% — queda de 16,7%

  const a = avaliarQueda();

  assert.equal(a.disparar, false);
});

test('amostra pequena nao dispara mesmo despencando', () => {
  vinteQuatroHorasAnteriores(100, 80);
  ultimaHora(5, 0); // zero entradas, mas so 5 cliques

  const a = avaliarQueda();

  assert.equal(a.disparar, false);
  assert.match(a.motivo, /amostra pequena/);
});

test('sem base nas 24h anteriores nao dispara', () => {
  ultimaHora(20, 1);

  const a = avaliarQueda();

  assert.equal(a.disparar, false);
  assert.equal(a.motivo, 'sem base de comparacao nas 24h anteriores');
});

test('clique aguardando nao entra na conta', () => {
  vinteQuatroHorasAnteriores(100, 60);
  ultimaHora(12, 8); // decididos, 66%
  ultimaHora(40, 0, 'aguardando'); // ainda dentro da janela de entrada

  const a = avaliarQueda();

  // Se os 'aguardando' contassem, a taxa recente cairia para 15% e o alerta
  // sairia toda hora sem motivo.
  assert.equal(a.recente.cliques, 12);
  assert.equal(a.disparar, false);
});

test('verificarQueda registra o alerta e segura o proximo por uma hora', async () => {
  vinteQuatroHorasAnteriores(100, 60);
  ultimaHora(20, 2);

  const primeiro = await verificarQueda();
  assert.equal(primeiro.disparado, true);
  assert.equal(primeiro.enviado, false); // ALERTA_WHATSAPP vazio
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alertas').get().n, 1);

  const registro = db.prepare("SELECT * FROM alertas WHERE tipo = 'queda'").get();
  assert.equal(registro.enviado_ok, 0);
  assert.match(registro.mensagem, /queda na taxa de entrada/);
  assert.equal(JSON.parse(registro.detalhe).quedaPct, 83.3);

  const segundo = await verificarQueda();
  assert.equal(segundo.disparado, false);
  assert.equal(segundo.motivo, 'alerta recente ainda no intervalo');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alertas').get().n, 1);
});

test('passado o intervalo, um novo alerta pode sair', async () => {
  vinteQuatroHorasAnteriores(100, 60);
  ultimaHora(20, 2);

  await verificarQueda();
  db.prepare('UPDATE alertas SET criado_em = ?').run(agora() - 61 * 60);

  const novo = await verificarQueda();
  assert.equal(novo.disparado, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM alertas').get().n, 2);
});
