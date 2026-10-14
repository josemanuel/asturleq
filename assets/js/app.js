/**
 * Dashboard de Listas de Espera Quirúrgica de Asturias.
 * Interfaz: filtros por periodo/área/especialidad-patología, KPIs, gráficas y tabla.
 * Datos: IndexedDB (offline-first) sincronizados desde `data/`.
 */
import { cargarLocal, sincronizar } from './data.js';
import { borrarTodo } from './db.js';

const MESES_CORTOS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MESES_LARGOS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const nf = new Intl.NumberFormat('es-ES');
const nf1 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const $ = (id) => document.getElementById(id);

const state = {
  registros: [],
  manifest: null,
  ultimaSync: null,
  filtros: {
    anios: new Set(),
    meses: new Set(),
    ambitos: new Set(),
    tipo: 'especialidad',
    categorias: new Set(),
    metrica: 'pacientes',
  },
  tabla: { pagina: 1, porPagina: 25, orden: { clave: 'categoria', dir: 1 }, busqueda: '' },
  charts: {},
};

const esGlobal = (r) => r.ambito === 'asturias';
const colMeta = (clave) => (state.manifest?.columnas || []).find((c) => c.clave === clave);

/** Clave de la columna "pacientes en espera" (el esquema es dinámico). */
function clavePacientes() {
  const cols = state.manifest?.columnas || [];
  const c = cols.find((c) => c.clave === 'pacientes')
    || cols.find((c) => /paciente/i.test(c.etiqueta || '') && !/6|seis|180/i.test(c.etiqueta || ''));
  return c ? c.clave : null;
}
/** Clave de la columna "espera > 6 meses", si existe. */
function claveMas6Meses() {
  const cols = state.manifest?.columnas || [];
  const c = cols.find((c) => c.clave === 'pacientesMas6Meses')
    || cols.find((c) => /(6|seis|180)/i.test(c.etiqueta || '') && /paciente|espera/i.test(c.etiqueta || ''));
  return c ? c.clave : null;
}

function metricaEsSuma(clave) {
  const col = colMeta(clave);
  if (col) return col.unidad === 'pacientes';
  return !/media|dias|d[ií]a|porcentaje|ratio|tasa|edad/i.test(clave);
}

// --------------------------------------------------------------------------- //
// Agregaciones
// --------------------------------------------------------------------------- //
function suma(records, clave) {
  let s = 0;
  for (const r of records) { const v = r.metricas?.[clave]; if (typeof v === 'number') s += v; }
  return s;
}

