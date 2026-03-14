-- ============================================
-- MuDiesel — Esquema de base de datos Supabase
-- Ejecutar en el SQL Editor de Supabase
-- ============================================

-- 1. Tabla de normalización de marcas
-- Mapea los nombres "sucios" del Ministerio a nombres actualizados
CREATE TABLE normalizacion_marcas (
  nombre_ministerio TEXT PRIMARY KEY,
  nombre_normalizado TEXT NOT NULL
);

-- Datos iniciales de normalización
INSERT INTO normalizacion_marcas (nombre_ministerio, nombre_normalizado) VALUES
  ('CEPSA', 'Moeve'),
  ('CEDIPSA', 'Moeve'),
  ('GALP ENERGIA', 'Galp'),
  ('GALP', 'Galp'),
  ('BP OIL ESPAÑA', 'BP'),
  ('BP', 'BP'),
  ('REPSOL COMERCIAL', 'Repsol'),
  ('REPSOL', 'Repsol'),
  ('CAMPSA', 'Repsol'),
  ('PETRONOR', 'Repsol'),
  ('SHELL', 'Shell'),
  ('BONAREA', 'bonÀrea'),
  ('ALCAMPO', 'Alcampo'),
  ('CARREFOUR', 'Carrefour'),
  ('EROSKI', 'Eroski'),
  ('PLENOIL', 'Plenoil'),
  ('BALLENOIL', 'Ballenoil'),
  ('PETROPRIX', 'Petroprix'),
  ('AVIA', 'AVIA'),
  ('DISA', 'DISA'),
  ('MEROIL', 'Meroil'),
  ('TAMOIL', 'Tamoil'),
  ('Q8', 'Q8'),
  ('ESCLAT', 'Esclat'),
  ('E.LECLERC', 'E.Leclerc'),
  ('COSTCO', 'Costco'),
  ('MAKRO', 'Makro')
ON CONFLICT (nombre_ministerio) DO UPDATE SET nombre_normalizado = EXCLUDED.nombre_normalizado;

-- 2. Tabla de gasolineras (catálogo)
CREATE TABLE gasolineras (
  id TEXT PRIMARY KEY,              -- IDEESS del Ministerio
  nombre_original TEXT,             -- Rótulo tal cual viene del Ministerio
  nombre TEXT,                      -- Nombre normalizado (tras aplicar mapeo)
  direccion TEXT,
  localidad TEXT,
  provincia TEXT,
  cp TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  horario_declarado TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Índice geográfico para futuras consultas por zona
CREATE INDEX idx_gasolineras_coords ON gasolineras (lat, lng);

-- 3. Tabla de precios (histórico)
CREATE TABLE precios (
  id BIGSERIAL PRIMARY KEY,
  gasolinera_id TEXT NOT NULL REFERENCES gasolineras(id) ON DELETE CASCADE,
  combustible TEXT NOT NULL,        -- 'diesel', 'g95', 'g98'
  precio DOUBLE PRECISION NOT NULL,
  fecha_ministerio TIMESTAMPTZ,     -- Fecha del dataset del Ministerio
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Índice para consultas de "último precio por gasolinera y combustible"
CREATE INDEX idx_precios_lookup ON precios (gasolinera_id, combustible, created_at DESC);

-- Índice para limpiar datos antiguos
CREATE INDEX idx_precios_created ON precios (created_at);

-- 4. Tabla de confirmaciones comunitarias (Fase 2, se crea vacía)
CREATE TABLE confirmaciones (
  id BIGSERIAL PRIMARY KEY,
  gasolinera_id TEXT NOT NULL REFERENCES gasolineras(id) ON DELETE CASCADE,
  combustible TEXT NOT NULL,
  precio_confirmado DOUBLE PRECISION,
  es_correcto BOOLEAN DEFAULT true,  -- true = confirma, false = reporta incorrecto
  ip_hash TEXT,                       -- hash de IP para rate limiting básico
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_confirmaciones_lookup ON confirmaciones (gasolinera_id, combustible, created_at DESC);

-- 5. Tabla de metadatos (precio medio nacional, fecha último cron, etc.)
CREATE TABLE metadatos (
  clave TEXT PRIMARY KEY,
  valor JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 6. Vista: último precio por gasolinera y combustible
-- Esto es lo que el frontend consultará
CREATE OR REPLACE VIEW v_ultimos_precios AS
SELECT DISTINCT ON (p.gasolinera_id, p.combustible)
  p.gasolinera_id,
  p.combustible,
  p.precio,
  p.fecha_ministerio,
  p.created_at,
  g.nombre,
  g.nombre_original,
  g.direccion,
  g.localidad,
  g.provincia,
  g.lat,
  g.lng
FROM precios p
JOIN gasolineras g ON g.id = p.gasolinera_id
ORDER BY p.gasolinera_id, p.combustible, p.created_at DESC;

-- 7. Row Level Security (RLS)
-- Permitir lectura pública, escritura solo desde service_role (Edge Functions)

ALTER TABLE gasolineras ENABLE ROW LEVEL SECURITY;
ALTER TABLE precios ENABLE ROW LEVEL SECURITY;
ALTER TABLE confirmaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE normalizacion_marcas ENABLE ROW LEVEL SECURITY;
ALTER TABLE metadatos ENABLE ROW LEVEL SECURITY;

-- Políticas de lectura pública
CREATE POLICY "Lectura pública gasolineras" ON gasolineras FOR SELECT USING (true);
CREATE POLICY "Lectura pública precios" ON precios FOR SELECT USING (true);
CREATE POLICY "Lectura pública confirmaciones" ON confirmaciones FOR SELECT USING (true);
CREATE POLICY "Lectura pública normalizacion" ON normalizacion_marcas FOR SELECT USING (true);
CREATE POLICY "Lectura pública metadatos" ON metadatos FOR SELECT USING (true);

-- Políticas de escritura: solo service_role (las Edge Functions usan service_role key)
-- No se necesitan políticas INSERT/UPDATE/DELETE para anon porque RLS las bloquea por defecto

-- Política para que usuarios anónimos puedan insertar confirmaciones (Fase 2)
CREATE POLICY "Insertar confirmaciones anon" ON confirmaciones
  FOR INSERT WITH CHECK (true);

-- 8. Función para limpiar precios antiguos (>90 días)
-- Ejecutar periódicamente para no llenar la DB gratuita
CREATE OR REPLACE FUNCTION limpiar_precios_antiguos()
RETURNS void AS $$
BEGIN
  DELETE FROM precios WHERE created_at < now() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
