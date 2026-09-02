// Popula o banco com um dia de dados de exemplo, para abrir o painel e ver
// como ele se comporta antes de ter trafego real. Nao use em producao:
// os registros ficam marcados com ctwa_clid comecando em "DEMO-".
import { db, agora } from '../src/db.js';

const nomes = ['Maria S.', 'Joana P.', 'Carla M.', 'Rita A.', 'Bruna L.', 'Tati R.', 'Fernanda C.', 'Paula V.'];
const anuncios = [
  { id: '120210000000011', titulo: 'Importados a partir de R$ 89', app: 'instagram' },
  { id: '120210000000022', titulo: 'Kit 3 perfumes — frete grátis', app: 'facebook' },
  { id: '120210000000033', titulo: 'Lista VIP de promoções', app: 'instagram' },
];

const GRUPO = '120363000000000000@g.us';
const agr = agora();

db.exec("DELETE FROM cliques WHERE ctwa_clid LIKE 'DEMO-%'");
db.exec("DELETE FROM eventos_capi WHERE ctwa_clid LIKE 'DEMO-%'");
db.exec("DELETE FROM entradas WHERE telefone LIKE '5514%'");

const insClique = db.prepare(
  `INSERT INTO cliques (ctwa_clid, telefone, nome, anuncio_id, origem_app, origem_tipo,
   anuncio_titulo, instancia, clicado_em, status, entrou_em, entrada_id, match_tipo, criado_em)
   VALUES (?, ?, ?, ?, ?, 'ad', ?, 'promozap', ?, ?, ?, ?, ?, ?)`
);
const insEntrada = db.prepare(
  `INSERT INTO entradas (telefone, nome, grupo_jid, grupo_nome, instancia, entrou_em, clique_id, match_tipo, criado_em)
   VALUES (?, ?, ?, 'PromoZap Perfumes VIP', 'promozap', ?, ?, ?, ?)`
);
const insEvento = db.prepare(
  `INSERT INTO eventos_capi (event_id, clique_id, ctwa_clid, event_name, status, tentativas,
   http_status, resposta, criado_em, enviado_em)
   VALUES (?, ?, ?, 'Lead', ?, ?, ?, ?, ?, ?)`
);

let n = 0;
for (let h = 23; h >= 0; h--) {
  const quantos = 1 + Math.floor(Math.random() * 4);
  for (let i = 0; i < quantos; i++) {
    n++;
    const clicadoEm = agr - h * 3600 - Math.floor(Math.random() * 3400);
    const ad = anuncios[n % anuncios.length];
    const telefone = `55149${String(80000000 + n * 137).slice(0, 8)}`;
    const clid = `DEMO-${clicadoEm}-${n}`;
    const entrou = Math.random() < 0.62;
    const aindaNaJanela = h === 0 && Math.random() < 0.5;

    if (entrou) {
      const entrouEm = clicadoEm + 60 + Math.floor(Math.random() * 900);
      const eid = insEntrada.run(telefone, nomes[n % nomes.length], GRUPO, entrouEm, null, 'telefone', entrouEm)
        .lastInsertRowid;
      const cid = insClique.run(clid, telefone, nomes[n % nomes.length], ad.id, ad.app, ad.titulo,
        clicadoEm, 'entrou', entrouEm, eid, 'telefone', clicadoEm).lastInsertRowid;
      db.prepare('UPDATE entradas SET clique_id = ? WHERE id = ?').run(cid, eid);

      const falhou = Math.random() < 0.08;
      insEvento.run(
        `entrada-${clid}`, cid, clid,
        falhou ? 'erro' : 'enviado', falhou ? 2 : 1,
        falhou ? 400 : 200,
        falhou ? '{"error":{"message":"Invalid parameter: ctwa_clid expired"}}' : '{"events_received":1}',
        entrouEm, falhou ? null : entrouEm + 2
      );
    } else {
      insClique.run(clid, telefone, nomes[n % nomes.length], ad.id, ad.app, ad.titulo,
        clicadoEm, aindaNaJanela ? 'aguardando' : 'perdido', null, null, null, clicadoEm);
    }
  }
}

db.prepare(
  `INSERT INTO mensagens_stat (dia, total, com_clid) VALUES (?, ?, ?)
   ON CONFLICT(dia) DO UPDATE SET total = excluded.total, com_clid = excluded.com_clid`
).run(new Date().toISOString().slice(0, 10), n + 40, n);

const logar = db.prepare('INSERT INTO webhook_log (evento, instancia, resumo, recebido_em) VALUES (?, ?, ?, ?)');
for (let i = 0; i < 20; i++) {
  logar.run(
    i % 3 === 0 ? 'group-participants.update' : 'messages.upsert',
    'promozap',
    i % 3 === 0 ? `entrada de 5514998${i}0000 · match por telefone` : `novo clique · ${nomes[i % nomes.length]}`,
    agr - i * 420
  );
}

console.log(`seed pronto: ${n} cliques de exemplo. Rode "npm start" e abra o painel.`);
