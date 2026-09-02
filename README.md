# CTWA Radar

Monitor de leads de anúncios Click-to-WhatsApp. Ele responde a única pergunta que o
Gerenciador de Anúncios não responde: **quem clicou no anúncio e realmente entrou no grupo
— e quem clicou e sumiu no caminho.**

```
anúncio ──clique──▶ WhatsApp ──1ª mensagem──▶ Evolution ──webhook──▶ Radar
                                                                      │
                        entrada no grupo ──webhook──────────────────▶ casa por telefone
                                                                      │
                                                          ┌───────────┴───────────┐
                                                     entrou = conversão      não entrou
                                                          │                      │
                                                    evento na CAPI          lead perdido
```

## O que ele faz

- Captura o `ctwa_clid` na primeira mensagem vinda do anúncio (Baileys ou Cloud API).
- Escuta `group-participants.update` e registra quem entrou no grupo, com nome e número.
- Casa as duas pontas: por telefone (alta confiança) ou por proximidade de horário
  (para quem entra no grupo sem nunca mandar mensagem).
- Busca o nome de quem entrou no grupo: primeiro no clique já casado, senão na agenda da
  própria instância. Best-effort — falhou, o lead segue sem nome.
- Clique sem entrada dentro da janela vira **lead perdido** — o número que interessa.
- Devolve a conversão para a API de Conversões da Meta, com deduplicação por `event_id`,
  retentativa automática e trava de segurança para você validar antes de postar.
- Avisa no WhatsApp quando a taxa de entrada despenca.
- Painel web em `/` e API REST em `/api/v1/*` para o painel maior consumir depois.

## Subindo

```bash
cp .env.example .env      # preencha as chaves
npm install
npm test                  # regras do matcher e do alerta, em SQLite na memoria
npm run seed              # opcional: dados de exemplo para ver o painel funcionando
npm start                 # http://localhost:3000
```

Os testes não tocam a rede nem o banco de produção: rodam com `DB_PATH=:memory:` e
`CAPI_ENABLED=false`.

Com Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

## Ligando na Evolution

Aponte o webhook da instância para o radar, com os dois eventos que importam:

```bash
curl -X POST "$EVOLUTION_URL/webhook/set/$EVOLUTION_INSTANCE" \
  -H "apikey: $EVOLUTION_API_KEY" -H 'Content-Type: application/json' \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://seu-radar.com/webhook/evolution",
      "byEvents": false,
      "events": ["MESSAGES_UPSERT", "GROUP_PARTICIPANTS_UPDATE", "CONNECTION_UPDATE"]
    }
  }'
```

## Ordem de ativação (não pule)

1. Suba com `CAPI_ENABLED=false`. O radar só coleta e mostra no painel.
2. Rode um anúncio de verdade e confirme no painel que o `ctwa_clid` está chegando.
   Se o card de aviso disser que nenhuma mensagem trouxe `ctwa_clid`, o problema está
   na Evolution descartando o `contextInfo` — resolva isso antes de seguir.
3. Preencha `META_TEST_EVENT_CODE` e ligue `CAPI_ENABLED=true`. Confira os eventos
   chegando na aba "Testar eventos" do Gerenciador de Eventos.
4. Apague o `META_TEST_EVENT_CODE`. Agora é produção.

## Alerta de queda

A cada 15 minutos o radar compara a taxa de entrada da última hora com a média das 24 h
anteriores. Caindo mais que `ALERTA_QUEDA_PCT` (padrão 30%), com pelo menos
`ALERTA_MIN_CLIQUES` (padrão 10) na amostra recente, ele manda um aviso no WhatsApp pela
própria Evolution para o número em `ALERTA_WHATSAPP`. No máximo um aviso a cada
`ALERTA_INTERVALO_MIN` (padrão 60 min).

Só entram na conta cliques já decididos (`entrou` ou `perdido`). Clique `aguardando` ainda
está dentro da janela de entrada — se contasse, seria alarme falso de hora em hora.

Cada disparo fica na tabela `alertas`, o que faz o limite de um por hora sobreviver a
restart. `ALERTA_WHATSAPP` vazio registra o alerta sem enviar.

## API para o painel maior

A API mora em **`/api/v1/*`**. `/api/*` continua servindo o mesmo router como alias, para
não quebrar integrações antigas. Todas as rotas aceitam `Authorization: Bearer
$DASHBOARD_TOKEN` ou `?token=`; com `DASHBOARD_TOKEN` vazio a API fica aberta (modo
desenvolvimento) e o painel avisa na tela.

Convenções do contrato:

- **Timestamps** são unix em **segundos** (inteiro), nunca milissegundos. `null` quando não
  aconteceu.
- `status` de clique: `aguardando` \| `entrou` \| `perdido`.
- `match_tipo`: `telefone` \| `tempo` \| `null` (entrada orgânica).
- `status` de evento: `pendente` \| `enviado` \| `erro` \| `desligado` (represado por
  `CAPI_ENABLED=false`).
- `periodo` aceita `24h` \| `7d` \| `30d`; qualquer outro valor cai em `24h`.

### `GET /stats?periodo=`

```jsonc
{
  "periodo": "24h",                                   // string
  "funil":  { "cliques": 63, "entrou": 41, "perdido": 22, "aguardando": 0,
              "taxaEntrada": 65.1 },                  // todos number; taxa em %, 1 casa
  "eventos": { "enviados": 35, "erros": 3, "pendentes": 0, "represados": 0 },  // number|null
  "porAnuncio": [                                     // array, no máximo 12, ordenado por cliques
    { "anuncio": "120210000000011",                   // string ("sem id" quando ausente)
      "titulo": "Kit 3 perfumes", "origem": "instagram",
      "cliques": 24, "entrou": 15, "perdido": 9 }
  ],
  "serie": [                                          // uma linha por hora com clique
    { "hora": "2026-09-02 14:00", "cliques": 5, "entrou": 3 }  // hora local, "YYYY-MM-DD HH:00"
  ]
}
```

