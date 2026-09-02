import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// DB_PATH=:memory: e o modo dos testes. Nao pode passar por path.resolve,
// senao vira um arquivo chamado ":memory:" — nome invalido no Windows.
const emMemoria = config.dbPath === ':memory:';
if (!emMemoria) fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

export const db = new Database(emMemoria ? ':memory:' : path.resolve(config.dbPath));
if (!emMemoria) db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS cliques (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ctwa_clid     TEXT UNIQUE NOT NULL,
  telefone      TEXT,
  nome          TEXT,
  anuncio_id    TEXT,
  origem_app    TEXT,          -- facebook | instagram
  origem_tipo   TEXT,          -- ad | post
  anuncio_titulo TEXT,
  instancia     TEXT,
  clicado_em    INTEGER NOT NULL,   -- unix seconds
  status        TEXT NOT NULL DEFAULT 'aguardando', -- aguardando | entrou | perdido
  entrou_em     INTEGER,
  entrada_id    INTEGER,
  match_tipo    TEXT,          -- telefone | tempo
  criado_em     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cliques_tel    ON cliques(telefone);
CREATE INDEX IF NOT EXISTS idx_cliques_status ON cliques(status);
CREATE INDEX IF NOT EXISTS idx_cliques_data   ON cliques(clicado_em);

CREATE TABLE IF NOT EXISTS entradas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  telefone    TEXT NOT NULL,
  nome        TEXT,
  grupo_jid   TEXT NOT NULL,
  grupo_nome  TEXT,
  instancia   TEXT,
  entrou_em   INTEGER NOT NULL,
  clique_id   INTEGER,
  match_tipo  TEXT,            -- telefone | tempo | NULL (organico)
  criado_em   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entradas_tel  ON entradas(telefone);
CREATE INDEX IF NOT EXISTS idx_entradas_data ON entradas(entrou_em);

CREATE TABLE IF NOT EXISTS eventos_capi (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT UNIQUE NOT NULL,   -- chave de deduplicacao
  clique_id    INTEGER,
  ctwa_clid    TEXT,
  event_name   TEXT NOT NULL,
  valor        REAL,
  moeda        TEXT,
  status       TEXT NOT NULL,          -- pendente | enviado | erro | desligado
  tentativas   INTEGER NOT NULL DEFAULT 0,
  http_status  INTEGER,
  resposta     TEXT,
  payload      TEXT,
  criado_em    INTEGER NOT NULL,
  enviado_em   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_eventos_status ON eventos_capi(status);

-- Contador diario de mensagens recebidas x mensagens que traziam ctwa_clid.
-- E o detector do bug da Evolution: se o anuncio esta rodando e a coluna
-- com_clid fica zerada, o metadado esta sendo descartado no caminho.
CREATE TABLE IF NOT EXISTS mensagens_stat (
  dia       TEXT PRIMARY KEY,
  total     INTEGER NOT NULL DEFAULT 0,
  com_clid  INTEGER NOT NULL DEFAULT 0
);

-- Historico dos avisos disparados. E tabela, e nao variavel em memoria, porque
-- o limite de um alerta por hora precisa sobreviver a um restart do processo.
CREATE TABLE IF NOT EXISTS alertas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo       TEXT NOT NULL,          -- queda
  mensagem   TEXT NOT NULL,
  detalhe    TEXT,                   -- JSON com as taxas comparadas
  enviado_ok INTEGER NOT NULL DEFAULT 0,
  criado_em  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alertas_tipo ON alertas(tipo, criado_em);

CREATE TABLE IF NOT EXISTS webhook_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  evento    TEXT,
  instancia TEXT,
  resumo    TEXT,
  recebido_em INTEGER NOT NULL
);
`);

// Guarda so os ultimos 500 webhooks — o log e diagnostico, nao arquivo.
export function podarLog() {
  db.prepare(
    `DELETE FROM webhook_log WHERE id NOT IN (
       SELECT id FROM webhook_log ORDER BY id DESC LIMIT 500)`
  ).run();
}

export const agora = () => Math.floor(Date.now() / 1000);

export const hoje = () => new Date().toISOString().slice(0, 10);

export function contarMensagem(temClid) {
  db.prepare(
    `INSERT INTO mensagens_stat (dia, total, com_clid) VALUES (?, 1, ?)
     ON CONFLICT(dia) DO UPDATE SET total = total + 1, com_clid = com_clid + ?`
  ).run(hoje(), temClid ? 1 : 0, temClid ? 1 : 0);
}
