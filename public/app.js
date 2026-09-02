// Painel do CTWA Radar. Sem framework, sem build: e um arquivo so.
// Quando isso for embutido no painel maior, o que interessa e a API REST
// em /api/* — este arquivo vira referencia de como consumir.

const estado = {
  periodo: '24h',
  status: 'todos',
  token: lerToken(),
};

function lerToken() {
  try {
    return sessionStorage.getItem('radar_token') || '';
  } catch {
    return '';
  }
}

function guardarToken(t) {
  try { sessionStorage.setItem('radar_token', t); } catch { /* modo privado */ }
  estado.token = t;
}

async function api(caminho) {
  const sep = caminho.includes('?') ? '&' : '?';
  const url = `/api/v1${caminho}${estado.token ? `${sep}token=${encodeURIComponent(estado.token)}` : ''}`;
  const r = await fetch(url);
  if (r.status === 401) {
    const t = prompt('Token do painel (DASHBOARD_TOKEN do .env):');
    if (t) { guardarToken(t); return api(caminho); }
    throw new Error('sem token');
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const hora = (unix) =>
  unix ? new Date(unix * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const horaCurta = (unix) =>
  unix ? new Date(unix * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const telFormatado = (t) => {
  const d = String(t ?? '').replace(/\D/g, '');
  if (d.length < 12) return d || '—';
  return `+${d.slice(0, 2)} (${d.slice(2, 4)}) ${d.slice(4, -4)}-${d.slice(-4)}`;
};

/* ── saude e avisos ─────────────────────────────── */
function pintarSaude(h) {
  const alvo = document.getElementById('saude');
  const minutos = (u) => (u ? Math.round((Date.now() / 1000 - u) / 60) : null);
  const desdeWebhook = minutos(h.ultimoWebhook);

  const itens = [
    h.instancia?.conectada
      ? { cls: 'ok', txt: 'Evolution conectada' }
      : { cls: 'warn', txt: `Evolution: ${esc(h.instancia?.estado ?? h.instancia?.detalhe ?? 'sem resposta')}` },
    desdeWebhook === null
      ? { cls: 'hold', txt: 'nenhum webhook ainda' }
      : { cls: desdeWebhook > 60 ? 'hold' : 'ok', txt: `último webhook há ${desdeWebhook} min` },
    h.capiHabilitada
      ? { cls: h.modoTeste ? 'hold' : 'ok', txt: h.modoTeste ? 'CAPI em modo teste' : 'CAPI ligada' }
      : { cls: 'hold', txt: 'CAPI desligada (só coleta)' },
  ];

  alvo.innerHTML = itens.map((i) => `<span class="dot ${i.cls}"><i></i>${i.txt}</span>`).join('');

  const avisos = [];
  if (h.chavesFaltando?.length) {
    avisos.push(`<div class="aviso"><div><b>Faltam chaves no .env</b><p>${h.chavesFaltando.map(esc).join(', ')} — o radar coleta, mas não consegue postar na Meta.</p></div></div>`);
  }
  if (h.mensagensHoje?.total > 5 && h.mensagensHoje.comClid === 0) {
    avisos.push(`<div class="aviso"><div><b>Nenhuma mensagem trouxe ctwa_clid hoje</b><p>${h.mensagensHoje.total} mensagens recebidas e zero com metadado de anúncio. Ou não há anúncio rodando, ou a Evolution está descartando o <code>contextInfo</code> — o bug conhecido. Confira o payload cru no log.</p></div></div>`);
  }
  if (h.capiHabilitada && h.modoTeste) {
    avisos.push(`<div class="aviso info"><div><b>Modo teste ativo</b><p>Os eventos vão para a aba "Testar eventos" e não entram nos dados de produção. Apague <code>META_TEST_EVENT_CODE</code> quando validar.</p></div></div>`);
  }
  document.getElementById('avisos').innerHTML = avisos.join('');
}

/* ── KPIs ───────────────────────────────────────── */
function pintarKpis(s) {
  const f = s.funil;
  const cartoes = [
    { rot: 'cliques no anúncio', val: f.cliques, sub: 'primeira mensagem com ctwa_clid', cls: '' },
    { rot: 'entraram no grupo', val: f.entrou, sub: 'conversão confirmada', cls: 'ok' },
    { rot: 'leads perdidos', val: f.perdido, sub: `clicou e não entrou em ${s.janela ?? ''}`.trim(), cls: 'warn' },
    { rot: 'aguardando', val: f.aguardando, sub: 'ainda dentro da janela', cls: 'hold' },
    { rot: 'taxa de entrada', val: `${f.taxaEntrada}%`, sub: `${s.eventos.enviados ?? 0} evento(s) na Meta`, cls: '' },
  ];

  document.getElementById('kpis').innerHTML = cartoes
    .map(
      (c) => `<article class="kpi ${c.cls}">
        <span class="rot">${c.rot}</span>
        <span class="val">${c.val ?? 0}</span>
        <span class="sub">${esc(c.sub)}</span>
      </article>`
    )
    .join('');
}

/* ── grafico ────────────────────────────────────── */
function pintarGrafico(serie) {
  const svg = document.getElementById('grafico');
  const L = 44, R = 12, T = 14, B = 30, W = 900, H = 220;
  const dados = serie.slice(-24);

  if (!dados.length) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--muted)" font-size="14" font-family="IBM Plex Sans, sans-serif">sem dados no período</text>`;
    return;
  }

  const max = Math.max(4, ...dados.map((d) => d.cliques));
  const passo = (W - L - R) / dados.length;
  const larg = Math.min(26, passo * 0.62);
  const y = (v) => H - B - (v / max) * (H - T - B);

  const ticks = [0, Math.round(max / 2), max]
    .map(
      (v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>
              <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="var(--muted)" font-size="11" font-family="IBM Plex Mono, monospace">${v}</text>`
    )
    .join('');

  const barras = dados
    .map((d, i) => {
      const x = L + i * passo + (passo - larg) / 2;
      const hc = H - B - y(d.cliques);
      const he = H - B - y(d.entrou ?? 0);
      const rotulo = d.hora.slice(11, 16);
      const mostrar = dados.length <= 12 || i % 3 === 0;
      return `
        <rect x="${x}" y="${y(d.cliques)}" width="${larg}" height="${Math.max(hc, 1)}" rx="3" fill="var(--accent)" opacity="0.28"/>
        <rect x="${x}" y="${y(d.entrou ?? 0)}" width="${larg}" height="${Math.max(he, 0)}" rx="3" fill="var(--ok)"/>
        ${mostrar ? `<text x="${x + larg / 2}" y="${H - 10}" text-anchor="middle" fill="var(--muted)" font-size="10.5" font-family="IBM Plex Mono, monospace">${rotulo}</text>` : ''}
      `;
    })
    .join('');

  svg.innerHTML = ticks + barras;
}

/* ── tabelas ────────────────────────────────────── */
function pintarLeads(leads) {
  const tb = document.getElementById('tbLeads');
  document.getElementById('vazioLeads').hidden = leads.length > 0;
  document.getElementById('hintLeads').textContent = `${leads.length} no período`;

  tb.innerHTML = leads
    .map(
      (l) => `<tr>
        <td>
          <div class="nome">${esc(l.nome || 'sem nome')}</div>
          <div class="tel">${telFormatado(l.telefone)}</div>
        </td>
        <td>${esc(l.anuncio_titulo || l.anuncio_id || '—')}</td>
        <td>${esc(l.origem_app || '—')}</td>
        <td class="num">${hora(l.clicado_em)}</td>
        <td class="num">${hora(l.entrou_em)}</td>
        <td>
          <span class="pill ${l.status}">${l.status}</span>
          ${l.match_tipo ? `<div class="tag-match">match: ${esc(l.match_tipo)}</div>` : ''}
        </td>
        <td><code>${esc(String(l.ctwa_clid).slice(0, 14))}…</code></td>
      </tr>`
    )
    .join('');
}

function pintarEventos(eventos) {
  const tb = document.getElementById('tbEventos');
  document.getElementById('vazioEventos').hidden = eventos.length > 0;

  tb.innerHTML = eventos
    .map(
      (e) => `<tr>
        <td><b>${esc(e.event_name)}</b><div class="tel">${esc(e.event_id)}</div></td>
        <td><span class="pill ${e.status}">${e.status}</span></td>
        <td class="num">${e.http_status ?? '—'}</td>
        <td class="num">${e.tentativas}</td>
        <td class="num">${hora(e.enviado_em || e.criado_em)}</td>
        <td>${e.status === 'erro' ? `<button class="btn" data-retry="${e.id}">reenviar</button>` : ''}</td>
      </tr>`
    )
    .join('');

  tb.querySelectorAll('[data-retry]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'enviando…';
      await fetch(`/api/v1/eventos/${b.dataset.retry}/retry?token=${encodeURIComponent(estado.token)}`, { method: 'POST' });
      carregar();
    })
  );
}

function pintarAnuncios(lista) {
  const tb = document.getElementById('tbAnuncios');
  document.getElementById('vazioAnuncios').hidden = lista.length > 0;

  tb.innerHTML = lista
    .map((a) => {
      const taxa = a.cliques ? Math.round((a.entrou / a.cliques) * 100) : 0;
      return `<tr>
        <td><b>${esc(a.titulo)}</b><div class="tel">${esc(a.anuncio)}</div></td>
        <td class="num">${a.cliques}</td>
        <td class="num">${a.entrou}</td>
        <td class="num"><span class="pill ${taxa >= 50 ? 'entrou' : taxa >= 25 ? 'aguardando' : 'perdido'}">${taxa}%</span></td>
      </tr>`;
    })
    .join('');
}

function pintarLog(linhas) {
  document.getElementById('log').innerHTML = linhas
    .map(
      (l) => `<div><time>${horaCurta(l.recebido_em)}</time><span>${esc(l.resumo || l.evento)}</span></div>`
    )
    .join('');
}

/* ── ciclo ──────────────────────────────────────── */
async function carregar() {
  try {
    const [saude, stats, leads, eventos, log] = await Promise.all([
      api('/health'),
      api(`/stats?periodo=${estado.periodo}`),
      api(`/leads?periodo=${estado.periodo}&status=${estado.status}`),
      api('/eventos'),
      api('/log'),
    ]);

    stats.janela = `${saude.regras?.janelaEntradaMin ?? 30} min`;
    pintarSaude(saude);
    pintarKpis(stats);
    pintarGrafico(stats.serie);
    pintarAnuncios(stats.porAnuncio);
    pintarLeads(leads);
    pintarEventos(eventos);
    pintarLog(log);

    document.getElementById('atualizado').textContent =
      `atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
  } catch (err) {
    document.getElementById('atualizado').textContent = `falha ao atualizar: ${err.message}`;
  }
}

document.querySelectorAll('.periodo button').forEach((b) =>
  b.addEventListener('click', () => {
    estado.periodo = b.dataset.periodo;
    document.querySelectorAll('.periodo button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    carregar();
  })
);

document.querySelectorAll('.filtros button').forEach((b) =>
  b.addEventListener('click', () => {
    estado.status = b.dataset.status;
    document.querySelectorAll('.filtros button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    carregar();
  })
);

carregar();
setInterval(carregar, 15000);
