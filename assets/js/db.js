/**
 * Capa de almacenamiento local (IndexedDB) para el dashboard de listas de
 * espera quirúrgica de Astursalud.
 *
 * - `registros`: cada fila (año, mes, ámbito, tipo, categoría, métricas).
 * - `meta`:      clave/valor (manifest, versión sincronizada, fecha de sync…).
 *
 * La app es "offline-first": tras la primera sincronización todo se lee de
 * IndexedDB. Cuando Astursalud publica datos nuevos, el manifest remoto cambia
 * de `version` y se vuelve a sincronizar sólo lo necesario.
 */

const DB_NAME = 'astursalud_lista_espera';
const DB_VERSION = 1;
const STORE_REGISTROS = 'registros';
const STORE_META = 'meta';

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_REGISTROS)) {
        const store = db.createObjectStore(STORE_REGISTROS, { keyPath: 'id' });
        store.createIndex('anio', 'anio');
        store.createIndex('mes', 'mes');
        store.createIndex('tipo', 'tipo');
        store.createIndex('ambito', 'ambito');
        store.createIndex('categoria', 'categoria');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'clave' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

const req2promise = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export async function getMeta(clave) {
  const db = await openDB();
  const row = await req2promise(tx(db, STORE_META, 'readonly').get(clave));
  return row ? row.valor : undefined;
}

export async function setMeta(clave, valor) {
  const db = await openDB();
  await req2promise(tx(db, STORE_META, 'readwrite').put({ clave, valor }));
}

export async function countRegistros() {
  const db = await openDB();
  return req2promise(tx(db, STORE_REGISTROS, 'readonly').count());
}

export async function clearRegistros() {
  const db = await openDB();
  await req2promise(tx(db, STORE_REGISTROS, 'readwrite').clear());
}

/** Inserta/actualiza registros en lotes (idempotente por `id`). */
export async function putRegistros(registros, { onProgress } = {}) {
  const db = await openDB();
  const BATCH = 2000;
  for (let i = 0; i < registros.length; i += BATCH) {
    const chunk = registros.slice(i, i + BATCH);
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE_REGISTROS, 'readwrite');
      const store = t.objectStore(STORE_REGISTROS);
      for (const reg of chunk) store.put(reg);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    if (onProgress) onProgress(Math.min(i + BATCH, registros.length), registros.length);
  }
}

export async function getAllRegistros() {
  const db = await openDB();
  return req2promise(tx(db, STORE_REGISTROS, 'readonly').getAll());
}

/** Clave única y estable de un registro (permite upsert sin duplicar). */
export function idRegistro(r) {
  return `${r.anio}|${r.mes}|${r.tipo}|${r.ambito}|${r.categoria}`;
}

export async function borrarTodo() {
  const db = await openDB();
  await Promise.all([clearRegistros(), req2promise(tx(db, STORE_META, 'readwrite').clear())]);
}
