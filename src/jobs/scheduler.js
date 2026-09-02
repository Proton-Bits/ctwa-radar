import { marcarPerdidos } from '../services/matcher.js';
import { processarFila } from '../services/capi.js';
import { verificarQueda } from './alerta-queda.js';

// Um tick por minuto resolve as duas tarefas de fundo: fechar leads perdidos
// e reprocessar eventos que a Meta recusou (ou que ficaram represados
// enquanto CAPI_ENABLED estava false).
export function iniciarScheduler() {
  const tick = async () => {
    try {
      const perdidos = marcarPerdidos();
      if (perdidos) console.log(`[scheduler] ${perdidos} lead(s) marcados como perdidos`);
      await processarFila();
    } catch (err) {
      console.error('[scheduler]', err.message);
    }
  };

  const tickAlerta = async () => {
    try {
      const r = await verificarQueda();
      if (r.disparado) console.warn(`[alerta] queda de ${r.quedaPct}% na taxa de entrada`);
    } catch (err) {
      console.error('[alerta]', err.message);
    }
  };

  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref?.();

  // Sem execucao imediata: logo depois do boot a base das 24h anteriores
  // costuma estar incompleta e o primeiro alerta sairia errado.
  const timerAlerta = setInterval(tickAlerta, 15 * 60_000);
  timerAlerta.unref?.();

  return { timer, timerAlerta };
}