function ponderada(records, clave) {
  const pac = clavePacientes();
  const pesoSel = pac ? suma(records, pac) : 0;
  if (!pesoSel) {
    const vals = records.map((r) => r.metricas?.[clave]).filter((v) => typeof v === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  let acc = 0;
  for (const r of records) {
    const v = r.metricas?.[clave];
    if (typeof v === 'number') acc += v * (pac ? r.metricas?.[pac] || 0 : 0);
  }
  return acc / pesoSel;
}

function agrega(records, clave) {
  return metricaEsSuma(clave) ? suma(records, clave) : ponderada(records, clave);
}

/** Selecciona el conjunto correcto para agregar sin duplicar áreas. */
function recordsParaTotales(view) {
  const detalle = view.filter((r) => !esGlobal(r));
  const global = view.filter(esGlobal);
  if (detalle.length === 0 && global.length) return global;
  return detalle;
}

// --------------------------------------------------------------------------- //
// Filtrado
// --------------------------------------------------------------------------- //
function filtrar() {
  const f = state.filtros;
  const usarAnios = f.anios.size > 0;
  const usarMeses = f.meses.size > 0;
  const usarAmbitos = f.ambitos.size > 0;
  const usarCat = f.categorias.size > 0;
  return state.registros.filter((r) => {
    if (r.tipo !== f.tipo) return false;
    if (usarAnios && !f.anios.has(r.anio)) return false;
    if (usarMeses && !f.meses.has(r.mes)) return false;
    if (usarAmbitos && !f.ambitos.has(r.ambito)) return false;
    if (usarCat && !f.categorias.has(r.categoria)) return false;
    return true;
  });
}

// --------------------------------------------------------------------------- //
// Arranque y sincronización
// --------------------------------------------------------------------------- //
async function arrancar() {
  setEstado('Cargando…', 'loading');
  try {
    await sincronizar({ onStatus: (s) => {
      if (s.fase === 'descargando') setEstado(s.anio ? `Descargando ${s.anio}…` : 'Descargando datos…', 'loading');
      else if (s.fase === 'guardando') setEstado(`Guardando ${s.d ?? s.total} registros…`, 'loading');
    } });
  } catch (e) {
    console.warn('Sincronización fallida, se usa la caché local:', e);
  }
  const { registros, manifest, ultimaSync } = await cargarLocal();
  state.registros = registros;
  state.manifest = manifest;
  state.ultimaSync = ultimaSync;

  if (!registros.length) {
    setEstado('Sin datos. Ejecuta el scraper y vuelve a sincronizar.', 'error');
    $('avisoVacio').hidden = false;
    document.body.classList.remove('cargando');
    return;
  }
  construirControles();
  aplicarDefectos();
  render();
  document.body.classList.remove('cargando');
  actualizarCabecera();
}

function setEstado(texto, tipo) {
  const el = $('estado');
  if (!el) return;
  el.textContent = texto;
  el.dataset.tipo = tipo || '';
}

function actualizarCabecera() {
  const m = state.manifest;
  const demo = !!m?.demo;
  $('badgeDemo').hidden = !demo;
  const partes = [];
  if (state.ultimaSync) partes.push(`Última actualización local: ${new Date(state.ultimaSync).toLocaleString('es-ES')}`);
  if (m?.generado) partes.push(`Datos de: ${new Date(m.generado).toLocaleDateString('es-ES')}`);
  if (m?.totalRegistros) partes.push(`${nf.format(m.totalRegistros)} registros`);
  setEstado(partes.join(' · ') || 'Datos cargados', 'ok');
}

// --------------------------------------------------------------------------- //
// Construcción de controles
// --------------------------------------------------------------------------- //
function chip(valor, etiqueta, activo, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (activo ? ' activo' : '');
  b.textContent = etiqueta;
  b.dataset.valor = String(valor);
  b.setAttribute('aria-pressed', String(activo));
  b.addEventListener('click', onClick);
  return b;
}

function construirControles() {
  const m = state.manifest || {};
  const anios = (m.anios || [...new Set(state.registros.map((r) => r.anio))]).sort((a, b) => a - b);
  const ambitos = m.ambitos || [...new Set(state.registros.map((r) => r.ambito))].map((c) => ({ clave: c, nombre: c }));

  // Años
  const contAnios = $('filtroAnios');
  anios.forEach((anio) => contAnios.append(chip(anio, anio, false, () => toggle('anios', anio, contAnios, () => anio))));
  // Meses
  const contMeses = $('filtroMeses');
  for (let mes = 1; mes <= 12; mes++) contMeses.append(chip(mes, MESES_CORTOS[mes - 1], false, () => toggle('meses', mes, contMeses, () => mes)));
  // Ámbitos
  const contAmbitos = $('filtroAmbitos');
  ambitos.forEach((a) => contAmbitos.append(chip(a.clave, a.nombre, false, () => toggle('ambitos', a.clave, contAmbitos, () => a.clave))));
  // Métricas
  const selMetrica = $('selMetrica');
  (m.columnas || []).forEach((c) => {
    const o = document.createElement('option');
    o.value = c.clave; o.textContent = c.etiqueta + (c.unidad ? ` (${c.unidad})` : '');
    selMetrica.append(o);
  });
  if (m.columnas?.length) state.filtros.metrica = m.columnas[0].clave;

  // Eventos
  $('btnTodasAmbitos').addEventListener('click', () => setTodos('ambitos', contAmbitos, ambitos.map((a) => a.clave)));
  $('btnNingunAmbito').addEventListener('click', () => setTodos('ambitos', contAmbitos, []));
  $('btnTodosAnios').addEventListener('click', () => setTodos('anios', contAnios, anios));
  $('btnTodosMeses').addEventListener('click', () => setTodos('meses', contMeses, Array.from({ length: 12 }, (_, i) => i + 1)));
  selMetrica.addEventListener('change', () => { state.filtros.metrica = selMetrica.value; render(); });

  document.querySelectorAll('#tipoInfo button').forEach((b) => {
    b.addEventListener('click', () => {
      state.filtros.tipo = b.dataset.tipo;
      state.filtros.categorias = new Set();
      document.querySelectorAll('#tipoInfo button').forEach((x) => x.classList.toggle('activo', x === b));
      construirCategorias();
      render();
    });
  });

  $('buscarCategoria').addEventListener('input', construirCategorias);
  $('btnTodasCategorias').addEventListener('click', () => { state.filtros.categorias = new Set(); construirCategorias(); render(); });
  $('btnNingunaCategoria').addEventListener('click', () => {
    state.filtros.categorias = new Set(categoriasDisponibles());
    construirCategorias(); render();
  });

  $('btnActualizar').addEventListener('click', actualizarTodo);
  $('btnExportar').addEventListener('click', exportarCSV);
  $('buscarTabla').addEventListener('input', (e) => { state.tabla.busqueda = e.target.value.toLowerCase(); state.tabla.pagina = 1; renderTabla(filtrar()); });
  $('paginaAnt').addEventListener('click', () => { state.tabla.pagina--; renderTabla(filtrar()); });
  $('paginaSig').addEventListener('click', () => { state.tabla.pagina++; renderTabla(filtrar()); });

  construirCategorias();
  habilitarDescargaProyecto();
}

// Muestra el boton de descarga del codigo fuente (.zip) solo si esta disponible en
// el mismo origen (servidor local / previsualizacion). En GitHub Pages no existe y queda oculto.
async function habilitarDescargaProyecto() {
  try {
    const res = await fetch('asturleq-dashboard.zip', { method: 'HEAD' });
    if (res.ok) $('btnDescargaZip').hidden = false;
  } catch { /* sin servidor estatico: no se ofrece la descarga */ }
}

function toggle(setKey, valor, contenedor, getValor) {
  const set = state.filtros[setKey];
  const clave = getValor();
  if (set.has(clave)) set.delete(clave); else set.add(clave);
  const btn = contenedor.querySelector(`[data-valor="${CSS.escape(String(valor))}"]`);
  if (btn) { const on = set.has(clave); btn.classList.toggle('activo', on); btn.setAttribute('aria-pressed', String(on)); }
  render();
}

function setTodos(setKey, contenedor, valores) {
  state.filtros[setKey] = new Set(valores);
  contenedor.querySelectorAll('.chip').forEach((b) => {
    const on = state.filtros[setKey].has(setKey === 'anios' || setKey === 'meses' ? Number(b.dataset.valor) : b.dataset.valor);
    b.classList.toggle('activo', on); b.setAttribute('aria-pressed', String(on));
  });
  render();
}

function aplicarDefectos() {
  // Por defecto: el año más reciente y todos sus meses publicados.
  const anios = [...new Set(state.registros.map((r) => r.anio))].sort((a, b) => a - b);
  const ultimoAnio = anios[anios.length - 1];
  state.filtros.anios = new Set([ultimoAnio]);
  state.filtros.meses = new Set(); // vacío = todos los meses
  document.querySelectorAll('#filtroAnios .chip').forEach((b) => {
    const on = Number(b.dataset.valor) === ultimoAnio;
    b.classList.toggle('activo', on); b.setAttribute('aria-pressed', String(on));
  });
}

function categoriasDisponibles() {
  const set = new Set();
  for (const r of state.registros) if (r.tipo === state.filtros.tipo) set.add(r.categoria);
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}

function construirCategorias() {
  const cont = $('listaCategorias');
  const q = ($('buscarCategoria').value || '').toLowerCase();
  const todas = categoriasDisponibles();
  const sel = state.filtros.categorias;
  cont.innerHTML = '';
  const visibles = todas.filter((c) => !q || c.toLowerCase().includes(q));
  $('contadorCategorias').textContent = sel.size === 0 ? `Todas (${todas.length})` : `${sel.size} de ${todas.length} seleccionadas`;
  for (const cat of visibles) {
    const activo = sel.has(cat);
    const label = document.createElement('label');
    label.className = 'cat-item' + (activo ? ' activo' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = activo;
    cb.addEventListener('change', () => {
      if (cb.checked) sel.add(cat); else sel.delete(cat);
      label.classList.toggle('activo', cb.checked);
      $('contadorCategorias').textContent = sel.size === 0 ? `Todas (${todas.length})` : `${sel.size} de ${todas.length} seleccionadas`;
      render();
    });
    label.append(cb, document.createTextNode(cat));
    cont.append(label);
  }
}

// --------------------------------------------------------------------------- //
// Render
// --------------------------------------------------------------------------- //
function render() {
  const view = filtrar();
  renderKPIs(view);
  renderGraficas(view);
  renderTabla(view);
}

function renderKPIs(view) {
  const base = recordsParaTotales(view);
  const metrica = state.filtros.metrica;
  const col = colMeta(metrica);
  const tipoTxt = state.filtros.tipo === 'especialidad' ? 'especialidades' : 'patologías';
  const formatea = (v) => (metricaEsSuma(metrica) ? nf.format(Math.round(v)) : nf1.format(v));

  const kpis = [{ etiqueta: col?.etiqueta || metrica, valor: formatea(agrega(base, metrica)), sub: col?.unidad || '' }];

  const kPac = clavePacientes();
  const pacientes = kPac ? suma(base, kPac) : 0;
  if (pacientes && metrica !== kPac) {
    kpis.push({ etiqueta: 'Pacientes en espera', valor: nf.format(Math.round(pacientes)), sub: 'en el ámbito y periodo' });
  }
  const kM6 = claveMas6Meses();
  const m6 = kM6 ? suma(base, kM6) : 0;
  if (m6 && pacientes) {
    kpis.push({ etiqueta: 'Espera > 6 meses', valor: nf.format(Math.round(m6)), sub: `${nf1.format((100 * m6) / pacientes)}% del total` });
  }
  kpis.push({ etiqueta: 'Categorías', valor: nf.format(new Set(base.map((r) => r.categoria)).size), sub: tipoTxt });
  kpis.push({ etiqueta: 'Áreas incluidas', valor: nf.format(new Set(base.map((r) => r.ambito)).size), sub: 'hospitales / ámbito' });

  $('kpis').innerHTML = kpis.map((k) => `
    <div class="kpi">
      <div class="kpi-etiqueta">${esc(k.etiqueta)}</div>
      <div class="kpi-valor">${esc(k.valor)}</div>
      <div class="kpi-sub">${esc(k.sub)}</div>
    </div>`).join('');
}

function renderGraficas(view) {
  if (typeof Chart === 'undefined') { $('charts').hidden = true; return; }
  $('charts').hidden = false;
  const metrica = state.filtros.metrica;
  const col = colMeta(metrica);
  const etiqueta = col?.etiqueta || metrica;

  // 1) Evolución temporal (por año-mes)
  const detalle = view.filter((r) => !esGlobal(r));
  const global = view.filter(esGlobal);
  const periodos = [...new Set(view.map((r) => `${r.anio}-${String(r.mes).padStart(2, '0')}`))].sort();
  const serieDet = periodos.map((p) => agrega(detalle.filter((r) => `${r.anio}-${String(r.mes).padStart(2, '0')}` === p), metrica));
  const serieGlo = periodos.map((p) => { const g = global.filter((r) => `${r.anio}-${String(r.mes).padStart(2, '0')}` === p); return g.length ? agrega(g, metrica) : null; });
  const etiquetas = periodos.map((p) => { const [a, m] = p.split('-'); return `${MESES_CORTOS[Number(m) - 1]} ${a}`; });

  dibujar('chartEvolucion', 'line', {
    labels: etiquetas,
    datasets: [
      { label: 'Áreas seleccionadas', data: serieDet, borderColor: '#0b7285', backgroundColor: 'rgba(11,114,133,.15)', fill: true, tension: .3, pointRadius: etiquetas.length > 18 ? 0 : 3 },
      ...(global.length ? [{ label: 'Asturias (global)', data: serieGlo, borderColor: '#e8590c', borderDash: [6, 4], fill: false, tension: .3, pointRadius: etiquetas.length > 18 ? 0 : 3 }] : []),
    ],
  }, { plugins: { legend: { position: 'bottom' }, title: { display: true, text: `Evolución · ${etiqueta}` } }, scales: { y: { beginAtZero: true } } });

  // 2) Por área sanitaria
  const grupos = new Map();
  for (const r of view) {
    const k = r.ambito;
    if (!grupos.has(k)) grupos.set(k, { nombre: r.ambitoNombre || k, records: [], global: esGlobal(r) });
    grupos.get(k).records.push(r);
  }
  const arr = [...grupos.values()].map((g) => ({ nombre: g.nombre, valor: agrega(g.records, metrica), global: g.global }))
    .sort((a, b) => b.valor - a.valor);
  dibujar('chartAreas', 'bar', {
    labels: arr.map((a) => a.nombre.replace(/^Hospital (de |del |Universitario |Fundación )?/, 'H. ')),
    datasets: [{ label: etiqueta, data: arr.map((a) => a.valor), backgroundColor: arr.map((a) => (a.global ? '#e8590c' : '#0b7285')) }],
  }, { plugins: { legend: { display: false }, title: { display: true, text: `Por área sanitaria · ${etiqueta}` } }, indexAxis: 'y', scales: { x: { beginAtZero: true } } });

  // 3) Top categorías
  const catMap = new Map();
  for (const r of view) {
    if (esGlobal(r)) continue;
    catMap.set(r.categoria, (catMap.get(r.categoria) || []).concat(r));
  }
  const cats = [...catMap.entries()].map(([c, recs]) => ({ c, valor: agrega(recs, metrica) })).sort((a, b) => b.valor - a.valor).slice(0, 12);
  dibujar('chartCategorias', 'bar', {
    labels: cats.map((x) => x.c),
    datasets: [{ label: etiqueta, data: cats.map((x) => x.valor), backgroundColor: '#2b8a3e' }],
  }, { plugins: { legend: { display: false }, title: { display: true, text: `Top categorías · ${etiqueta}` } }, indexAxis: 'y', scales: { x: { beginAtZero: true } } });
}

function dibujar(id, tipo, data, options) {
  const canvas = $(id);
  if (!canvas) return;
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(canvas, {
    type: tipo,
    data,
    options: { responsive: true, maintainAspectRatio: false, ...options },
  });
}

function renderTabla(view) {
  const t = state.tabla;
  const metrica = state.filtros.metrica;
  const cols = state.manifest?.columnas || [];
  let filas = view.map((r) => ({
    anio: r.anio, mes: r.mes, area: r.ambitoNombre || r.ambito, categoria: r.categoria, esTotal: esGlobal(r),
    ...Object.fromEntries(cols.map((c) => [c.clave, r.metricas?.[c.clave]])),
  }));
  if (t.busqueda) filas = filas.filter((f) => `${f.area} ${f.categoria} ${f.anio} ${MESES_LARGOS[f.mes - 1]}`.toLowerCase().includes(t.busqueda));

  const { clave, dir } = t.orden;
  filas.sort((a, b) => {
    const va = a[clave], vb = b[clave];
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'es') * dir;
  });

  const total = filas.length;
  const paginas = Math.max(1, Math.ceil(total / t.porPagina));
  t.pagina = Math.min(Math.max(1, t.pagina), paginas);
  const ini = (t.pagina - 1) * t.porPagina;
  const pagina = filas.slice(ini, ini + t.porPagina);

  const thead = `<tr>
    ${th('anio', 'Año')}${th('mes', 'Mes')}${th('area', 'Área sanitaria')}${th('categoria', 'Categoría')}
    ${cols.map((c) => th(c.clave, c.etiqueta)).join('')}
  </tr>`;
  const tbody = pagina.map((f) => `<tr class="${f.esTotal ? 'fila-total' : ''}">
    <td>${f.anio}</td><td>${MESES_CORTOS[f.mes - 1]}</td><td>${esc(f.area)}</td><td>${esc(f.categoria)}</td>
    ${cols.map((c) => `<td class="num">${fmtCelda(f[c.clave], c)}</td>`).join('')}
  </tr>`).join('');

  $('tablaCont').innerHTML = `<table class="tabla">
    <thead>${thead}</thead><tbody>${tbody || `<tr><td colspan="${4 + cols.length}" class="vacio">Sin resultados</td></tr>`}</tbody></table>`;
  $('paginaInfo').textContent = `Página ${t.pagina} de ${paginas} · ${nf.format(total)} filas`;
  $('paginaAnt').disabled = t.pagina <= 1;
  $('paginaSig').disabled = t.pagina >= paginas;

  $('tablaCont').querySelectorAll('th[data-clave]').forEach((thr) => {
    thr.addEventListener('click', () => {
      const k = thr.dataset.clave;
      if (t.orden.clave === k) t.orden.dir *= -1; else t.orden = { clave: k, dir: 1 };
      renderTabla(filtrar());
    });
  });

  function th(k, label) {
    const flecha = t.orden.clave === k ? (t.orden.dir > 0 ? ' ▲' : ' ▼') : '';
    return `<th data-clave="${k}" class="ordenable">${esc(label)}${flecha}</th>`;
  }
}

function fmtCelda(v, col) {
  if (v == null || v === '') return '—';
  if (typeof v !== 'number') return esc(v);
  if (col.unidad === 'días' || /media|porcentaje/i.test(col.clave)) return nf1.format(v);
  return nf.format(v);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --------------------------------------------------------------------------- //
// Acciones
// --------------------------------------------------------------------------- //
async function actualizarTodo() {
  $('btnActualizar').disabled = true;
  const txt = $('btnActualizar').textContent;
  $('btnActualizar').textContent = 'Actualizando…';
  try {
    const res = await sincronizar({ force: true, onStatus: (s) => {
      if (s.fase === 'descargando') setEstado(s.anio ? `Descargando ${s.anio}…` : 'Buscando nuevos datos…', 'loading');
      else if (s.fase === 'guardando') setEstado(`Guardando ${s.d ?? s.total}…`, 'loading');
    } });
    const local = await cargarLocal();
    state.registros = local.registros; state.manifest = local.manifest; state.ultimaSync = local.ultimaSync;
    render(); actualizarCabecera();
    alert(res.actualizado ? `Datos actualizados (${nf.format(res.totalRegistros)} registros).` : 'No hay datos nuevos.');
  } catch (e) {
    alert('No se pudo actualizar: ' + e.message + '\n\nSi estás abriendo el archivo con file://, usa un servidor local (npm run serve).');
  } finally {
    $('btnActualizar').disabled = false; $('btnActualizar').textContent = txt;
  }
}

function exportarCSV() {
  const cols = state.manifest?.columnas || [];
  const view = filtrar();
  const cab = ['Año', 'Mes', 'Área sanitaria', 'Categoría', ...cols.map((c) => c.etiqueta)];
  const filas = view.map((r) => [
    r.anio, MESES_LARGOS[r.mes - 1], r.ambitoNombre || r.ambito, r.categoria,
    ...cols.map((c) => (r.metricas?.[c.clave] ?? '')),
  ]);
  const csv = [cab, ...filas].map((f) => f.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `lista-espera-asturias-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.addEventListener('DOMContentLoaded', arrancar);
