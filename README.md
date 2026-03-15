# MuDiesel

Encuentra las gasolineras mas baratas cerca de ti en Espana.

## Demo

[sora-com.github.io/MuDiesel](https://sora-com.github.io/MuDiesel)

## Funcionalidades

- Geolocalizacion automatica
- Precios actualizados cada hora via backend (Supabase)
- Filtro por combustible: Diesel, Gasolina 95, Gasolina 98
- Radio de busqueda: 5 / 10 / 25 km
- Ordenacion por precio, cercania o mejor valor (precio + coste del desplazamiento)
- Comparativa por cadena: ranking de marcas por precio medio en tu zona
- Comparativa con precio medio nacional en cada gasolinera
- Confirmacion comunitaria de precios (crowdsourcing)
- Indicador de antiguedad del precio con alertas por color
- Normalizacion de nombres de marca (Cepsa -> Moeve, etc.)
- Navegacion directa a Google Maps

## Arquitectura

```
index.html          Frontend (HTML/CSS/JS vanilla, un solo archivo)
supabase/           Backend en Supabase (tier gratuito)
  schema.sql        Esquema de base de datos PostgreSQL
  functions/        Edge Functions (cron, no en uso por bloqueo de IP)
scripts/
  cron-precios.mjs  Script que descarga precios del Ministerio y los sube a Supabase
.github/workflows/
  cron-precios.yml  GitHub Action que ejecuta el script cada hora
```

## Datos

Fuente primaria: [API REST del Ministerio de Industria y Turismo](https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/).

Un GitHub Action consulta la API cada hora, normaliza los nombres de marca y guarda los precios en Supabase (PostgreSQL). El frontend consulta Supabase con fallback directo a la API del Ministerio si Supabase no esta disponible.

## Configuracion

### Requisitos

- Cuenta en [Supabase](https://supabase.com) (tier gratuito)
- Repositorio en GitHub (para GitHub Actions)

### Pasos

1. Crear proyecto en Supabase
2. Ejecutar `supabase/schema.sql` en el SQL Editor de Supabase
3. Habilitar extensiones `pg_cron` y `pg_net` en Database > Extensions
4. Anadir secretos en GitHub repo Settings > Secrets > Actions:
   - `SUPABASE_URL` — URL del proyecto (ej: `https://xxxxx.supabase.co`)
   - `SUPABASE_SERVICE_ROLE_KEY` — clave service_role (Settings > API)
5. Actualizar `SUPABASE_URL` y `SUPABASE_ANON_KEY` en `index.html`
6. Push a GitHub — el Action se ejecutara automaticamente cada hora

## Licencia

[MIT License](LICENSE)
