#!/usr/bin/env node
/**
 * Genera un dataset de DEMOSTRACIÓN con exactamente el mismo esquema que
 * produce el scraper (scraper/scrape.mjs). Sirve para que el dashboard sea
 * usable y visible antes de ejecutar el scraping real.
 *
 *   node scripts/gen-demo-data.mjs
 *
 * Salida: data/manifest.json + data/<anio>.json  (marcados con "demo": true)
 *
 * IMPORTANTE: son datos sintéticos, NO son cifras oficiales de Astursalud.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../data');

// PRNG determinista (mulberry32) para que el dataset sea reproducible.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ámbitos reales del desplegable de Astursalud.
const HOSPITALES = [
  { clave: 'hj', nombre: 'Hospital de Jarrio', area: 'Área I', peso: 0.05 },
  { clave: 'hcso', nombre: 'Hospital Carmen y Severo Ochoa', area: 'Área II', peso: 0.05 },
  { clave: 'hsa', nombre: 'Hospital San Agustín de Avilés', area: 'Área III', peso: 0.12 },
  { clave: 'huca', nombre: 'Hospital Universitario Central de Asturias', area: 'Área IV', peso: 0.24 },
  { clave: 'hmn', nombre: 'Hospital Monte Naranco de Oviedo', area: 'Área IV', peso: 0.06 },
  { clave: 'hc', nombre: 'Hospital de Cabueñes', area: 'Área V', peso: 0.15 },
  { clave: 'hfj', nombre: 'Hospital Fundación Jove', area: 'Área V', peso: 0.05 },
  { clave: 'ho', nombre: 'Hospital del Oriente de Asturias', area: 'Área VI', peso: 0.05 },
  { clave: 'hab', nombre: 'Hospital Álvarez Buylla', area: 'Área VII', peso: 0.07 },
  { clave: 'hvn', nombre: 'Hospital Valle del Nalón', area: 'Área VIII', peso: 0.08 },
];

const ESPECIALIDADES = [
  'Angiología y Cirugía Vascular', 'Cirugía Cardiovascular', 'Cirugía General y del Aparato Digestivo',
  'Cirugía Maxilofacial', 'Cirugía Pediátrica', 'Cirugía Plástica y Reparadora', 'Cirugía Torácica',
  'Dermatología', 'Ginecología y Obstetricia', 'Neurocirugía', 'Oftalmología', 'Otorrinolaringología',
  'Traumatología y Cirugía Ortopédica', 'Urología',
];

const PATOLOGIAS = [
  'Cataratas', 'Artroplastia de cadera', 'Artroplastia de rodilla', 'Artroscopia de rodilla',
  'Hallux valgus (juanete)', 'Hernia inguinal', 'Hernia de disco', 'Varices',
  'Amígdalas y adenoides', 'Colelitiasis (vesícula)', 'Síndrome del túnel carpiano',
  'Hiperplasia benigna de próstata', 'Hemorroides', 'Fístula anal', 'Quiste pilonidal',
  'Miomectomía uterina', 'Histerectomía', 'Tiroides', 'Mama', 'Fractura de cadera',
];

const COLUMNAS = [
  { clave: 'pacientes', etiqueta: 'Pacientes en espera', unidad: 'pacientes' },
  { clave: 'esperaMedia', etiqueta: 'Tiempo medio de espera', unidad: 'días' },
  { clave: 'pacientesMas6Meses', etiqueta: 'Pacientes en espera > 6 meses', unidad: 'pacientes' },
];

const ANIOS = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

// Contexto: la lista creció con la pandemia (2020-2021) y se recuperó después.
function factorAnual(anio) {
  const f = {
    2019: 0.90, 2020: 1.05, 2021: 1.18, 2022: 1.22,
    2023: 1.15, 2024: 1.06, 2025: 0.99, 2026: 0.94,
  };
  return f[anio] ?? 1;
}
const factorMes = (m) => 1 + 0.05 * Math.sin(((m - 1) / 12) * 2 * Math.PI - 1);

async function main() {
  await mkdir(OUT, { recursive: true });
  const r = rng(20261012);
  const generado = new Date().toISOString();
  const columnasMap = new Map(COLUMNAS.map((c) => [c.clave, c]));
  let total = 0;
  const ficheros = {};

  for (const anio of ANIOS) {
    // El año en curso publica con retraso: sólo hasta Septiembre.
    const ultimoMes = anio === 2026 ? 9 : 12;
    const registros = [];

    for (const tipo of ['especialidad', 'patologia']) {
      const catalogo = tipo === 'especialidad' ? ESPECIALIDADES : PATOLOGIAS;
      for (let mes = 1; mes <= ultimoMes; mes++) {
        const ctx = factorAnual(anio) * factorMes(mes);
        // Compone cada hospital y agrega Asturias a partir de ellos.
        const porHospital = [];
        for (const h of HOSPITALES) {
          for (let i = 0; i < catalogo.length; i++) {
            const catBase = (tipo === 'especialidad' ? 260 : 150) / (1 + i * (tipo === 'especialidad' ? 0.22 : 0.18));
            const base = catBase * h.peso * 6;
            const pacientes = Math.max(1, Math.round(base * ctx * (0.85 + r() * 0.3)));
            const esperaMedia = Math.round((42 + 26 * ctx + (r() - 0.5) * 22 + i * 0.6) * 10) / 10;
            const pacientesMas6Meses = Math.round(pacientes * (0.10 + 0.10 * ctx + (r() - 0.5) * 0.06));
            porHospital.push({
              anio, mes, tipo, ambito: h.clave, ambitoNombre: h.nombre,
              categoria: catalogo[i], esTotal: false,
              metricas: {
                pacientes,
                esperaMedia: Math.max(8, esperaMedia),
                pacientesMas6Meses: Math.max(0, Math.min(pacientes, pacientesMas6Meses)),
              },
            });
          }
        }
        // Agregado "Datos Globales para Asturias"
        const agg = new Map();
        for (const reg of porHospital) {
          const a = agg.get(reg.categoria) || { pacientes: 0, esperaMediaW: 0, pacientesMas6Meses: 0 };
          a.pacientes += reg.metricas.pacientes;
          a.esperaMediaW += reg.metricas.esperaMedia * reg.metricas.pacientes;
          a.pacientesMas6Meses += reg.metricas.pacientesMas6Meses;
          agg.set(reg.categoria, a);
        }
        for (const [categoria, a] of agg) {
          registros.push({
            anio, mes, tipo, ambito: 'asturias', ambitoNombre: 'Datos Globales para Asturias',
            categoria, esTotal: true,
            metricas: {
              pacientes: a.pacientes,
              esperaMedia: Math.round((a.esperaMediaW / a.pacientes) * 10) / 10,
              pacientesMas6Meses: a.pacientesMas6Meses,
            },
          });
        }
        registros.push(...porHospital);
      }
    }

    const doc = { anio, generado, demo: true, fuente: 'https://www.astursalud.es/listaesperaquirurgica', columnas: COLUMNAS, registros };
    const nombre = `${anio}.json`;
    await writeFile(path.join(OUT, nombre), JSON.stringify(doc));
    ficheros[anio] = nombre;
    total += registros.length;
    console.log(`  · ${nombre}: ${registros.length} registros`);
  }

  const ambitos = HOSPITALES.map((h) => ({ clave: h.clave, nombre: h.nombre, area: h.area }));
  const manifest = {
    version: String(Date.now()),
    generado,
    demo: true,
    fuente: 'https://www.astursalud.es/listaesperaquirurgica',
    aviso: 'Datos de DEMOSTRACIÓN generados localmente. Ejecuta el scraper para obtener datos reales.',
    anios: ANIOS.filter((a) => ficheros[a]),
    totalRegistros: total,
    tipos: ['especialidad', 'patologia'],
    ambitos: [{ clave: 'asturias', nombre: 'Datos Globales para Asturias', area: 'Todas' }, ...ambitos],
    columnas: [...columnasMap.values()],
    ficheros,
  };
  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Manifest demo: ${total} registros, años ${manifest.anios.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
