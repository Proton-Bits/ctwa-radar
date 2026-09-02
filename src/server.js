import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, pendencias } from './config.js';
import { router as webhookRouter } from './routes/webhook.js';
import { router as apiRouter } from './routes/v1/index.js';
import { iniciarScheduler } from './jobs/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '4mb' }));
app.disable('x-powered-by');

app.use('/webhook', webhookRouter);
app.use('/api/v1', apiRouter);
app.use('/api', apiRouter); // alias: integracoes antigas continuam funcionando
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(config.porta, () => {
  const faltando = pendencias();
  console.log(`\n  CTWA Radar em http://localhost:${config.porta}`);
  console.log(`  webhook:  POST /webhook/evolution`);
  console.log(`  CAPI:     ${config.meta.habilitado ? 'ligada' : 'DESLIGADA (so coleta)'}`);
  if (config.meta.testEventCode) console.log(`  modo teste: ${config.meta.testEventCode}`);
  if (faltando.length) console.log(`  faltam chaves no .env: ${faltando.join(', ')}`);
  console.log('');
  iniciarScheduler();
});
