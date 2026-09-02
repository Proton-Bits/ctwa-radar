// Avisa quando a taxa de entrada despenca — anuncio fora do ar, link do grupo
// quebrado, grupo cheio ou Evolution desconectada aparecem todos aqui antes
// de alguem abrir o painel.

import { config } from '../config.js';
import { db, agora } from '../db.js';
import { enviarTexto } from '../services/evolution.js';

const HORA = 3600;
const DIA = 86400;

/**
 * Taxa de entrada de uma faixa de tempo.
 *
 * So conta clique ja decidido ('entrou' ou 'perdido'). Clique 'aguardando'
 * ainda esta dentro da janela de entrada e contaria como nao-entrada,
 * derrubando a taxa recente de mentira — seria alarme falso toda hora.
 */
function taxaNaFaixa(inicio, fim) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS cliques,
              SUM(CASE WHEN status = 'entrou' THEN 1 ELSE 0 END) AS entrou
       FROM cliques
       WHERE clicado_em >= ? AND clicado_em < ?
         AND status IN ('entrou', 'perdido')`
    )
    .get(inicio, fim);

  const cliques = r.cliques ?? 0;
  const entrou = r.entrou ?? 0;
  return { cliques, entrou, taxa: cliques ? entrou / cliques : 0 };
}

/** Compara a ultima hora com as 24h anteriores. So le o banco. */
export function avaliarQueda(referencia = agora()) {
  const recente = taxaNaFaixa(referencia - HORA, referencia);
  const base = taxaNaFaixa(referencia - HORA - DIA, referencia - HORA);

  const amostraSuficiente = recente.cliques >= config.alerta.minCliques;
  const temBase = base.cliques > 0 && base.taxa > 0;
  const quedaPct = temBase ? (1 - recente.taxa / base.taxa) * 100 : 0;

  return {
    recente,
    base,
    quedaPct: temBase ? +quedaPct.toFixed(1) : 0,
    disparar: amostraSuficiente && temBase && quedaPct >= config.alerta.quedaPct,
    motivo: !amostraSuficiente
      ? `amostra pequena (${recente.cliques} de ${config.alerta.minCliques} cliques)`
      : !temBase
        ? 'sem base de comparacao nas 24h anteriores'
        : quedaPct >= config.alerta.quedaPct
          ? 'queda acima do limite'
          : 'taxa dentro do esperado',
  };
}

const pct = (n) => `${Math.round(n * 100)}%`;

function montarMensagem(a) {
  return [
    'CTWA Radar - queda na taxa de entrada',
    '',
    `Ultima hora: ${pct(a.recente.taxa)} (${a.recente.entrou} de ${a.recente.cliques} cliques)`,
    `Media das 24h anteriores: ${pct(a.base.taxa)} (${a.base.entrou} de ${a.base.cliques})`,
    `Queda de ${a.quedaPct}%.`,
    '',
    'Confira: anuncio no ar, link do grupo, conexao da Evolution.',
  ].join('\n');
}

/** Quanto tempo desde o ultimo aviso do mesmo tipo. */
function silenciado() {
  const ultimo = db
    .prepare(`SELECT criado_em FROM alertas WHERE tipo = 'queda' ORDER BY id DESC LIMIT 1`)
    .get();
  if (!ultimo) return false;
  return agora() - ultimo.criado_em < config.alerta.intervaloMin * 60;
}

/** Roda no scheduler. Decide, registra e envia. */
export async function verificarQueda() {
  const a = avaliarQueda();
  if (!a.disparar) return { ...a, disparado: false };
  if (silenciado()) return { ...a, disparado: false, motivo: 'alerta recente ainda no intervalo' };

  const mensagem = montarMensagem(a);

  // Grava antes de enviar: se o envio falhar, o registro segura o proximo
  // disparo e evita repetir o aviso a cada tick enquanto a Evolution estiver fora.
  const info = db
    .prepare(
      `INSERT INTO alertas (tipo, mensagem, detalhe, enviado_ok, criado_em)
       VALUES ('queda', ?, ?, 0, ?)`
    )
    .run(mensagem, JSON.stringify({ recente: a.recente, base: a.base, quedaPct: a.quedaPct }), agora());

  if (!config.alerta.whatsapp) {
    console.warn('[alerta] queda detectada, mas ALERTA_WHATSAPP esta vazio');
    return { ...a, disparado: true, enviado: false, motivo: 'ALERTA_WHATSAPP vazio' };
  }

  const envio = await enviarTexto(config.alerta.whatsapp, mensagem);
  db.prepare('UPDATE alertas SET enviado_ok = ? WHERE id = ?').run(envio.ok ? 1 : 0, info.lastInsertRowid);

  if (!envio.ok) console.error('[alerta] falha ao enviar:', envio.erro ?? `HTTP ${envio.status}`);

  return { ...a, disparado: true, enviado: Boolean(envio.ok) };
}
