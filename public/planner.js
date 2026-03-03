function apiUrl(pathAndQuery) {
  const normalized = String(pathAndQuery || '').replace(/^\/+/, '');
  return new URL(normalized, import.meta.url).toString();
}

function apiRootUrl(pathAndQuery) {
  const normalized = String(pathAndQuery || '').replace(/^\/+/, '');
  if (typeof window === 'undefined') {
    return `/${normalized}`;
  }
  return new URL(`/${normalized}`, window.location.origin).toString();
}

function buildApiCandidates(pathAndQuery) {
  const candidates = [apiRootUrl(pathAndQuery), apiUrl(pathAndQuery)];
  return [...new Set(candidates)];
}

export async function requestStaticPlan({
  origin,
  destinationStopId,
  destinationPoint,
  maxWalkMeters,
  destinationRadiusMeters,
  maxLookAheadSeconds,
  allowTransfers,
  maxTransfers
}) {
  const params = new URLSearchParams({
    originLat: String(origin.lat),
    originLon: String(origin.lon),
    destinationStopId,
    maxWalkMeters: String(maxWalkMeters),
    destinationRadiusMeters: String(destinationRadiusMeters),
    maxLookAheadSeconds: String(maxLookAheadSeconds)
  });

  if (destinationPoint?.lat != null && destinationPoint?.lon != null) {
    params.set('destinationLat', String(destinationPoint.lat));
    params.set('destinationLon', String(destinationPoint.lon));
  }

  if (allowTransfers != null) {
    params.set('allowTransfers', allowTransfers ? '1' : '0');
  }

  if (maxTransfers != null) {
    params.set('maxTransfers', String(maxTransfers));
  }

  let lastError = null;
  const endpoints = buildApiCandidates(`api/plan?${params.toString()}`);

  for (const endpoint of endpoints) {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) {
      lastError = new Error(`Planner HTTP ${response.status}`);
      continue;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      const raw = await response.text();
      const preview = raw.slice(0, 80).replace(/\s+/g, ' ').trim();
      lastError = new Error(`Planner non restituisce JSON valido (${preview || 'risposta vuota'})`);
      continue;
    }

    return response.json();
  }

  throw lastError || new Error('Planner non disponibile');
}
