#!/usr/bin/env node
/**
 * Mock local del portlet `AstursaludPortletListasEspera`.
 * Reproduce el mismo formulario (año/mes/hospital/información) y una respuesta
 * con tabla HTML, para poder validar el scraper sin depender de la web real
 * (que bloquea IPs de datacenter). Sólo para desarrollo/pruebas.
 *   node scripts/mock-astursalud.mjs   # http://127.0.0.1:8271
 */
import { createServer } from 'node:http';

const NS = '_AstursaludPortletListasEspera_INSTANCE_oFcO4yAwp70L';
const HOSPITALES = [
  ['asturias', 'Datos Globales para Asturias'], ['hj', 'Hospital de Jarrio'],
  ['hcso', 'Hospital Carmen y Severo Ochoa'], ['hsa', 'Hospital San Agustín de Avilés'],
  ['huca', 'Hospital Universitario Central de Asturias'], ['hmn', 'Hospital Monte Naranco de Oviedo'],
  ['hc', 'Hospital de Cabueñes'], ['hfj', 'Hospital Fundación Jove'],
  ['ho', 'Hospital del Oriente de Asturias'], ['hab', 'Hospital Álvarez Buylla'], ['hvn', 'Hospital Valle del Nalón'],
];
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const ANIOS = [2019,2020,2021,2022,2023,2024,2025,2026];
const ESPECIALIDADES = ['Oftalmología','Traumatología y Cirugía Ortopédica','Cirugía General y del Aparato Digestivo','Urología'];
const PATOLOGIAS = ['Cataratas','Artroplastia de rodilla','Hernia inguinal'];

const opts = (arr, sel) => arr.map(([v,l]) => `<option value="${v}"${v==sel?' selected':''}>${l}</option>`).join('');
const nums = (s) => [...s].reduce((a,c)=>a+c.charCodeAt(0),0);

function pagina({ anio=2026, mes='9', hospital='asturias', informacion='espe', resultado='' }) {
  const mesOpts = MESES.map((m,i) => `<option value="${i===11?'0':String(i+1)}"${(i===11?'0':String(i+1))===String(mes)?' selected':''}>${m}</option>`).join('');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Astursalud - Buscador listas de espera quirúrgicas</title></head><body>
<form action="/listaesperaquirurgica?p_p_id=${NS}&p_p_lifecycle=1&${NS}_javax.portlet.action=getListasEspera&p_auth=AbC123" method="post" id="${NS}_formListasEspera" name="${NS}_formListasEspera">
  <input type="hidden" name="${NS}_formDate" value="${Date.now()}">
  <input type="hidden" name="${NS}_articleId" value="1632341">
  <select name="${NS}_anio" id="${NS}_anio">${ANIOS.map(a=>`<option value="${a}"${a==anio?' selected':''}>${a}</option>`).join('')}</select>
  <select name="${NS}_mes" id="${NS}_mes">${mesOpts}</select>
  <select name="${NS}_hospital" id="${NS}_hospital">${opts(HOSPITALES, hospital)}</select>
  <select name="${NS}_informacion" id="${NS}_informacion">
    <option value="espe"${informacion==='espe'?' selected':''}>Datos por especialidades</option>
    <option value="pat"${informacion==='pat'?' selected':''}>Datos por patologías</option>
  </select>
  <button type="submit" id="${NS}_searchButton" name="${NS}_searchButton" class="btn btn-primary">Buscar</button>
</form>
<section id="resultados">${resultado}</section>
</body></html>`;
}

function tabla({ anio, mes, hospital, informacion }) {
  const cats = informacion === 'espe' ? ESPECIALIDADES : PATOLOGIAS;
  const peso = { asturias: 10, hj: 1, hcso: 1, hsa: 3, huca: 6, hmn: 2, hc: 4, hfj: 1, ho: 1, hab: 2, hvn: 2 }[hospital] || 1;
  const base = nums(`${anio}${mes}${hospital}`) % 40 + 10;
  const filas = cats.map((c, i) => {
    const pac = Math.round((base - i * 3) * peso * 1.7);
    const dias = (30 + (nums(c) % 60) + i * 4 + 0.5).toFixed(1).replace('.', ',');
    const m6 = Math.round(pac * 0.15);
    return `<tr><td>${c}</td><td>${pac}</td><td>${dias}</td><td>${m6}</td></tr>`;
  }).join('');
  return `<table><caption>Pacientes y tiempos de espera</caption>
<thead><tr><th>Especialidad / Patología</th><th>Pacientes en espera</th><th>Tiempo medio de espera (días)</th><th>Pacientes &gt; 6 meses</th></tr></thead>
<tbody>${filas}</tbody></table>`;
}

createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const p = new URLSearchParams(body);
      const ctx = {
        anio: Number(p.get(`${NS}_anio`)) || 2026,
        mes: p.get(`${NS}_mes`) ?? '9',
        hospital: p.get(`${NS}_hospital`) || 'asturias',
        informacion: p.get(`${NS}_informacion`) || 'espe',
      };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pagina({ ...ctx, resultado: tabla(ctx) }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(pagina({}));
}).listen(Number(process.env.PORT || 8271), process.env.HOST || '127.0.0.1', () => {
  console.log(`Mock Astursalud en http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8271}`);
});
