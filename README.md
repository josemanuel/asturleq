# Listas de Espera Quirúrgica · Asturias — Dashboard

Dashboard **estático** (HTML + CSS + JavaScript, sin frameworks ni build) que explora la
lista de espera quirúrgica que publica **Astursalud** (SESPA, Principado de Asturias),
con datos **mes a mes** desglosados por **área sanitaria/hospital**, **especialidad** y **patología**.

Incluye un **scraper** (Playwright) que automatiza la extracción desde la web oficial y una
capa de **IndexedDB** para consultar los datos sin conexión y actualizarlos cuando se publiquen
nuevas cifras.

```
┌── scraper/ (Playwright) ──► data/*.json ──► IndexedDB ──► dashboard
```

---

## 1. Arranque rápido

```bash
# 1) servir la app en local (necesario: IndexedDB no funciona con file://)
npm run serve            # → http://localhost:8080
```

La app arranca con un **dataset de demostración** incluido en `data/`, así que verás el
dashboard funcionando desde el primer minuto (lleva un aviso «Datos de demostración»).

Para pasar a **datos reales**, primero extrae con el scraper (sección 3) y luego pulsa
**«Actualizar datos»** en la cabecera.

---

## 2. La fuente de datos y cómo se extrae

La página `https://www.astursalud.es/listaesperaquirurgica` es un **portlet Liferay**
(`AstursaludPortletListasEspera`). **No expone ninguna API JSON/CSV**: los datos se renderizan
en el servidor mediante un formulario `POST` con estos campos:

| Campo          | Valores                                                        |
|----------------|----------------------------------------------------------------|
| `..._anio`     | 2019 … año actual                                              |
| `..._mes`      | `1`=Enero … `11`=Noviembre, **`0`=Diciembre** ⚠️               |
| `..._hospital` | `asturias` (total global) + un hospital por área sanitaria     |
| `..._informacion` | `espe` = por especialidades · `pat` = por patologías        |

El portlet usa el prefijo de instancia `_AstursaludPortletListasEspera_INSTANCE_…_` y envía la
petición a `...&p_p_lifecycle=1&...&javax.portlet.action=getListasEspera&p_auth=…`, devolviendo
**HTML con las tablas ya renderizadas**. Por eso la extracción es **web scraping con navegador
real** (seleccionar valores → pulsar «Buscar» → leer las tablas), y no una simple llamada HTTP.

> ⚠️ **Importante sobre red:** Astursalud bloquea las conexiones desde IPs de *datacenter/cloud*
> (el TCP simplemente caduca). Por eso el scraper **debe ejecutarse desde tu equipo/red local**,
> donde la web sí responde. No funcionará en CI ni detrás de un proxy de nube.

---

## 3. Scraper (extracción automatizada)

```bash
cd scraper
npm install                 # instala Playwright
npx playwright install chromium   # descarga el navegador
npm run probe               # 1 consulta de ejemplo (inspecciona la salida)
npm run scrape              # extrae TODO (años × meses × hospitales × tipos)
npm run scrape:headful      # igual, viendo el navegador
```

### Salida
En `../data/`:

* `data/<año>.json` — `{ anio, generado, fuente, columnas[], registros[] }`
* `data/manifest.json` — índice con `version`, `anios`, `ambitos[]`, `columnas[]` y `ficheros{}`.

Cada registro tiene la forma:

```json
{
  "anio": 2026, "mes": 9, "tipo": "especialidad",
  "ambito": "huca", "ambitoNombre": "Hospital Universitario Central de Asturias",
  "categoria": "Traumatología y Cirugía Ortopédica", "esTotal": false,
  "metricas": { "pacientes": 412, "esperaMedia": 78.5, "pacientesMas6Meses": 61 }
}
```

El scraper es **agnóstico al esquema**: captura los encabezados reales de cada tabla y mapea las
columnas reconocidas a **claves canónicas** (`pacientes`, `esperaMedia`, `pacientesMas6Meses`).
Si Astursalud añade o renombra columnas, se conservan con su nombre normalizado y el dashboard
las mostrará igualmente.

### Opciones útiles
```bash
node scrape.mjs --years 2026 --meses 9,10   # sólo unos periodos (actualizaciones incrementales)
node scrape.mjs --limit 20                  # limita nº de combinaciones (pruebas)
node scrape.mjs --force                     # ignora el estado previo
node scrape.mjs --delay 1200                # pausa entre peticiones (ms)
node scrape.mjs --out ../data               # carpeta de salida
node scrape.mjs --probe --headful           # depurar el formulario
```
El progreso se guarda en `scraper/.state.json`, así que puedes reanudar sin repetir consultas.

