// Carrega .env sem dependencia externa (Node 20+ tem --env-file, mas
// aqui fazemos manual para funcionar igual em qualquer forma de start).
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const linha of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const limpa = linha.trim();
    if (!limpa || limpa.startsWith('#')) continue;
    const i = limpa.indexOf('=');
    if (i === -1) continue;
    const chave = limpa.slice(0, i).trim();
    const valor = limpa.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(chave in process.env)) process.env[chave] = valor;
  }
}

const bool = (v, padrao = false) =>
  v === undefined || v === '' ? padrao : ['1', 'true', 'sim', 'yes'].includes(String(v).toLowerCase());

const num = (v, padrao) => (v === undefined || v === '' ? padrao : Number(v));

const lista = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  porta: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH || './data/radar.db',
  dashboardToken: process.env.DASHBOARD_TOKEN || '',

  evolution: {
    url: (process.env.EVOLUTION_URL || '').replace(/\/$/, ''),
    apiKey: process.env.EVOLUTION_API_KEY || '',
    instancia: process.env.EVOLUTION_INSTANCE || '',
    webhookToken: process.env.EVOLUTION_WEBHOOK_TOKEN || '',
  },

  meta: {
    datasetId: process.env.META_DATASET_ID || '',
    token: process.env.META_ACCESS_TOKEN || '',
    wabaId: process.env.META_WABA_ID || '',
    versao: process.env.META_GRAPH_VERSION || 'v25.0',
    testEventCode: process.env.META_TEST_EVENT_CODE || '',
    eventName: process.env.META_EVENT_NAME || 'Lead',
    habilitado: bool(process.env.CAPI_ENABLED, false),
  },

  regras: {
    gruposMonitorados: lista(process.env.GRUPOS_MONITORADOS),
    janelaEntradaMin: num(process.env.JANELA_ENTRADA_MIN, 30),
    matchPorTempo: bool(process.env.MATCH_POR_TEMPO, true),
    janelaMatchTempoMin: num(process.env.JANELA_MATCH_TEMPO_MIN, 10),
  },

  alerta: {
    whatsapp: (process.env.ALERTA_WHATSAPP || '').replace(/\D/g, ''),
    quedaPct: num(process.env.ALERTA_QUEDA_PCT, 30),
    minCliques: num(process.env.ALERTA_MIN_CLIQUES, 10),
    intervaloMin: num(process.env.ALERTA_INTERVALO_MIN, 60),
  },
};

// Diz o que ainda falta preencher — aparece no boot e no /api/health,
// para o painel nao ficar mentindo que esta tudo certo.
export function pendencias() {
  const faltando = [];
  if (!config.dashboardToken) faltando.push('DASHBOARD_TOKEN');
  if (!config.evolution.url) faltando.push('EVOLUTION_URL');
  if (!config.evolution.apiKey) faltando.push('EVOLUTION_API_KEY');
  if (!config.evolution.instancia) faltando.push('EVOLUTION_INSTANCE');
  if (!config.meta.datasetId) faltando.push('META_DATASET_ID');
  if (!config.meta.token) faltando.push('META_ACCESS_TOKEN');
  if (!config.meta.wabaId) faltando.push('META_WABA_ID');
  return faltando;
}
