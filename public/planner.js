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

  const response = await fetch(`/api/plan?${params.toString()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Planner HTTP ${response.status}`);
  }

  return response.json();
}
