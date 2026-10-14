#!/usr/bin/env node
/**
 * Scraper de las Listas de Espera Quirúrgica de Astursalud.
 * =============================================================================
 * La web https://www.astursalud.es/listaesperaquirurgica es un portlet Liferay
 * (`AstursaludPortletListasEspera`) que renderiza los datos en el SERVIDOR:
 * no existe un endpoint JSON/CSV. El formulario tiene estos campos:
 *
 *   - anio        (2019 .. año actual)
 *   - mes         (Enero .. Diciembre; ojo: Diciembre = valor "0")
 *   - hospital    ("asturias" = total global, + un hospital por área sanitaria)
 *   - informacion ("espe" = por especialidades | "pat" = por patologías)
 *
 * Este script automatiza con Playwright la selección de cada combinación,
 * pulsa "Buscar", extrae las tablas HTML resultantes y las normaliza a JSON.
 *
 * Uso:
 *   cd scraper
 *   npm install
 *   npx playwright install chromium
 *   npm run scrape            # extrae todo (años/meses/hospitales/tipos)
 *   npm run probe             # sólo inspecciona el formulario y un ejemplo
 *   node scrape.mjs --headful --years 2026 --limit 5
 *
 * Salida (por defecto ../data):
 *   data/manifest.json
 *   data/<anio>.json
 */

import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeTable } from './lib/parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_BASE_URL =
  'https://www.astursalud.es/listaesperaquirurgica?p_p_id=AstursaludPortletListasEspera&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&_AstursaludPortletListasEspera_article_id=57745';

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

const TIPOS = {
  espe: 'especialidad',
  pat: 'patologia',
};

// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //
function parseArgs(argv) {
  const args = { flags: new Set(), opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const next = argv[i + 1];
      if (inline != null) args.opts[k] = inline;
      else if (next && !next.startsWith('--')) { args.opts[k] = next; i++; }
      else args.flags.add(k);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const opt = (k, d) => (args.opts[k] != null ? args.opts[k] : d);

const CONFIG = {
  baseUrl: opt('base-url', process.env.ASTURSALUD_URL || DEFAULT_BASE_URL),
  outDir: path.resolve(__dirname, opt('out', '../data')),
  headful: args.flags.has('headful'),
  probe: args.flags.has('probe'),
  force: args.flags.has('force'),
  delayMs: Number(opt('delay', 700)),
  years: (opt('years', '') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  meses: (opt('meses', '') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  limit: Number(opt('limit', 0)) || 0,
  timeout: Number(opt('timeout', 60000)),
};

const log = (...a) => console.log('[astursalud]', ...a);
const warn = (...a) => console.warn('[astursalud]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- //
// Descubrimiento del formulario
// --------------------------------------------------------------------------- //
async function readSelect(page, suffix) {
  return page.evaluate((sfx) => {
    const sel = document.querySelector(`select[name$="${sfx}"]`);
    if (!sel) return null;
    return {
      name: sel.name,
      id: sel.id,
      options: Array.from(sel.options).map((o) => ({
        value: o.value,
        label: (o.textContent || '').trim(),
        selected: o.selected,
      })),
    };
  }, suffix);
}

function mesNumero(o) {
  const byLabel = MESES[o.label.toLowerCase()];
  if (byLabel) return byLabel;
  const v = Number(o.value);
  if (Number.isFinite(v)) return v === 0 ? 12 : v;
  return null;
}

async function discover(page) {
  const anioSel = await readSelect(page, '_anio');
  const mesSel = await readSelect(page, '_mes');
  const hospSel = await readSelect(page, '_hospital');
  const infoSel = await readSelect(page, '_informacion');

  if (!anioSel || !mesSel || !hospSel || !infoSel) {
    throw new Error(
      'No se ha encontrado el formulario del portlet. ' +
        'Comprueba la URL o si Astursalud ha cambiado el portlet.',
    );
  }

  const anios = anioSel.options.filter((o) => Number.isFinite(Number(o.value))).map((o) => Number(o.value));
  const meses = mesSel.options
    .map((o) => ({ value: o.value, label: o.label, numero: mesNumero(o) }))
    .filter((m) => m.numero != null);
  const hospitales = hospSel.options
    .filter((o) => o.value !== '')
    .map((o) => ({ value: o.value, label: o.label }));
  const informaciones = infoSel.options
    .filter((o) => o.value !== '')
    .map((o) => ({ value: o.value, label: o.label, tipo: TIPOS[o.value] || o.value }));

  return { anios, meses, hospitales, informaciones };
}

// --------------------------------------------------------------------------- //
// Extracción de tablas del DOM
// --------------------------------------------------------------------------- //
async function extractTables(page) {
  return page.evaluate(() => {
    const cssPath = (el) => {
      if (!el || el.nodeType !== 1) return '';
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 5) {
        let s = cur.tagName.toLowerCase();
        if (cur.id) { s += '#' + cur.id; parts.unshift(s); break; }
        const cls = (cur.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) s += '.' + cls.join('.');
        parts.unshift(s);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    };

    const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

    const results = [];
    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      // Descarta tablas de maquetación/navegación.
      const cls = (table.getAttribute('class') || '').toLowerCase();
      if (/nav|menu|header|footer|breadcrumb|cookie/.test(cls)) continue;
      if (table.closest('header, nav, footer, #website-footer, #website-header')) continue;

      const caption = text(table.querySelector('caption'));
      const thRow = table.querySelector('thead tr');
      let headers = [];
      if (thRow) headers = Array.from(thRow.querySelectorAll('th,td')).map(text);

      const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
      const allRows = bodyRows.length ? bodyRows : Array.from(table.querySelectorAll('tr'));
      const matrix = allRows.map((tr) => Array.from(tr.querySelectorAll('th,td')).map(text));

      let rows = matrix;
      if (!headers.length && matrix.length) {
        headers = matrix[0];
        rows = matrix.slice(1);
      } else {
        // elimina la fila de encabezado si reaparece como primera fila del cuerpo
        if (rows.length && JSON.stringify(rows[0]) === JSON.stringify(headers)) rows = rows.slice(1);
      }

      const maxCols = Math.max(headers.length, ...rows.map((r) => r.length), 0);
      if (maxCols < 2) continue; // no es una tabla de datos
      if (!rows.length) continue;

      // normaliza longitudes
      headers = Array.from({ length: maxCols }, (_, i) => headers[i] || `col_${i + 1}`);
      rows = rows.map((r) => Array.from({ length: maxCols }, (_, i) => r[i] ?? ''));

      const filled = rows.filter((r) => r.some((c) => String(c).trim() !== '')).length;
      if (filled === 0) continue;

      results.push({ caption, selector: cssPath(table), headers, rows });
    }
    return results;
  });
}

// --------------------------------------------------------------------------- //
// Envío del formulario y extracción
// --------------------------------------------------------------------------- //
async function submitAndExtract(page, seleccion) {
  // (Re)localiza el formulario tras cada navegación.
  const anioEl = await page.waitForSelector('select[name$="_anio"]', { timeout: CONFIG.timeout });
  if (!anioEl) throw new Error('Formulario no disponible');

  await page.selectOption('select[name$="_anio"]', String(seleccion.anio)).catch(() => {});
  await page.selectOption('select[name$="_mes"]', seleccion.mesValue).catch(() => {});
  await page.selectOption('select[name$="_hospital"]', seleccion.ambito).catch(() => {});
  await page.selectOption('select[name$="_informacion"]', seleccion.informacion).catch(() => {});

  const button = await page.$('button[id$="_searchButton"], input[id$="_searchButton"], button[type="submit"]');

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.timeout }).catch(() => {}),
    (async () => {
      if (button) await button.click();
      else await page.evaluate(() => {
        const f = document.querySelector('form[id$="_formListasEspera"]');
        if (f) f.submit();
      });
    })(),
  ]);

  await page.waitForLoadState('networkidle', { timeout: CONFIG.timeout }).catch(() => {});
  // pequeña espera por si el render es diferido
  await sleep(300);

  return extractTables(page);
}

