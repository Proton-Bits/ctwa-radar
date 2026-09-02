import express from 'express';
import { config } from '../../config.js';
import { router as leitura } from './leitura.js';
import { router as acoes } from './acoes.js';

export const router = express.Router();

// Autenticacao simples de servico. Enquanto DASHBOARD_TOKEN estiver vazio
// a API fica aberta (modo desenvolvimento) e o painel avisa na tela.
router.use((req, res, next) => {
  if (!config.dashboardToken) return next();
  const header = req.get('authorization') || '';
  const enviado = header.replace(/^Bearer\s+/i, '') || req.query.token;
  if (enviado !== config.dashboardToken) return res.status(401).json({ erro: 'token invalido' });
  next();
});

router.use(leitura);
router.use(acoes);
