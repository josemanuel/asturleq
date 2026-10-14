/**
 * Utilidades de normalización de datos para el scraper de Astursalud.
 *
 * El portlet "AstursaludPortletListasEspera" devuelve HTML renderizado en el
 * servidor (no hay API JSON), por lo que el scraper extrae las tablas del DOM y
 * las normaliza aquí a un modelo estable e "agnóstico al esquema": cada fila se
 * guarda con su categoría (especialidad o patología) y un objeto `metricas` con
 * tantas claves como columnas numéricas tenga la tabla.
 */

const ACCENTS = {
  á: 'a', à: 'a', ä: 'a', â: 'a', ã: 'a',
  é: 'e', è: 'e', ë: 'e', ê: 'e',
  í: 'i', ì: 'i', ï: 'i', î: 'i',
  ó: 'o', ò: 'o', ö: 'o', ô: 'o', õ: 'o',
  ú: 'u', ù: 'u', ü: 'u', û: 'u',
  ñ: 'n', ç: 'c', 'º': '', 'ª': '',
};

/** Quita acentos y signos raros. */
export function deaccent(str) {
  return String(str ?? '')
    .toLowerCase()
    .replace(/[áàäâãéèëêíìïîóòöôõúùüûñçºª]/g, (c) => ACCENTS[c] ?? c);
}

/** Convierte una etiqueta ("Nº pacientes en espera") en una clave estable. */
export function slugify(str) {
  const s = deaccent(str)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'col';
}

/**
 * Mapea etiquetas conocidas de Astursalud a claves canónicas estables, para que
 * el dashboard no dependa del texto exacto del encabezado. Si no reconoce la
 * etiqueta, devuelve su slug normal.
 */
const _P6 = /(>|mas|más|supera|mayor|encima)[^a-z]{0,12}(6|seis|180)|6\s*meses|180\s*d[ií]a/i;
const _ESPERA = /(tiempo|demora|espera|d[ií]as?)[^|]{0,24}(medi|promedio)|d[ií]as\b/i;
const _PACI = /paciente|en espera|personas|n[ºo°]\s*de/i;
export function canonicalKey(label) {
  const l = String(label ?? '').trim();
  if (!l) return 'col';
  if (_P6.test(l)) return 'pacientesMas6Meses';
  if (_ESPERA.test(l)) return 'esperaMedia';
  if (_PACI.test(l)) return 'pacientes';
  return slugify(l);
}

/**
 * Convierte el texto de una celda en número, entendiendo el formato español
 * (miles con "." y decimales con ","), o null si no es numérico.
 */
export function parseNumber(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  let s = String(raw).trim();
  if (!s) return null;

  // Descarta unidades de texto comunes pero conserva el número.
  // Ej.: "45,6 días" -> "45,6"
  s = s.replace(/[^0-9.,\-+%]/g, (m) => (m === '%' ? '' : ''));
  s = s.replace(/%/g, '');
  if (!/[0-9]/.test(s)) return null;
  if (!/^[-+]?[\d.,\s]*$/.test(s.replace(/\s/g, ''))) return null;

  s = s.replace(/\s/g, '');
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // 1.234,5 -> 1234.5
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.5 -> 1234.5
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // "1,5" decimal  |  "1,234" (sin más pistas) se asume decimal si hay 1-2 cifras
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasDot) {
    const parts = s.split('.');
    // "1.234" -> miles ; "45.6" -> decimal
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3)) {
      s = s.replace(/\./g, '');
    }
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** ¿La celda "parece" una cifra (número o porcentaje)? */
export function looksNumeric(raw) {
  if (raw == null) return false;
  const s = String(raw).trim();
  if (!s) return false;
  return /^[-+]?\d[\d.,\s]*\s*(%|d[ií]as|d)?$/i.test(s) && parseNumber(s) != null;
}

/** Deduplica encabezados repetidos/vacíos -> ["mes", "mes_2", ...]. */
export function dedupHeaders(headers) {
  const seen = new Map();
  return headers.map((h, i) => {
    let base = slugify(h) || `col_${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
}

/** ¿La fila está completamente vacía? */
function emptyRow(row) {
  return !row || row.every((c) => String(c ?? '').trim() === '');
}

/** ¿La fila es una fila de totales? */
export function isTotalRow(label) {
  return /total|conjunto|global|asturias/i.test(String(label ?? ''));
}

/**
 * Normaliza una tabla extraída del DOM a registros.
 *
 * @param {{caption?:string, headers:string[], rows:string[][]}} table
 * @param {{anio:number, mes:number, ambito:string, ambitoNombre:string, tipo:string}} ctx
 * @returns {{registros:object[], columnas:object[]}}
 */
export function normalizeTable(table, ctx) {
  const headers = (table.headers || []).map((h) => String(h ?? '').trim());
  const rows = (table.rows || []).filter((r) => !emptyRow(r));
  if (!headers.length || !rows.length) return { registros: [], columnas: [] };

  const usadas = new Set();
  const claves = headers.map((h) => {
    let base = canonicalKey(h);
    let k = base, i = 2;
    while (usadas.has(k)) k = `${base}_${i++}`;
    usadas.add(k);
    return k;
  });

  // Detecta la columna de categoría: la primera con mayoría de valores no numéricos.
  let catIdx = 0;
  for (let c = 0; c < headers.length; c++) {
    const col = rows.map((r) => r[c]);
    const numish = col.filter((v) => looksNumeric(v)).length;
    const filled = col.filter((v) => String(v ?? '').trim() !== '').length;
    if (filled > 0 && numish / filled < 0.5) {
      catIdx = c;
      break;
    }
  }

  const registros = [];
  const columnas = new Map(); // clave -> {clave, etiqueta, unidad}
  const unidades = (label) => {
    if (/tiempo|demora|d[ií]as/i.test(label)) return 'días';
    if (/%|porcentaje/i.test(label)) return '%';
    return 'pacientes';
  };

  for (const row of rows) {
    const categoria = String(row[catIdx] ?? '').trim();
    if (!categoria) continue;

    const metricas = {};
    for (let c = 0; c < headers.length; c++) {
      if (c === catIdx) continue;
      const clave = claves[c];
      const raw = String(row[c] ?? '').trim();
      if (raw === '') continue;
      const num = parseNumber(raw);
      metricas[clave] = num != null ? num : raw;
      if (num != null && !columnas.has(clave)) {
        columnas.set(clave, { clave, etiqueta: headers[c] || clave, unidad: unidades(headers[c] || '') });
      }
    }

    registros.push({
      anio: ctx.anio,
      mes: ctx.mes,
      tipo: ctx.tipo, // 'especialidad' | 'patologia'
      ambito: ctx.ambito,
      ambitoNombre: ctx.ambitoNombre,
      categoria,
      esTotal: isTotalRow(categoria),
      metricas,
    });
  }

  return { registros, columnas: [...columnas.values()] };
}