// --------------------------------------------------------------------------- //
// Persistencia
// --------------------------------------------------------------------------- //
async function loadState() {
  if (CONFIG.force) return { hechos: [] };
  try {
    return JSON.parse(await readFile(path.join(__dirname, '.state.json'), 'utf8'));
  } catch {
    return { hechos: [] };
  }
}
async function saveState(state) {
  await writeFile(path.join(__dirname, '.state.json'), JSON.stringify(state, null, 2));
}

async function escribirSalida(porAnio, ambitos, fuente) {
  await mkdir(CONFIG.outDir, { recursive: true });
  const generado = new Date().toISOString();
  const anios = [...porAnio.keys()].sort((a, b) => a - b);
  const columnasMap = new Map();
  const ficheros = {};
  let totalRegistros = 0;

  for (const anio of anios) {
    const registros = porAnio.get(anio).registros;
    const columnas = porAnio.get(anio).columnas;
    columnas.forEach((c) => columnasMap.set(c.clave, c));
    const doc = {
      anio,
      generado,
      fuente,
      columnas: [...columnas.values()],
      registros,
    };
    const nombre = `${anio}.json`;
    await writeFile(path.join(CONFIG.outDir, nombre), JSON.stringify(doc));
    ficheros[anio] = nombre;
    totalRegistros += registros.length;
    log(`  · ${nombre}: ${registros.length} registros`);
  }

  const manifest = {
    version: String(Date.now()),
    generado,
    fuente,
    anios,
    totalRegistros,
    tipos: ['especialidad', 'patologia'],
    ambitos,
    columnas: [...columnasMap.values()],
    ficheros,
  };
  await writeFile(path.join(CONFIG.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`Manifest escrito (${totalRegistros} registros, años: ${anios.join(', ')})`);
}

// --------------------------------------------------------------------------- //
// Main
// --------------------------------------------------------------------------- //
async function main() {
  log('Abriendo navegador…', CONFIG.headful ? '(headful)' : '(headless)');
  const browser = await chromium.launch({ headless: !CONFIG.headful });
  const context = await browser.newContext({
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const page = await context.newPage();

  const porAnio = new Map();
  const anadir = (anio, table) => {
    if (!porAnio.has(anio)) porAnio.set(anio, { registros: [], columnas: [] });
    const bucket = porAnio.get(anio);
    bucket.registros.push(...table.registros);
    const tiene = new Set(bucket.columnas.map((c) => c.clave));
    table.columnas.forEach((c) => !tiene.has(c.clave) && bucket.columnas.push(c));
  };

  try {
    log('Cargando', CONFIG.baseUrl);
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
    await page.waitForLoadState('networkidle', { timeout: CONFIG.timeout }).catch(() => {});

    const { anios, meses, hospitales, informaciones } = await discover(page);
    const ambitos = hospitales.map((h) => ({ clave: h.value, nombre: h.label }));

    log('Años:', anios.join(', '));
    log('Meses:', meses.length);
    log('Ámbitos/hospitales:', hospitales.length);
    log('Tipos:', informaciones.map((i) => `${i.value}(${i.tipo})`).join(', '));

    if (CONFIG.probe) {
      log('MODO PROBE: una única consulta de ejemplo para inspeccionar la salida.');
      const uno = {
        anio: anios[anios.length - 1],
        mesValue: meses[meses.length - 1].value,
        ambito: 'asturias' in Object.fromEntries(hospitales.map((h) => [h.value, 1])) ? 'asturias' : hospitales[0].value,
        informacion: informaciones[0].value,
      };
      log('Consulta:', JSON.stringify(uno));
      const tables = await submitAndExtract(page, uno);
      log(`Tablas encontradas: ${tables.length}`);
      console.log(JSON.stringify(tables.slice(0, 3), null, 2).slice(0, 6000));
      await browser.close();
      return;
    }

    // Construye la lista de combinaciones.
    let combos = [];
    for (const anio of anios) {
      if (CONFIG.years.length && !CONFIG.years.includes(anio)) continue;
      for (const mes of meses) {
        if (CONFIG.meses.length && !CONFIG.meses.includes(mes.numero)) continue;
        for (const hosp of hospitales) {
          for (const info of informaciones) {
            combos.push({
              anio,
              mesValue: mes.value,
              mesNum: mes.numero,
              mesLabel: mes.label,
              ambito: hosp.value,
              ambitoNombre: hosp.label,
              informacion: info.value,
              tipo: info.tipo,
              key: `${anio}-${mes.numero}-${hosp.value}-${info.tipo}`,
            });
          }
        }
      }
    }
    combos.sort((a, b) => a.anio - b.anio || a.mesNum - b.mesNum || a.ambito.localeCompare(b.ambito));

    const state = await loadState();
    const hechos = new Set(state.hechos);
    const pendientes = combos.filter((c) => CONFIG.force || !hechos.has(c.key));
    if (CONFIG.limit > 0) pendientes.length = Math.min(pendientes.length, CONFIG.limit);

    log(`Combinaciones totales: ${combos.length} · pendientes: ${pendientes.length}`);

    let ok = 0, vacias = 0, errores = 0;
    for (let i = 0; i < pendientes.length; i++) {
      const c = pendientes[i];
      const etiqueta = `[${i + 1}/${pendientes.length}] ${c.anio}-${c.mesLabel} · ${c.ambito} · ${c.tipo}`;
      try {
        const rawTables = await submitAndExtract(page, c);
        let añadido = 0;
        for (const t of rawTables) {
          const { registros, columnas } = normalizeTable(t, {
            anio: c.anio,
            mes: c.mesNum,
            ambito: c.ambito,
            ambitoNombre: c.ambitoNombre,
            tipo: c.tipo,
          });
          if (registros.length) {
            anadir(c.anio, { registros, columnas });
            añadido += registros.length;
          }
        }
        if (añadido === 0) {
          vacias++;
          warn(`${etiqueta}: sin datos (${rawTables.length} tablas)`);
        } else {
          ok++;
          log(`${etiqueta}: ${añadido} filas`);
        }
        hechos.add(c.key);
        state.hechos = [...hechos];
        if (ok % 10 === 0) await saveState(state);
      } catch (err) {
        errores++;
        warn(`${etiqueta}: ERROR -> ${err.message}`);
      }
      await sleep(CONFIG.delayMs);
    }

    await saveState(state);
    log(`Resumen -> ok: ${ok}, vacías: ${vacias}, errores: ${errores}`);

    if (porAnio.size === 0) {
      warn('No se han obtenido datos. ¿La web bloqueó la petición o cambió el formulario? Prueba --probe --headful.');
    } else {
      await escribirSalida(porAnio, ambitos, CONFIG.baseUrl);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('[astursalud] ERROR FATAL:', err);
  process.exit(1);
});
