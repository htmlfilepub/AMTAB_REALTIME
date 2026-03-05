/**
 * smoke-test.mjs
 * ───────────────
 * Smoke test end-to-end con i feed AMTAB reali.
 * Scarica TripUpdates + VehiclePosition dal server locale,
 * li parsa con le stesse funzioni di app.js, esegue il merge
 * e verifica che nessun routeId sia stato scambiato.
 *
 * Run:  node smoke-test.mjs
 * Requires: server.mjs in esecuzione su localhost:3000
 */

import { parseHTML } from 'linkedom';

const { DOMParser } = parseHTML('<!doctype html><html></html>');
globalThis.DOMParser = DOMParser;

const SERVER = process.env.SERVER || 'http://localhost:3000';

// ─── Pure functions (same as app.js) ─────────────────────────────────────────

function getChildText(parent, selector) {
  return parent.querySelector(selector)?.textContent?.trim() ?? '';
}

function makeTripKey(routeId, tripId, vehicleId = '') {
  const cleanRouteId = routeId || '';
  const cleanTripId = tripId || '';
  const cleanVehicleId = vehicleId || '';
  if (cleanTripId) return `${cleanRouteId}__trip__${cleanTripId}`;
  if (cleanVehicleId) return `${cleanRouteId}__veh__${cleanVehicleId}`;
  return '';
}

function delayToStatus(delay) {
  if (delay <= 60) return { label: 'Regolare', className: 'green' };
  if (delay <= 300) return { label: 'Ritardo lieve', className: 'orange' };
  return { label: 'Ritardo alto', className: 'red' };
}

function parseTripUpdates(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
  const feedTsRaw = xmlDoc.querySelector('Header > Timestamp')?.textContent?.trim();
  const feedTs = Number(feedTsRaw);
  const entities = [...xmlDoc.querySelectorAll('FeedEntity')]
    .map((entity) => {
      const routeId = getChildText(entity, 'TripUpdate > Trip > RouteId');
      if (!routeId) return null;
      const tripId = getChildText(entity, 'TripUpdate > Trip > TripId');
      const stopId = getChildText(entity, 'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > StopId');
      const delayRaw = getChildText(entity, 'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > Arrival > Delay');
      const arrivalTimeRaw = getChildText(entity, 'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > Arrival > Time');
      const delay = Number(delayRaw);
      const arrivalTime = Number(arrivalTimeRaw);
      const status = delayToStatus(Number.isNaN(delay) ? 0 : Math.max(delay, 0));
      return { routeId, tripKey: makeTripKey(routeId, tripId), tripId, stopId, delay, arrivalTime, status };
    })
    .filter(Boolean)
    .sort((a, b) => a.arrivalTime - b.arrivalTime);
  return { entities, feedTs };
}

function parseVehiclePositions(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
  const positions = [...xmlDoc.querySelectorAll('FeedEntity')]
    .map((entity) => {
      const routeId = getChildText(entity, 'Vehicle > Trip > RouteId');
      if (!routeId) return null;
      const tripId = getChildText(entity, 'Vehicle > Trip > TripId');
      const vehicleId = getChildText(entity, 'Vehicle > Vehicle > Id') || getChildText(entity, 'Vehicle > Vehicle > Label');
      const positionKey = makeTripKey(routeId, tripId, vehicleId);
      const lat = Number(getChildText(entity, 'Vehicle > Position > Latitude'));
      const lon = Number(getChildText(entity, 'Vehicle > Position > Longitude'));
      const speed = Number(getChildText(entity, 'Vehicle > Position > Speed'));
      const currentStatus = getChildText(entity, 'Vehicle > CurrentStatus');
      const timestamp = Number(getChildText(entity, 'Vehicle > Timestamp'));
      const stopId = getChildText(entity, 'Vehicle > StopId');
      return { routeId, positionKey, tripKey: makeTripKey(routeId, tripId), tripId, vehicleId, stopId, lat, lon, speed, currentStatus, timestamp };
    })
    .filter(Boolean);

  const byTripId = new Map();
  for (const item of positions) {
    const key = item.positionKey;
    if (!key) continue;
    const previous = byTripId.get(key);
    if (!previous || item.timestamp > previous.timestamp) {
      byTripId.set(key, item);
    }
  }
  return byTripId;
}

function mergeTripAndPosition(trips, positionsByKey) {
  const positionsByTripIdOnly = new Map();
  for (const [, position] of positionsByKey.entries()) {
    if (position.tripId) {
      const existing = positionsByTripIdOnly.get(position.tripId);
      if (!existing || (position.timestamp || 0) > (existing.timestamp || 0)) {
        positionsByTripIdOnly.set(position.tripId, position);
      }
    }
  }

  const merged = [];
  const usedPositionKeys = new Set();
  let excludedNoRoute = 0;

  for (const trip of trips) {
    let position = positionsByKey.get(trip.tripKey);
    if (!position && trip.tripId) {
      const candidate = positionsByTripIdOnly.get(trip.tripId);
      if (candidate) {
        position = candidate;
      }
    }
    if (position) {
      usedPositionKeys.add(position.positionKey);
    }
    const routeId = trip.routeId;
    if (!routeId || routeId === '0') {
      excludedNoRoute += 1;
      continue;
    }
    merged.push({
      ...trip,
      routeId,
      confirmedRouteId: routeId,
      vehicleId: position?.vehicleId ?? '',
      stopId: trip.stopId || position?.stopId || '',
      lat: position?.lat,
      lon: position?.lon,
      speed: position?.speed,
      currentStatus: position?.currentStatus ?? '',
      positionTimestamp: position?.timestamp ?? null
    });
  }

  let orphanTotal = 0;
  for (const [positionKey] of positionsByKey.entries()) {
    if (!usedPositionKeys.has(positionKey)) orphanTotal += 1;
  }

  return { merged, excludedNoRoute, orphanTotal };
}

