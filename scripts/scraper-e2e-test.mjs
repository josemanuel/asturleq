#!/usr/bin/env node
/**
 * Test end-to-end del scraper usando el mock local del portlet Astursalud.
 *   node scripts/scraper-e2e-test.mjs
 * Requiere Playwright con Chromium instalado (scraper/node_modules).
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 8271;
const BASE = `http://127.0.0.1:${MOCK_PORT}/`;

const ok = []; const fallos = [];
const check = (n, c, d = '') => { (c ? ok : fallos).push(n + (d ? ` (${d})` : '')); console.log(`${c ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
async function waitServer() {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE)).ok) return true; } catch {} await sleep(200); }
  return false;
}

const mock = spawn(process.execPath, [path.join(ROOT, 'scripts/mock-astursalud.mjs')], { env: { ...process.env, PORT: String(MOCK_PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));

try {
  check('mock Astursalud en marcha', await waitServer());

  // --- Ejecución A: 8 combinaciones de 2026 ---
  const outA = '/tmp/scraper-e2e-a';
  await rm(outA, { recursive: true, force: true });
  const a = await run(process.execPath, ['scraper/scrape.mjs', '--base-url', BASE, '--out', outA, '--years', '2026', '--limit', '8', '--force', '--delay', '0']);
  check('el scraper termina sin error', a.code === 0, `exit=${a.code}`);
  if (a.code !== 0) console.log(a.err.slice(-1500));

  const manifest = JSON.parse(await readFile(path.join(outA, 'manifest.json'), 'utf8'));
  const doc = JSON.parse(await readFile(path.join(outA, '2026.json'), 'utf8'));
  check('manifest incluye 2026', manifest.anios.includes(2026), JSON.stringify(manifest.anios));
  check('hay registros extraídos', doc.registros.length > 0, `${doc.registros.length} registros`);

  const claves = doc.columnas.map((c) => c.clave);
  check('columnas canónicas detectadas', ['pacientes', 'esperaMedia', 'pacientesMas6Meses'].every((k) => claves.includes(k)), claves.join(','));

  const r0 = doc.registros[0];
  check('metricas.pacientes es numérico', typeof r0.metricas.pacientes === 'number', String(r0.metricas.pacientes));
  check('metricas.esperaMedia parsea decimal con coma', typeof r0.metricas.esperaMedia === 'number' && doc.registros.some((r) => !Number.isInteger(r.metricas.esperaMedia)), String(r0.metricas.esperaMedia));
  check('metricas.pacientesMas6Meses es numérico', typeof r0.metricas.pacientesMas6Meses === 'number', String(r0.metricas.pacientesMas6Meses));

  const tipos = new Set(doc.registros.map((r) => r.tipo));
  check('se extraen especialidades y patologías', tipos.has('especialidad') && tipos.has('patologia'), [...tipos].join(','));
  const cats = new Set(doc.registros.map((r) => r.categoria));
  check('categorías leídas del HTML', cats.has('Oftalmología') && cats.has('Cataratas'), [...cats].slice(0, 4).join(' / '));
  check('ámbito con nombre legible', doc.registros.every((r) => r.ambitoNombre && r.ambitoNombre.length > 2), r0.ambitoNombre);
  const ambitos = new Set(doc.registros.map((r) => r.ambito));
  check('se recorren varios ámbitos', ambitos.size >= 4, `${ambitos.size} ámbitos`);

  // --- Ejecución B: Diciembre (value "0") debe mapear a mes 12 ---
  const outB = '/tmp/scraper-e2e-b';
  await rm(outB, { recursive: true, force: true });
  const b = await run(process.execPath, ['scraper/scrape.mjs', '--base-url', BASE, '--out', outB, '--years', '2026', '--meses', '12', '--limit', '2', '--force', '--delay', '0']);
  const docB = JSON.parse(await readFile(path.join(outB, '2026.json'), 'utf8'));
  check('Diciembre (value 0) se normaliza a mes 12', docB.registros.length > 0 && docB.registros.every((r) => r.mes === 12), `mes=${docB.registros[0]?.mes}`);
} catch (e) {
  fallos.push('EXCEPCIÓN: ' + e.message);
  console.error('❌', e);
} finally {
  mock.kill('SIGTERM');
}

console.log(`\n===== SCRAPER E2E: ${ok.length} OK, ${fallos.length} fallos =====`);
if (fallos.length) { fallos.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
