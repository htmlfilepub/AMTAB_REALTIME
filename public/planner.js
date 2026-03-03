function apiUrl(pathAndQuery) {
  const normalized = String(pathAndQuery || '').replace(/^\/+/, '');
  return new URL(normalized, import.meta.url).toString();
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

  const response = await fetch(apiUrl(`api/plan?${params.toString()}`), { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Planner HTTP ${response.status}`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const raw = await response.text();
    const preview = raw.slice(0, 80).replace(/\s+/g, ' ').trim();
    throw new Error(`Planner non restituisce JSON valido (${preview || 'risposta vuota'})`);
  }

  return response.json();
}