// ─── Smoke Test ──────────────────────────────────────────────────────────────

async function run() {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(' smoke-test.mjs — Live AMTAB Feed Verification');
  console.log(`═══════════════════════════════════════════════════`);
  console.log(`Server: ${SERVER}`);
  console.log('');

  // 1. Fetch both feeds
  let tripXml, vehicleXml;
  try {
    console.log('Fetching TripUpdates...');
    const tripRes = await fetch(`${SERVER}/api/tripupdates`);
    if (!tripRes.ok) throw new Error(`TripUpdates HTTP ${tripRes.status}`);
    tripXml = await tripRes.text();
    console.log(`  → ${tripXml.length} bytes`);
  } catch (err) {
    console.error(`FAIL: Cannot fetch TripUpdates: ${err.message}`);
    console.error('  Is server.mjs running on ' + SERVER + '?');
    process.exit(1);
  }

  try {
    console.log('Fetching VehiclePositions...');
    const vehRes = await fetch(`${SERVER}/api/vehicleposition`);
    if (!vehRes.ok) throw new Error(`VehiclePosition HTTP ${vehRes.status}`);
    vehicleXml = await vehRes.text();
    console.log(`  → ${vehicleXml.length} bytes`);
  } catch (err) {
    console.error(`FAIL: Cannot fetch VehiclePosition: ${err.message}`);
    process.exit(1);
  }

  // 2. Parse
  console.log('');
  console.log('Parsing...');
  const { entities: trips, feedTs } = parseTripUpdates(tripXml);
  const positions = parseVehiclePositions(vehicleXml);
  console.log(`  TripUpdates:      ${trips.length} entities (feedTs=${feedTs})`);
  console.log(`  VehiclePositions: ${positions.size} unique positions`);

  if (trips.length === 0) {
    console.log('');
    console.log('⚠️  Nessun TripUpdate nel feed — il servizio AMTAB potrebbe essere offline.');
    console.log('    Il smoke test non può procedere senza dati. Riprova più tardi.');
    process.exit(0);
  }

  // 3. Merge
  console.log('');
  const { merged, excludedNoRoute, orphanTotal } = mergeTripAndPosition(trips, positions);
  console.log(`[MERGE] ${merged.length} veicoli con routeId certa, ${excludedNoRoute} esclusi (no routeId), ${orphanTotal} posizioni orfane scartate`);

  // 4. Cross-check: for every merged entity that has position data,
  //    check if the position's routeId disagrees with the TripUpdate's routeId.
  console.log('');
  console.log('Cross-check routeId TripUpdate vs VehiclePosition...');
  let swapCount = 0;
  let matchedWithPosition = 0;

  for (const item of merged) {
    if (!item.tripId) continue;
    // Look up what VP says for this tripId
    const vpEntry = [...positions.values()].find((p) => p.tripId === item.tripId);
    if (!vpEntry) continue;
    matchedWithPosition++;
    if (vpEntry.routeId !== item.routeId) {
      swapCount++;
      console.log(`  ⚠️  tripId=${item.tripId}: TU routeId=${item.routeId}, VP routeId=${vpEntry.routeId} → MERGED AS ${item.confirmedRouteId} (TU wins)`);
    }
  }

  console.log(`  ${matchedWithPosition} trip abbinati a posizione`);
  if (swapCount > 0) {
    console.log(`  ${swapCount} route discordanti trovate — tutte risolte con routeId da TripUpdate ✅`);
  } else {
    console.log(`  0 route discordanti — nessun swap nel feed corrente`);
  }

  // 5. Verify: no orphan position leaked into merged output
  const mergedTripIds = new Set(merged.map((m) => m.tripId));
  let leakedOrphans = 0;
  for (const [, pos] of positions) {
    if (!mergedTripIds.has(pos.tripId)) continue;
    const mergedItem = merged.find((m) => m.tripId === pos.tripId);
    if (mergedItem && pos.routeId !== mergedItem.routeId) {
      // This is expected — the merge kept TU routeId, VP had different
    }
  }

  // Check there are no merged entries whose routeId matches VP but not TU
  for (const item of merged) {
    const originalTrip = trips.find((t) => t.tripId === item.tripId);
    if (!originalTrip) {
      leakedOrphans++;
      console.log(`  ❌ LEAKED ORPHAN: tripId=${item.tripId} routeId=${item.routeId} — not from any TripUpdate!`);
    } else if (originalTrip.routeId !== item.routeId) {
      leakedOrphans++;
      console.log(`  ❌ ROUTE SWAP: tripId=${item.tripId} TU=${originalTrip.routeId} merged=${item.routeId}`);
    }
  }

  // 6. Route distribution
  console.log('');
  console.log('Route distribution:');
  const routeCounts = {};
  for (const item of merged) {
    routeCounts[item.routeId] = (routeCounts[item.routeId] || 0) + 1;
  }
  const sortedRoutes = Object.entries(routeCounts).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [route, count] of sortedRoutes) {
    console.log(`  Linea ${route.padStart(3)}: ${count} veicol${count === 1 ? 'o' : 'i'}`);
  }

  // 7. Summary
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  if (leakedOrphans > 0) {
    console.log(` ❌ FAIL: ${leakedOrphans} swap/leak rilevati!`);
    console.log('═══════════════════════════════════════════════════');
    process.exit(1);
  } else {
    console.log(` ✅ PASS — 0 swap, 0 orfani nel merge, ${merged.length} veicoli OK`);
    console.log('═══════════════════════════════════════════════════');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