### `GET /leads?periodo=&status=&limite=`

`status` aceita um dos valores de clique ou `todos` (padrão). `limite` vai até 500 (padrão 100).
Devolve um **array** ordenado por `clicado_em` desc:

```jsonc
{ "id": 63,                          // number
  "ctwa_clid": "IwAR0...",           // string, único
  "telefone": "5514991112222",       // string só dígitos | null
  "nome": "Paula V.",                // string | null
  "anuncio_id": "120210000000011",   // string | null
  "anuncio_titulo": "Kit 3 perfumes",// string | null
  "origem_app": "instagram",         // "instagram" | "facebook" | null
  "clicado_em": 1788369549,          // number (unix s)
  "entrou_em": 1788370449,           // number | null
  "status": "entrou",
  "match_tipo": "telefone" }
```

### `GET /entradas?periodo=`

Array (máx. 200) das entradas no grupo, casadas ou orgânicas:
`{ id, telefone, nome, grupo_jid, grupo_nome, entrou_em, clique_id, match_tipo }` —
`clique_id` é `number | null` (null = orgânico, não conta para a Meta).

### `GET /eventos`

Array (máx. 100, id desc) do log de envios para a Meta:
`{ id, event_id, event_name, ctwa_clid, valor, moeda, status, tentativas, http_status,
resposta, criado_em, enviado_em }`. `event_id` é a chave de deduplicação (UNIQUE);
`valor` é `number | null`, `http_status` é `number | null`.

### `GET /alertas`

Array (máx. 50) do histórico de avisos de queda:
`{ id, tipo, mensagem, detalhe, enviado_ok, criado_em }`. `detalhe` é uma **string JSON**
com `{ recente, base, quedaPct }`; `enviado_ok` é `0 | 1`.

### `GET /export?periodo=&status=`

Os mesmos leads do `/leads`, em CSV, até 10.000 linhas. Separador `;` e BOM UTF-8 — abre
direto no Excel pt-BR. Datas em `dd/mm/aaaa hh:mm` (fuso do processo, via `TZ`). Colunas:
`id;ctwa_clid;telefone;nome;anuncio_id;anuncio_titulo;origem;clicado_em;entrou_em;status;match_tipo`.

```bash
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  -o leads.csv "https://seu-radar.com/api/v1/export?periodo=7d&status=perdido"
```

### `GET /health`

`{ ok, capiHabilitada, modoTeste, chavesFaltando[], ultimoWebhook, ultimoClid, instancia,
mensagensHoje: { total, comClid }, regras }`. `ultimoWebhook` e `ultimoClid` são unix em
segundos ou `null` — é o detector do bug do `ctwa_clid`: mensagem entrando e `comClid`
zerado significa que a Evolution está descartando o `contextInfo`.

### `GET /log`

Array (máx. 60) dos últimos webhooks recebidos: `{ id, evento, instancia, resumo, recebido_em }`.
Diagnóstico, não arquivo — o radar só guarda os últimos 500.

### `POST /eventos/:id/retry`

Reenvia um evento recusado. Devolve o registro atualizado de `eventos_capi`.

### `POST /conversao`

Gancho do resto do funil: `{ telefone, evento, valor?, moeda?, eventId? }`. Devolve
`{ eventoId, duplicado, ctwaClid }` ou `{ erro }`. Venda fechada no CRM vira `Purchase`
atribuído ao anúncio certo:

```bash
curl -X POST https://seu-radar.com/api/v1/conversao \
  -H "Authorization: Bearer $DASHBOARD_TOKEN" -H 'Content-Type: application/json' \
  -d '{"telefone":"5514991112222","evento":"Purchase","valor":289.90,"eventId":"pedido-8842"}'
```

### `POST /fila/processar`

Força uma varredura da fila da CAPI. Com `CAPI_ENABLED=false` devolve
`{ processados: 0, motivo: "CAPI_ENABLED=false" }` sem postar nada.

## Estrutura

```
src/
  config.js              lê o .env e diz quais chaves faltam
  db.js                  schema SQLite (cliques, entradas, eventos_capi, alertas, log)
  routes/webhook.js      recebe a Evolution, responde 200 na hora
  routes/v1/index.js     token + composição da API
  routes/v1/leitura.js   os GET: stats, leads, entradas, eventos, alertas, export, health, log
  routes/v1/acoes.js     os POST: retry, fila, conversão
  routes/api.js          alias de /api para o mesmo router
  services/extractor.js  todo o parsing do payload cru da Evolution
  services/matcher.js    a regra de negócio: casar clique com entrada
  services/capi.js       fila, dedupe, retry e POST na Meta
  services/evolution.js  estado da instância, nome do contato, envio de texto
  jobs/scheduler.js      tick de 1 min: fecha perdidos, reprocessa fila
  jobs/alerta-queda.js   tick de 15 min: compara a taxa e avisa no WhatsApp
test/                    node:test contra SQLite em memória (npm test)
public/                  painel (HTML + CSS + JS, sem build)
```

## Trocar SQLite por Postgres

Só `src/db.js` conhece o banco. As queries são SQL padrão, exceto o `strftime` da série
por hora em `routes/api.js` e o `ON CONFLICT` do contador — os dois têm equivalente direto
em Postgres (`to_char` e `ON CONFLICT DO UPDATE`).
