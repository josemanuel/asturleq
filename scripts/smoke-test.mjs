#!/usr/bin/env node
/**
 * Test de humo end-to-end del dashboard: levanta el servidor estático, abre la
 * página en Chromium (Playwright), comprueba que IndexedDB se llena, que los
 * filtros y gráficas se renderizan y que las interacciones funcionan.
 *   node scripts/smoke-test.mjs
 */
import { chromium } from '../scraper/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8231;
const BASE = `http://127.0.0.1:${PORT}/`;

const fallos = [];
const ok = [];
function check(nombre, cond, detalle = '') {
  (cond ? ok : fallos).push(nombre + (detalle ? ` (${detalle})` : ''));
  console.log(`${cond ? '✅' : '❌'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarServidor(intentos = 60) {
  for (let i = 0; i < intentos; i++) {
    try { const r = await fetch(BASE); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  return false;
}

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

const browser = await chromium.launch();
try {
  if (!(await esperarServidor())) throw new Error('El servidor estático no arrancó');
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const errores = [];
  page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });
  page.on('pageerror', (e) => errores.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'load' });

  // Espera a que termine la primera sincronización y se pinten los KPIs.
  await page.waitForSelector('#kpis .kpi', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#kpis .kpi').length >= 4, { timeout: 30000 });

  // 1) Estado y cabecera
  const estado = await page.textContent('#estado');
  check('estado muestra sincronización con registros', /registros/.test(estado), estado.trim().slice(0, 80));

  // 2) KPIs
  const kpis = await page.$$eval('#kpis .kpi .kpi-valor', (els) => els.map((e) => e.textContent.trim()));
  check('hay al menos 4 KPIs con valor', kpis.length >= 4 && kpis.every((v) => v && v !== ''), kpis.join(' | '));

  // 3) Filtros
  const nAnios = await page.$$eval('#filtroAnios .chip', (e) => e.length);
  const nMeses = await page.$$eval('#filtroMeses .chip', (e) => e.length);
  const nAmbitos = await page.$$eval('#filtroAmbitos .chip', (e) => e.length);
  check('8 años', nAnios === 8, String(nAnios));
  check('12 meses', nMeses === 12, String(nMeses));
  check('11 ámbitos', nAmbitos === 11, String(nAmbitos));
  const activos = await page.$$eval('#filtroAnios .chip.activo, #filtroMeses .chip.activo', (e) => e.length);
  check('por defecto hay un año activo (mes= todos)', `${activos}` !== '0', String(activos));

  // 4) Categorías (especialidades por defecto)
  const nCatEsp = await page.$$eval('#listaCategorias .cat-item', (e) => e.length);
  check('14 especialidades', nCatEsp === 14, String(nCatEsp));

  // 5) Gráficas visibles
  const chartsVisibles = await page.isVisible('#charts');
  const nCanvas = await page.$$eval('#charts canvas', (e) => e.length);
  check('sección de gráficas visible con 3 canvas', chartsVisibles && nCanvas === 3, `visible=${chartsVisibles} canvas=${nCanvas}`);

  // 6) Tabla con filas
  const filas = await page.$$eval('#tablaCont tbody tr', (e) => e.length);
  check('la tabla tiene filas', filas > 0, `${filas} filas`);

  // 7) Interacción: cambiar a Patologías
  await page.click('#tipoInfo button[data-tipo="patologia"]');
  await page.waitForFunction(() => document.querySelectorAll('#listaCategorias .cat-item').length === 20, { timeout: 5000 }).catch(() => {});
  const nCatPat = await page.$$eval('#listaCategorias .cat-item', (e) => e.length);
  check('al elegir Patologías hay 20 patologías', nCatPat === 20, String(nCatPat));
  const filasPat = await page.$$eval('#tablaCont tbody tr', (e) => e.length);
  check('la tabla se re-renderiza tras cambiar el tipo', filasPat > 0, `${filasPat} filas`);

  // 8) Interacción: ampliar a todos los años vía "todos"
  const filasAntes = filasPat;
  await page.click('#btnTodosAnios');
  await page.waitForTimeout(400);
  const filasTodos = await page.$$eval('#tablaCont tbody tr', (e) => e.length);
  check('"todos los años" mantiene filas visibles', filasTodos > 0, `antes=${filasAntes}`);

  // 9) IndexedDB poblada
  const dbInfo = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const hay = dbs.some((d) => d.name === 'astursalud_lista_espera');
    if (!hay) return { hay: false, n: 0 };
    return await new Promise((resolve) => {
      const req = indexedDB.open('astursalud_lista_espera');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('registros', 'readonly');
        const count = tx.objectStore('registros').count();
        count.onsuccess = () => resolve({ hay: true, n: count.result });
        count.onerror = () => resolve({ hay: true, n: -1 });
      };
      req.onerror = () => resolve({ hay: true, n: -1 });
    });
  });
  check('IndexedDB "astursalud_lista_espera" existe', dbInfo.hay);
  check('IndexedDB contiene 34.782 registros', dbInfo.n === 34782, `n=${dbInfo.n}`);

  // 10) Sin errores de consola
  const erroresReales = errores.filter((e) => !/favicon/i.test(e));
  check('sin errores en consola', erroresReales.length === 0, erroresReales.slice(0, 3).join(' ; '));

  await page.screenshot({ path: path.join(ROOT, 'smoke-screenshot.png'), fullPage: true });
  console.log('\n📸 Captura: smoke-screenshot.png');
} catch (e) {
  fallos.push('EXCEPCIÓN: ' + e.message);
  console.error('❌', e);
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

console.log(`\n===== RESUMEN: ${ok.length} OK, ${fallos.length} fallos =====`);
if (fallos.length) { fallos.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
