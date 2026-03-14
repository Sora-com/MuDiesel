// Script: cron-precios.mjs
// Descarga precios del Ministerio y los sube a Supabase.
// Se ejecuta como GitHub Action cada hora.

const MINISTERIO_API =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const COMBUSTIBLES = {
  'Precio Gasoleo A': 'diesel',
  'Precio Gasolina 95 E5': 'g95',
  'Precio Gasolina 98 E5': 'g98',
};

function parseSpanishFloat(str) {
  if (!str || str.trim() === '') return null;
  const val = parseFloat(str.replace(',', '.'));
  return isNaN(val) ? null : val;
}

async function supabaseRequest(path, method, body) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'resolution=merge-duplicates' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase ${method} ${path}: ${resp.status} — ${text}`);
  }
  return resp;
}

async function main() {
  // 1. Descargar datos del Ministerio
  console.log('Descargando datos del Ministerio...');
  const resp = await fetch(MINISTERIO_API, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; MuDiesel/1.0)' },
  });
  if (!resp.ok) throw new Error(`API del Ministerio respondió ${resp.status}`);

  const data = await resp.json();
  const stations = data.ListaEESSPrecio || [];
  const fechaMinisterio = data.Fecha || null;

  // Convertir fecha del Ministerio (DD/MM/YYYY H:MM:SS) a ISO
  let fechaISO = null;
  if (fechaMinisterio) {
    const m = fechaMinisterio.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (m) fechaISO = `${m[3]}-${m[2]}-${m[1]}T${m[4].padStart(2,'0')}:${m[5]}:${m[6]}+01:00`;
  }
  console.log(`Recibidas ${stations.length} estaciones. Fecha: ${fechaMinisterio} → ${fechaISO}`);
  if (stations.length === 0) throw new Error('0 estaciones recibidas');

  // 2. Cargar tabla de normalización de marcas
  const marcasResp = await fetch(
    `${SUPABASE_URL}/rest/v1/normalizacion_marcas?select=nombre_ministerio,nombre_normalizado`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const marcasData = marcasResp.ok ? await marcasResp.json() : [];
  const marcasMap = new Map();
  for (const m of marcasData) {
    marcasMap.set(m.nombre_ministerio.toUpperCase(), m.nombre_normalizado);
  }

  function normalizarNombre(rotulo) {
    const upper = rotulo.trim().toUpperCase();
    if (marcasMap.has(upper)) return marcasMap.get(upper);
    for (const [key, val] of marcasMap) {
      if (upper.startsWith(key)) return val;
    }
    return rotulo.trim().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // 3. Preparar datos
  const gasolinerasUpsert = [];
  const preciosInsert = [];
  let skipped = 0;

  for (const s of stations) {
    const id = s.IDEESS;
    if (!id) { skipped++; continue; }

    const lat = parseSpanishFloat(s.Latitud);
    const lng = parseSpanishFloat(s['Longitud (WGS84)']);
    if (lat === null || lng === null) { skipped++; continue; }

    const nombreOriginal = s['Rótulo'] || 'Sin nombre';

    gasolinerasUpsert.push({
      id,
      nombre_original: nombreOriginal,
      nombre: normalizarNombre(nombreOriginal),
      direccion: s['Dirección'] || '',
      localidad: s.Localidad || '',
      provincia: s.Provincia || '',
      cp: s['C.P.'] || '',
      lat,
      lng,
      horario_declarado: s.Horario || '',
      updated_at: new Date().toISOString(),
    });

    for (const [campoApi, combKey] of Object.entries(COMBUSTIBLES)) {
      const precio = parseSpanishFloat(s[campoApi]);
      if (precio !== null && precio > 0) {
        preciosInsert.push({
          gasolinera_id: id,
          combustible: combKey,
          precio,
          fecha_ministerio: fechaISO,
        });
      }
    }
  }

  console.log(`Procesadas: ${gasolinerasUpsert.length} gasolineras, ${preciosInsert.length} precios, ${skipped} omitidas`);

  // 4. Upsert gasolineras (lotes de 500)
  const BATCH = 500;
  for (let i = 0; i < gasolinerasUpsert.length; i += BATCH) {
    const batch = gasolinerasUpsert.slice(i, i + BATCH);
    await supabaseRequest('gasolineras', 'POST', batch);
    console.log(`  Gasolineras ${i + 1}–${Math.min(i + BATCH, gasolinerasUpsert.length)} OK`);
  }

  // 5. Insertar precios (lotes de 1000)
  for (let i = 0; i < preciosInsert.length; i += 1000) {
    const batch = preciosInsert.slice(i, i + 1000);
    await supabaseRequest('precios', 'POST', batch);
    console.log(`  Precios ${i + 1}–${Math.min(i + 1000, preciosInsert.length)} OK`);
  }

  // 6. Calcular y guardar precio medio nacional
  const medias = {};
  for (const p of preciosInsert) {
    if (!medias[p.combustible]) medias[p.combustible] = { suma: 0, count: 0 };
    medias[p.combustible].suma += p.precio;
    medias[p.combustible].count++;
  }
  const preciosMedios = {};
  for (const [comb, { suma, count }] of Object.entries(medias)) {
    preciosMedios[comb] = Math.round((suma / count) * 1000) / 1000;
  }

  await supabaseRequest('metadatos', 'POST', {
    clave: 'precios_medios',
    valor: preciosMedios,
    updated_at: new Date().toISOString(),
  });

  await supabaseRequest('metadatos', 'POST', {
    clave: 'ultimo_cron',
    valor: {
      timestamp: new Date().toISOString(),
      estaciones: gasolinerasUpsert.length,
      precios: preciosInsert.length,
      fecha_ministerio: fechaMinisterio,
    },
    updated_at: new Date().toISOString(),
  });

  // 7. Limpiar precios antiguos (>90 días)
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/limpiar_precios_antiguos`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  console.log('Completado:', JSON.stringify({ precios_medios: preciosMedios, fecha_ministerio: fechaMinisterio }));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
