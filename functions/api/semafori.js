const SEMAFORI_CKAN_URL = 'https://opendata.comune.bari.it/api/3/action/datastore_search?resource_id=1b76f2d0-4a6c-4e8a-b31d-d006fbd42f7e&limit=5000';

const ONDA_VERDE_STREETS = [
  'VIA DANTE',
  'CORSO CAVOUR',
  'VIA DE GIOSA',
  'PIAZZA LUIGI DI SAVOIA',
  'VIA DE ROSSI',
  'CORSO VITTORIO EMANUELE II',
  'VIA QUINTINO SELLA',
  'VIALE EINAUDI',
  'VIALE KENNEDY',
  'VIA BRIGATA REGINA'
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function getField(record, candidates) {
  for (const key of candidates) {
    if (record[key] != null && String(record[key]).trim() !== '') {
      return record[key];
    }
  }
  return '';
}

function detectOndaVerdeStreet(indirizzo) {
  const normalized = normalizeText(indirizzo);
  for (const street of ONDA_VERDE_STREETS) {
    if (normalized.includes(normalizeText(street))) {
      return street;
    }
  }
  return '';
}

function toNumber(value) {
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, '').replace(',', '.');
    const n = Number(normalized);
    return Number.isNaN(n) ? NaN : n;
  }

  const n = Number(value);
  return Number.isNaN(n) ? NaN : n;
}

function normalizeRoadNameChunk(value) {
  return normalizeText(value)
    .replace(/\b(VIE|VIALE|VIA|CORSO|CSO|LUNGOMARE|LARGO|PIAZZA|P\.ZZA|PZZA|STRADA|S\.S\.)\b/g, ' ')
    .replace(/\b(CIV\.?\s*\d+|PASS\.?\s*PEDONALE|PASSAGGIO\s+PEDONALE)\b/g, ' ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyTrafficLightRecord(tipoIncrocio, indirizzo) {
  const tipo = normalizeText(tipoIncrocio);
  const address = normalizeText(indirizzo);

  if (tipo.includes('SOTTOPASSO')) {
    return false;
  }

  if (tipo.includes('SEMAF') || tipo.includes('TELEC')) {
    return true;
  }

  if (address.includes('SEMAFOR')) {
    return true;
  }

  return false;
}

function clampApproachCount(value) {
  const n = Number(value);
  if (Number.isNaN(n)) {
    return 1;
  }
  return Math.max(1, Math.min(8, Math.round(n)));
}

function estimateApproachCount(indirizzo) {
  const text = normalizeText(indirizzo);

  if (!text) {
    return { count: 1, source: 'default' };
  }

  if (text.includes('PASS PEDONALE') || text.includes('PASSAGGIO PEDONALE')) {
    return { count: 2, source: 'pedestrian' };
  }

  const chunks = text
    .split(/\s+-\s+|\s*\/\s*|\s*,\s*/)
    .map((item) => normalizeRoadNameChunk(item))
    .filter(Boolean);

  const roads = [...new Set(chunks)].length;

  if (roads >= 4) {
    return { count: 4, source: 'roads>=4' };
  }

  if (roads === 3) {
    return { count: 3, source: 'roads=3' };
  }

  if (roads === 2) {
    return { count: 4, source: 'roads=2' };
  }

  return { count: 1, source: 'roads<=1' };
}

function json(body, dataSource = 'ckan') {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Data-Source': dataSource
    }
  });
}

export async function onRequestGet() {
  try {
    const upstream = await fetch(SEMAFORI_CKAN_URL, {
      headers: {
        Accept: 'application/json,*/*'
      },
      cf: {
        cacheTtl: 1800,
        cacheEverything: true
      }
    });

    if (!upstream.ok) {
      return json([], 'unavailable');
    }

    const payload = await upstream.json();
    const records = Array.isArray(payload?.result?.records) ? payload.result.records : [];

    const normalized = [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      const idRaw = getField(record, ['id', 'Codice', '_id']) || String(index + 1);
      const idDigits = String(idRaw).replace(/\D/g, '');
      const id = idDigits ? `S${idDigits.padStart(3, '0')}` : `S${String(index + 1).padStart(3, '0')}`;

      const indirizzo = String(getField(record, ['name', 'INDIRIZZO', 'description']) || `Semaforo ${id}`).trim();
      const municipio = String(getField(record, ['MUNICIPIO', 'municipio', 'folders']) || '').trim();
      const tipoIncrocio = String(getField(record, ['TIPO', 'tipo', 'tipologia']) || 'standard').trim() || 'standard';

      if (!isLikelyTrafficLightRecord(tipoIncrocio, indirizzo)) {
        continue;
      }

      const lat = toNumber(getField(record, ['LATITUDINE', 'lat', 'LAT', 'latitude']));
      const lon = toNumber(getField(record, ['LONGITUDINE', 'lon', 'LON', 'longitude']));

      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        continue;
      }

      const ondaStreet = detectOndaVerdeStreet(indirizzo);
      const approach = estimateApproachCount(indirizzo);
      normalized.push({
        id,
        indirizzo,
        municipio,
        lat,
        lon,
        isOndaVerde: Boolean(ondaStreet),
        tipoIncrocio,
        ondaVerdeStreet: ondaStreet,
        ondaVerdeOrder: 0,
        approachCount: clampApproachCount(approach.count),
        approachCountSource: approach.source
      });
    }

    const groups = new Map();
    for (const item of normalized) {
      if (!item.isOndaVerde || !item.ondaVerdeStreet) {
        continue;
      }
      const list = groups.get(item.ondaVerdeStreet) || [];
      list.push(item);
      groups.set(item.ondaVerdeStreet, list);
    }

    for (const list of groups.values()) {
      list.sort((a, b) => a.lon - b.lon || a.lat - b.lat);
      list.forEach((item, idx) => {
        item.ondaVerdeOrder = idx;
      });
    }

    const cleaned = normalized.map((item) => ({
      id: item.id,
      indirizzo: item.indirizzo,
      municipio: item.municipio,
      lat: item.lat,
      lon: item.lon,
      isOndaVerde: item.isOndaVerde,
      tipoIncrocio: item.tipoIncrocio,
      ondaVerdeOrder: item.ondaVerdeOrder,
      approachCount: item.approachCount,
      approachCountSource: item.approachCountSource
    }));

    return json(cleaned, 'ckan');
  } catch {
    return json([], 'unavailable');
  }
}
