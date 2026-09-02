// Consultas de leitura na Evolution: estado da instancia e nome do contato.
// Tudo best-effort — se a Evolution estiver fora, o radar segue coletando webhook.
import { config } from '../config.js';

const cabecalhos = () => ({ apikey: config.evolution.apiKey, 'Content-Type': 'application/json' });

async function chamar(caminho, { metodo = 'GET', corpo, timeoutMs = 6000 } = {}) {
  if (!config.evolution.url || !config.evolution.apiKey) {
    return { ok: false, erro: 'Evolution nao configurada' };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${config.evolution.url}${caminho}`, {
      method: metodo,
      headers: cabecalhos(),
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: ctrl.signal,
    });
    const resposta = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, corpo: resposta };
  } catch (err) {
    return { ok: false, erro: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(t);
  }
}

const pegar = (caminho, timeoutMs) => chamar(caminho, { timeoutMs });

export async function estadoDaInstancia() {
  const r = await pegar(`/instance/connectionState/${config.evolution.instancia}`);
  if (!r.ok) return { conectada: false, detalhe: r.erro ?? `HTTP ${r.status}` };
  const estado = r.corpo?.instance?.state ?? r.corpo?.state ?? 'desconhecido';
  return { conectada: estado === 'open', estado };
}

export async function nomeDoGrupo(jid) {
  const r = await pegar(`/group/findGroupInfos/${config.evolution.instancia}?groupJid=${jid}`);
  return r.ok ? r.corpo?.subject ?? null : null;
}

/**
 * Nome de quem entrou no grupo. O evento de participantes so traz o JID,
 * entao quando a mensagem nao trouxe pushName a agenda da instancia e a
 * unica fonte. Falhou, devolve null e o lead segue sem nome.
 */
export async function nomeDoContato(telefone) {
  const digitos = String(telefone ?? '').replace(/\D/g, '');
  if (!digitos) return null;

  const r = await chamar(`/chat/findContacts/${config.evolution.instancia}`, {
    metodo: 'POST',
    corpo: { where: { id: `${digitos}@s.whatsapp.net` } },
  });
  if (!r.ok) return null;

  // A resposta ja veio como array em algumas versoes e dentro de .contacts em outras.
  const lista = Array.isArray(r.corpo) ? r.corpo : r.corpo?.contacts ?? [];
  const c = lista[0];
  const nome = c?.pushName ?? c?.name ?? c?.verifiedName ?? null;

  return nome ? String(nome).trim() || null : null;
}

/** Envia texto pela propria instancia. Usado pelo alerta de queda. */
export async function enviarTexto(numero, texto) {
  const digitos = String(numero ?? '').replace(/\D/g, '');
  if (!digitos) return { ok: false, erro: 'numero vazio' };

  return chamar(`/message/sendText/${config.evolution.instancia}`, {
    metodo: 'POST',
    corpo: { number: digitos, text: texto },
    timeoutMs: 10000,
  });
}
