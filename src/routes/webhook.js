import express from 'express';
import { config } from '../config.js';
import { db, agora, podarLog, contarMensagem } from '../db.js';
import { normalizarEvento, lerMensagem, lerEntradaEmGrupo } from '../services/extractor.js';
import { registrarClique, registrarEntrada, definirNomeEntrada } from '../services/matcher.js';
import { nomeDoContato } from '../services/evolution.js';

export const router = express.Router();

export const estado = { ultimoWebhook: null, ultimoClid: null };

function logar(evento, instancia, resumo) {
  db.prepare(
    'INSERT INTO webhook_log (evento, instancia, resumo, recebido_em) VALUES (?, ?, ?, ?)'
  ).run(evento ?? '?', instancia ?? null, resumo ?? '', agora());
  if (Math.random() < 0.05) podarLog();
}

// A Evolution reenvia se demorar: responde 200 primeiro, processa depois.
router.post(['/evolution', '/evolution/:instancia'], (req, res) => {
  if (config.evolution.webhookToken) {
    const enviado = req.get('x-radar-token');
    if (enviado !== config.evolution.webhookToken) return res.sendStatus(401);
  }
  res.sendStatus(200);

  try {
    processar(req.body);
  } catch (err) {
    console.error('[webhook] erro ao processar:', err.message);
  }
});

function processar(body) {
  const evento = normalizarEvento(body?.event);
  estado.ultimoWebhook = agora();

  if (evento === 'messages.upsert') {
    const msg = lerMensagem(body);
    if (!msg || msg.ehGrupo) return; // mensagem dentro do grupo nao interessa aqui

    contarMensagem(Boolean(msg.anuncio));
    if (!msg.anuncio) {
      logar(evento, msg.instancia, `mensagem de ${msg.telefone} sem ctwa_clid`);
      return;
    }

    estado.ultimoClid = agora();
    const { novo } = registrarClique({
      ctwaClid: msg.anuncio.ctwaClid,
      telefone: msg.telefone,
      nome: msg.nome,
      anuncio: msg.anuncio,
      quandoUnix: msg.quandoUnix,
      instancia: msg.instancia,
    });
    logar(evento, msg.instancia, `${novo ? 'novo clique' : 'clique ja conhecido'} · ${msg.nome ?? msg.telefone}`);
    return;
  }

  if (evento === 'group-participants.update' || evento === 'group.participants.update') {
    const entrada = lerEntradaEmGrupo(body);
    if (!entrada) return;

    for (const telefone of entrada.participantes) {
      const r = registrarEntrada({
        telefone,
        nome: null,
        grupoJid: entrada.grupoJid,
        grupoNome: entrada.grupoNome,
        quandoUnix: entrada.quandoUnix,
        instancia: entrada.instancia,
      });
      logar(
        evento,
        entrada.instancia,
        r.ignorado
          ? `entrada ignorada (${r.ignorado})`
          : `entrada de ${telefone} · ${r.match ? `match por ${r.match.matchTipo}` : 'organico'}`
      );

      // O evento de grupo so traz o JID. Se nem o clique casado tinha o nome,
      // pergunta para a Evolution — sem esperar, porque o 200 ja foi e latencia
      // aqui faz a Evolution reenviar o webhook.
      if (r.entrada && !r.entrada.nome) {
        nomeDoContato(telefone)
          .then((nome) => nome && definirNomeEntrada(r.entrada.id, nome))
          .catch(() => {}); // best-effort: sem nome o lead continua valendo
      }
    }
    return;
  }

  if (evento === 'connection.update') {
    logar(evento, body?.instance, `estado: ${body?.data?.state ?? '?'}`);
  }
}
