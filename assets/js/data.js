/**
 * Sincronización de datos: descarga el manifest + ficheros JSON publicados en
 * `data/` y los guarda en IndexedDB. Si el `version` del manifest remoto no ha
 * cambiado, no vuelve a descargar nada (actualizaciones incrementales).
 */
import {
  clearRegistros, countRegistros, getAllRegistros, getMeta, putRegistros, setMeta, idRegistro,
} from './db.js';

const DATA_DIR = 'data/';
const bust = (url) => `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;

export async function descargarManifest() {
  const res = await fetch(bust(`${DATA_DIR}manifest.json`), { cache: 'no-store' });
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  return res.json();
}

export async function cargarLocal() {
  const [registros, manifest, ultimaSync] = await Promise.all([
    getAllRegistros(),
    getMeta('manifest'),
    getMeta('ultimaSync'),
  ]);
  return { registros, manifest, ultimaSync };
}

/**
 * Sincroniza si hace falta.
 * @returns {{manifest:object, actualizado:boolean, totalRegistros:number}}
 */
export async function sincronizar({ force = false, onStatus = () => {} } = {}) {
  const manifest = await descargarManifest();
  const [versionGuardada, n] = await Promise.all([getMeta('version'), countRegistros()]);
  const haceFalta = force || n === 0 || versionGuardada !== manifest.version;
  if (!haceFalta) {
    onStatus({ fase: 'sin-cambios', manifest });
    return { manifest, actualizado: false, totalRegistros: n };
  }

  onStatus({ fase: 'descargando', manifest });
  const todos = [];
  for (const anio of manifest.anios) {
    const fichero = (manifest.ficheros && manifest.ficheros[anio]) || `${anio}.json`;
    try {
      const res = await fetch(bust(`${DATA_DIR}${fichero}`), { cache: 'no-store' });
      if (!res.ok) continue;
      const doc = await res.json();
      for (const r of doc.registros || []) {
        if (!r.id) r.id = idRegistro(r);
        todos.push(r);
      }
      onStatus({ fase: 'descargando', anio, descargados: todos.length });
    } catch (e) {
      console.warn('No se pudo descargar el año', anio, e);
    }
  }

  onStatus({ fase: 'guardando', total: todos.length });
  await clearRegistros();
  await putRegistros(todos, { onProgress: (d, t) => onStatus({ fase: 'guardando', d, t }) });
  await setMeta('version', manifest.version);
  await setMeta('manifest', manifest);
  await setMeta('ultimaSync', new Date().toISOString());
  onStatus({ fase: 'listo', total: todos.length });
  return { manifest, actualizado: true, totalRegistros: todos.length };
}
