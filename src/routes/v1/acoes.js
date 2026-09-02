// Rotas da API v1 que mudam estado: reenvio, fila e o gancho de conversao
// do resto do funil. Separadas da leitura porque o painel maior so consome
// leitura — isto aqui e integracao.

import express from 'express';
import { despachar, processarFila } from '../../services/capi.js';
import { conversaoManual } from '../../services/matcher.js';

export const router = express.Router();

router.post('/eventos/:id/retry', async (req, res) => {
  const evento = await despachar(Number(req.params.id));
  res.json(evento ?? { erro: 'evento nao encontrado' });
});

router.post('/fila/processar', async (_req, res) => res.json(await processarFila()));

// Gancho para o painel maior: venda fechada, pedido pago, etc.
router.post('/conversao', (req, res) => {
  const { telefone, evento, valor, moeda, eventId } = req.body ?? {};
  if (!telefone || !evento) return res.status(400).json({ erro: 'telefone e evento sao obrigatorios' });
  res.json(conversaoManual({ telefone, eventName: evento, valor, moeda, eventId }));
});
