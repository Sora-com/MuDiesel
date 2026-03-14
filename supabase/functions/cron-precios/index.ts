// Edge Function: cron-precios
// Se ejecuta cada hora para descargar precios del Ministerio y guardarlos en Supabase.
//
// Para configurar el cron, ejecutar en SQL Editor de Supabase:
//   SELECT cron.schedule('cron-precios', '0 * * * *',
//     $$SELECT net.http_post(
//       url := 'https://<TU_PROJECT_REF>.supabase.co/functions/v1/cron-precios',
//       headers := jsonb_build_object('Authorization', 'Bearer <TU_SERVICE_ROLE_KEY>', 'Content-Type', 'application/json'),
//       body := '{}'
//     );$$
//   );

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MINISTERIO_API =
  "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";

// Mapeo de campos del Ministerio a nuestros nombres de combustible
const COMBUSTIBLES: Record<string, string> = {
  "Precio Gasoleo A": "diesel",
  "Precio Gasolina 95 E5": "g95",
  "Precio Gasolina 98 E5": "g98",
};

interface StationRaw {
  IDEESS: string;
  "Rótulo": string;
  "Dirección": string;
  Localidad: string;
  Provincia: string;
  "C.P.": string;
  Latitud: string;
  "Longitud (WGS84)": string;
  Horario: string;
  "Precio Gasoleo A": string;
  "Precio Gasolina 95 E5": string;
  "Precio Gasolina 98 E5": string;
}

function parseSpanishFloat(str: string | undefined | null): number | null {
  if (!str || str.trim() === "") return null;
  const val = parseFloat(str.replace(",", "."));
  return isNaN(val) ? null : val;
}

Deno.serve(async (req) => {
  try {
    // Verificar autorización (solo service_role puede invocar esto)
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Crear cliente Supabase con service_role key
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Descargar datos del Ministerio
    console.log("Descargando datos del Ministerio...");
    const resp = await fetch(MINISTERIO_API, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; MuDiesel/1.0)",
      },
    });

    if (!resp.ok) {
      throw new Error(`API del Ministerio respondió ${resp.status}`);
    }

    const data = await resp.json();
    const stations: StationRaw[] = data.ListaEESSPrecio || [];
    const fechaMinisterio = data.Fecha || null; // Fecha del dataset
    const resultadoConsulta = data.ResultadoConsulta;

    console.log(
      `Recibidas ${stations.length} estaciones. Fecha: ${fechaMinisterio}. Resultado: ${resultadoConsulta}`,
    );

    if (stations.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "0 estaciones recibidas" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // 2. Cargar tabla de normalización de marcas
    const { data: marcasData } = await supabase
      .from("normalizacion_marcas")
      .select("nombre_ministerio, nombre_normalizado");

    const marcasMap = new Map<string, string>();
    if (marcasData) {
      for (const m of marcasData) {
        marcasMap.set(m.nombre_ministerio.toUpperCase(), m.nombre_normalizado);
      }
    }

    function normalizarNombre(rotulo: string): string {
      const upper = rotulo.trim().toUpperCase();
      // Buscar coincidencia exacta
      if (marcasMap.has(upper)) return marcasMap.get(upper)!;
      // Buscar si empieza por alguna marca conocida (ej: "CEPSA - ESTACIÓN X")
      for (const [key, val] of marcasMap) {
        if (upper.startsWith(key)) return val;
      }
      // Si no hay match, capitalizar el nombre original
      return rotulo.trim().replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // 3. Preparar datos de gasolineras
    const gasolinerasUpsert = [];
    const preciosInsert = [];
    let skipped = 0;

    for (const s of stations) {
      const id = s.IDEESS;
      if (!id) {
        skipped++;
        continue;
      }

      const lat = parseSpanishFloat(s.Latitud);
      const lng = parseSpanishFloat(s["Longitud (WGS84)"]);
      if (lat === null || lng === null) {
        skipped++;
        continue;
      }

      const nombreOriginal = s["Rótulo"] || "Sin nombre";
      const nombreNorm = normalizarNombre(nombreOriginal);

      gasolinerasUpsert.push({
        id,
        nombre_original: nombreOriginal,
        nombre: nombreNorm,
        direccion: s["Dirección"] || "",
        localidad: s.Localidad || "",
        provincia: s.Provincia || "",
        cp: s["C.P."] || "",
        lat,
        lng,
        horario_declarado: s.Horario || "",
        updated_at: new Date().toISOString(),
      });

      // Precios por cada tipo de combustible
      for (const [campoApi, combKey] of Object.entries(COMBUSTIBLES)) {
        const precio = parseSpanishFloat(
          s[campoApi as keyof StationRaw] as string,
        );
        if (precio !== null && precio > 0) {
          preciosInsert.push({
            gasolinera_id: id,
            combustible: combKey,
            precio,
            fecha_ministerio: fechaMinisterio,
          });
        }
      }
    }

    console.log(
      `Procesadas: ${gasolinerasUpsert.length} gasolineras, ${preciosInsert.length} precios, ${skipped} omitidas`,
    );

    // 4. Upsert gasolineras (en lotes de 500)
    const BATCH_SIZE = 500;
    for (let i = 0; i < gasolinerasUpsert.length; i += BATCH_SIZE) {
      const batch = gasolinerasUpsert.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("gasolineras")
        .upsert(batch, { onConflict: "id" });

      if (error) {
        console.error(`Error upsert gasolineras batch ${i}:`, error.message);
      }
    }

    // 5. Insertar precios (en lotes de 1000)
    for (let i = 0; i < preciosInsert.length; i += 1000) {
      const batch = preciosInsert.slice(i, i + 1000);
      const { error } = await supabase.from("precios").insert(batch);

      if (error) {
        console.error(`Error insert precios batch ${i}:`, error.message);
      }
    }

    // 6. Calcular y guardar precio medio nacional por combustible
    const medias: Record<string, { suma: number; count: number }> = {};
    for (const p of preciosInsert) {
      if (!medias[p.combustible]) {
        medias[p.combustible] = { suma: 0, count: 0 };
      }
      medias[p.combustible].suma += p.precio;
      medias[p.combustible].count++;
    }

    const preciosMedios: Record<string, number> = {};
    for (const [comb, { suma, count }] of Object.entries(medias)) {
      preciosMedios[comb] = Math.round((suma / count) * 1000) / 1000;
    }

    await supabase.from("metadatos").upsert({
      clave: "precios_medios",
      valor: preciosMedios,
      updated_at: new Date().toISOString(),
    }, { onConflict: "clave" });

    await supabase.from("metadatos").upsert({
      clave: "ultimo_cron",
      valor: {
        timestamp: new Date().toISOString(),
        estaciones: gasolinerasUpsert.length,
        precios: preciosInsert.length,
        fecha_ministerio: fechaMinisterio,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "clave" });

    // 7. Limpiar precios antiguos (>90 días) para no llenar la DB
    await supabase.rpc("limpiar_precios_antiguos");

    const result = {
      ok: true,
      estaciones: gasolinerasUpsert.length,
      precios: preciosInsert.length,
      skipped,
      precios_medios: preciosMedios,
      fecha_ministerio: fechaMinisterio,
    };

    console.log("Cron completado:", JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error en cron-precios:", error);
    return new Response(
      JSON.stringify({ ok: false, error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
