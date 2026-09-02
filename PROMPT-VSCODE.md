# Prompt para o VS Code

Cole o bloco abaixo no chat do agente (Claude Code / Copilot) com a pasta `ctwa-radar`
aberta no VS Code.

---

Você vai trabalhar no projeto **CTWA Radar**, que já está nesta pasta e já roda.
Leia `README.md` e `src/services/matcher.js` antes de mexer em qualquer coisa.

## O que o sistema faz

Monitora leads de anúncios Click-to-WhatsApp (Meta) que caem num grupo de WhatsApp
operado por uma instância da Evolution API:

1. A primeira mensagem vinda do anúncio traz o `ctwa_clid`. O radar captura e guarda,
   junto com telefone, nome e id do anúncio.
2. Quando alguém entra no grupo (`group-participants.update`, action `add`), o radar
   casa a entrada com o clique — por telefone, ou por proximidade de horário quando a
   pessoa entrou sem nunca ter mandado mensagem.
3. Casou = conversão: enfileira e posta um evento na API de Conversões da Meta
   (`action_source: business_messaging`, `messaging_channel: whatsapp`).
4. Clicou e não entrou dentro da janela = **lead perdido**, que é a métrica principal
   do painel.

Stack: Node 22, Express 5, better-sqlite3, painel em HTML/CSS/JS puro em `public/`.
Sem build step, sem framework de front. Mantenha assim.

## Regras que não podem ser quebradas

- **Nenhuma chave hardcoded.** Tudo vem de `src/config.js`, que lê o `.env`.
  Qualquer variável nova entra também no `.env.example`, com comentário do que é.
- **O webhook responde 200 antes de processar.** A Evolution reenvia se demorar.
- **Só a primeira mensagem carrega o `ctwa_clid`** — nunca sobrescreva um clique
  já gravado para o mesmo `ctwa_clid`.
- **Deduplicação é responsabilidade nossa.** A Meta não deduplica no canal de mensagens.
  O `event_id` é a trava, e `eventos_capi.event_id` é UNIQUE. Não relaxe isso.
- **`CAPI_ENABLED=false` significa coletar sem postar.** Nenhum caminho de código pode
  furar essa trava.
- Todo parsing de payload cru da Evolution fica em `src/services/extractor.js`.
  Não espalhe `data.message.extendedTextMessage...` pelo resto do código.
- Comentário só onde explica *por que*, não *o que*. Código e comentários em pt-BR,
  sem acento em nome de variável.

## Tarefas, nesta ordem

1. **Testes do matcher.** Crie `test/matcher.test.js` usando `node:test` e um SQLite
   em memória. Cubra: clique sem entrada vira perdido depois da janela; entrada casa
   por telefone; entrada casa por tempo quando o clique é órfão; entrada sem clique
   nenhum fica órfã sem gerar evento; mesmo `ctwa_clid` duas vezes não duplica evento.
   Adicione `"test": "node --test"` no package.json.

2. **Persistir nome do lead.** Hoje a entrada no grupo chega só com o JID. Quando não
   houver nome vindo da mensagem, busque em `src/services/evolution.js` (endpoint de
   contatos da Evolution) e salve em `entradas.nome`. Best-effort: falhou, segue sem nome.

3. **Alerta de queda.** Um job novo que, a cada 15 min, compara a taxa de entrada da
   última hora com a média das 24h anteriores. Caindo mais de 30% com pelo menos 10
   cliques na amostra, dispara um aviso. Comece mandando uma mensagem no WhatsApp pela
   própria Evolution (`POST /message/sendText/{instancia}`) para um número em
   `ALERTA_WHATSAPP` no `.env`. Não dispare mais de um alerta por hora.

4. **Exportação CSV.** `GET /api/export?periodo=&status=` devolvendo os leads em CSV,
   com o mesmo token das outras rotas.

5. **Preparar para o painel maior.** Extraia as rotas de leitura para um router
   versionado `/api/v1/*`, mantendo `/api/*` funcionando como alias. Documente no README
   o contrato de cada rota (campos e tipos), porque o painel maior vai consumir isso.

Não faça deploy, não mexa em `.env`, e não invente integração com serviço que não está
no `.env.example`. Ao terminar cada tarefa, rode `npm test` e me diga o que mudou.

---

## Se preferir que ele reconstrua do zero

Troque tudo acima por:

> Construa uma plataforma de monitoramento de leads de anúncios Click-to-WhatsApp:
> Node 22 + Express 5 + better-sqlite3, painel em HTML/CSS/JS puro, sem build step.
> Ela recebe webhooks de uma Evolution API (`MESSAGES_UPSERT` e
> `GROUP_PARTICIPANTS_UPDATE`), extrai o `ctwa_clid` de
> `message.*.contextInfo.externalAdReply.ctwaClid` (Baileys) ou de `data.referral.ctwa_clid`
> (Cloud API), guarda o clique com telefone e nome, e casa esse clique com a entrada da
> pessoa no grupo — por telefone, ou por proximidade de horário quando o clique é órfão.
> Casou, vira conversão e é postada na API de Conversões da Meta em
> `POST https://graph.facebook.com/v25.0/{DATASET_ID}/events`, com
> `action_source: "business_messaging"`, `messaging_channel: "whatsapp"` e
> `user_data: { whatsapp_business_account_id, ctwa_clid }`; a deduplicação por `event_id`
> é nossa, a Meta não faz. Clique sem entrada dentro de uma janela configurável vira
> "lead perdido", que é o número principal do painel. Todas as credenciais vêm de um
> `.env` com `.env.example` documentado, e uma trava `CAPI_ENABLED` permite rodar
> coletando sem postar nada na Meta. Exponha `/api/stats`, `/api/leads`, `/api/eventos`
> e `/api/health` protegidas por token, porque um painel maior vai consumir depois.