---

## 4. Almacenamiento local (IndexedDB)

* Base de datos `astursalud_lista_espera`, almacenes `registros` (con índices por año, mes, área,
  tipo y categoría) y `meta`.
* En cada carga la app pide `data/manifest.json`; si su `version` cambió respecto a la guardada,
  **vuelve a descargar y reindexar** sólo lo necesario (actualizaciones incrementales).
* Todo se lee después desde IndexedDB → la app funciona **offline**.
* Botón **«Actualizar datos»** para forzar la comprobación manualmente.

### Alternativas consideradas
* **localStorage**: descartado (límite ~5 MB; aquí manejamos decenas de miles de registros).
* **Cache API / service worker**: buena opción como complemento si algún día quieres precachear
  los JSON; no sustituye a IndexedDB para consultas estructuradas.
* **Datos en el propio código**: no escala ni permite actualizar sin recompilar.

---

## 5. Despliegue en GitHub Pages

Repositorio: <https://github.com/josemanuel/asturleq> (rama por defecto `main`).

```bash
# Enlazar el clon con el repositorio remoto (solo la primera vez)
git remote add origin https://github.com/josemanuel/asturleq.git

# Preparar y subir los cambios (incluidos los data/*.json regenerados)
git add -A
git commit -m "Actualizar datos de lista de espera quirúrgica"
git push origin main
```

**Opción A — con GitHub Actions (recomendada).** El workflow
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) se ejecuta al hacer *push* a `main`,
empaqueta `index.html`, `assets/` y `data/` y publica en Pages.
Actívalo en *Settings → Pages → Build and deployment → Source: GitHub Actions*.

**Opción B — desde rama.** *Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`*.
El sitio es 100 % estático, así que la raíz funciona tal cual.

Para actualizar datos en producción: ejecuta el scraper en local, haz *commit* de los nuevos
`data/*.json` y *push*.

---

## 6. Pruebas

```bash
npm run test:dashboard   # E2E del dashboard en Chromium real (KPIs, filtros, gráficas, IndexedDB)
npm run test:scraper     # E2E del scraper contra un mock del portlet Astursalud
```

Ambas usan Playwright (`scraper/node_modules`). El mock (`scripts/mock-astursalud.mjs`) replica
el formulario y una respuesta con tabla, y sirve para validar el scraper sin depender de la web real.

En entornos sin fuentes/`fontconfig` (contenedores mínimos) hay que exportar antes
`FONTCONFIG_FILE` y `LD_LIBRARY_PATH` apuntando a una configuración de fuentes válida, si no
Chromium aborta al iniciarse.

---

## 7. Estructura

```
index.html                     Dashboard
assets/css/styles.css          Estilos
assets/js/app.js               Interfaz (filtros, KPIs, gráficas, tabla, CSV)
assets/js/data.js              Sincronización manifest ↔ IndexedDB
assets/js/db.js                Envoltorio de IndexedDB
assets/vendor/chart.umd.min.js Chart.js (vendorizado, sin CDN)
data/                          Datos (manifest + <año>.json)
scraper/scrape.mjs             Scraper Playwright
scraper/lib/parse.mjs          Normalización + claves canónicas
scripts/gen-demo-data.mjs      Generador del dataset de demostración
scripts/serve.mjs              Servidor estático mínimo
scripts/mock-astursalud.mjs    Mock del portlet (tests)
scripts/*-test.mjs             Pruebas E2E
```

---

## 8. Aviso legal y atribución

Datos originales publicados por **Astursalud / SESPA** y el **Principado de Asturias**
([página oficial](https://www.astursalud.es/listaesperaquirurgica)).
Este proyecto **no es un sitio oficial** y no está afiliado a Astursalud; es una reutilización de
información del sector público con fines informativos. Respeta siempre las condiciones de uso del
portal y limita la frecuencia de las peticiones (`--delay`).

> Los ficheros `data/*.json` incluidos en este repositorio llevan la marca `"demo": true`:
> son **datos sintéticos de demostración** generados por `scripts/gen-demo-data.mjs`, no cifras
> oficiales. Sustitúyelos ejecutando el scraper.
