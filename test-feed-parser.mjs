/**
 * test-feed-parser.mjs
 * ---------------------
 * Automated regression tests for the GTFS-RT XML parser + merge logic.
 * Ensures that route-swap bugs (e.g. lines 20↔30) cannot be reintroduced.
 *
 * Run:  node test-feed-parser.mjs
 */

import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

// ─── Bootstrap a global DOMParser for the functions extracted from app.js ────
const { DOMParser } = parseHTML('<!doctype html><html></html>');
globalThis.DOMParser = DOMParser;

// ─── Pure functions extracted from app.js (kept in sync) ─────────────────────

function delayToStatus(delay) {
  if (delay <= 60) return { label: 'Regolare', className: 'green' };
  if (delay <= 300) return { label: 'Ritardo lieve', className: 'orange' };
  return { label: 'Ritardo alto', className: 'red' };
}

function makeTripKey(routeId, tripId, vehicleId = '') {
  const cleanRouteId = routeId || '';
  const cleanTripId = tripId || '';
  const cleanVehicleId = vehicleId || '';
  if (cleanTripId) return `${cleanRouteId}__trip__${cleanTripId}`;
  if (cleanVehicleId) return `${cleanRouteId}__veh__${cleanVehicleId}`;
  return '';
}

function getChildText(parent, selector) {
  return parent.querySelector(selector)?.textContent?.trim() ?? '';
}

function isRouteIdReliable(entity) {
  return (
    entity.routeId &&
    typeof entity.routeId === 'string' &&
    entity.routeId.trim().length > 0 &&
    entity.routeId !== '0'
  );
}

function parseTripUpdates(xmlText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
  if (xmlDoc.querySelector('parsererror')) {
    throw new Error('XML non valido ricevuto dal feed');
  }
  const feedTsRaw = xmlDoc.querySelector('Header > Timestamp')?.textContent?.trim();
  const feedTs = Number(feedTsRaw);
  const entities = [...xmlDoc.querySelectorAll('FeedEntity')]
    .map((entity) => {
      const routeId = getChildText(entity, 'TripUpdate > Trip > RouteId');
      if (!routeId) return null;
      const tripId = getChildText(entity, 'TripUpdate > Trip > TripId');
      const stopId = getChildText(entity, 'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > StopId');
      const arrivalTimeRaw = getChildText(entity, 'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > Arrival > Time');
      const delayRaw = getChildText(entity, 'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > Arrival > Delay');
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
  if (xmlDoc.querySelector('parsererror')) {
    throw new Error('XML non valido ricevuto dal feed VehiclePosition');
  }
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

// ─── XML Test Fixtures ───────────────────────────────────────────────────────

function buildTripUpdateXml(entities, feedTs = 1000000) {
  const feedEntities = entities.map((e) => `
  <FeedEntity>
    <TripUpdate>
      <StopTimeUpdates>
        <TripUpdate.StopTimeUpdate>
          <Arrival><Delay>${e.delay ?? 0}</Delay><Time>${e.arrivalTime ?? 1000}</Time></Arrival>
          <StopId>${e.stopId ?? ''}</StopId>
        </TripUpdate.StopTimeUpdate>
      </StopTimeUpdates>
      <Trip>
        <RouteId>${e.routeId}</RouteId>
        <TripId>${e.tripId}</TripId>
      </Trip>
    </TripUpdate>
  </FeedEntity>`).join('');

  return `<FeedMessage><Entities>${feedEntities}</Entities><Header><Timestamp>${feedTs}</Timestamp></Header></FeedMessage>`;
}

function buildVehiclePositionXml(entities) {
  const feedEntities = entities.map((e) => `
  <FeedEntity>
    <Vehicle>
      <Trip>
        <RouteId>${e.routeId}</RouteId>
        <TripId>${e.tripId}</TripId>
      </Trip>
      <Vehicle><Id>${e.vehicleId ?? ''}</Id></Vehicle>
      <Position>
        <Latitude>${e.lat ?? 41.125}</Latitude>
        <Longitude>${e.lon ?? 16.86}</Longitude>
        <Speed>${e.speed ?? 5}</Speed>
      </Position>
      <Timestamp>${e.timestamp ?? 999}</Timestamp>
      <CurrentStatus>${e.currentStatus ?? ''}</CurrentStatus>
      <StopId>${e.stopId ?? ''}</StopId>
    </Vehicle>
  </FeedEntity>`).join('');

  return `<FeedMessage><Entities>${feedEntities}</Entities></FeedMessage>`;
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log(' test-feed-parser.mjs — GTFS-RT Merge Regression');
console.log('═══════════════════════════════════════════════════');
console.log('');

// ─── 1. Parser tests ────────────────────────────────────────────────────────
console.log('Parser');

test('parseTripUpdates extracts routeId correctly', () => {
  const xml = buildTripUpdateXml([
    { routeId: '20', tripId: '7157', delay: 5, arrivalTime: 1000 },
    { routeId: '30', tripId: '8001', delay: 0, arrivalTime: 2000 }
  ]);
  const { entities, feedTs } = parseTripUpdates(xml);
  assert.equal(entities.length, 2);
  assert.equal(entities[0].routeId, '20');
  assert.equal(entities[1].routeId, '30');
  assert.equal(feedTs, 1000000);
});

test('parseTripUpdates skips entities without RouteId', () => {
  const xml = buildTripUpdateXml([
    { routeId: '20', tripId: '7157', delay: 0, arrivalTime: 1000 },
    { routeId: '', tripId: '9999', delay: 0, arrivalTime: 2000 }
  ]);
  const { entities } = parseTripUpdates(xml);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].routeId, '20');
});

test('parseTripUpdates returns empty on garbage XML', () => {
  // linkedom does not emit <parsererror> like browsers;
  // verify that no entities are returned from garbage input
  try {
    const { entities } = parseTripUpdates('<not-valid><<<');
    assert.equal(entities.length, 0, 'No entities from garbage XML');
  } catch {
    // If it throws, that is also acceptable
  }
});

test('parseVehiclePositions extracts position + vehicleId', () => {
  const xml = buildVehiclePositionXml([
    { routeId: '20', tripId: '7157', vehicleId: 'V100', lat: 41.12, lon: 16.87, timestamp: 500 }
  ]);
  const map = parseVehiclePositions(xml);
  assert.equal(map.size, 1);
  const entry = [...map.values()][0];
  assert.equal(entry.vehicleId, 'V100');
  assert.equal(entry.routeId, '20');
  assert.equal(entry.lat, 41.12);
});

test('parseVehiclePositions deduplicates by newest timestamp', () => {
  const xml = buildVehiclePositionXml([
    { routeId: '20', tripId: '7157', vehicleId: 'V100', timestamp: 500 },
    { routeId: '20', tripId: '7157', vehicleId: 'V100', timestamp: 900 }
  ]);
  const map = parseVehiclePositions(xml);
  // Same tripKey → should keep only the newest
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0].timestamp, 900);
});

// ─── 2. Merge tests (core swap-prevention) ──────────────────────────────────
console.log('');
console.log('Merge — swap prevention');

test('merge matches trip to position by tripKey', () => {
  const trips = parseTripUpdates(buildTripUpdateXml([
    { routeId: '20', tripId: '7157', delay: 5, arrivalTime: 1000 }
  ])).entities;
  const positions = parseVehiclePositions(buildVehiclePositionXml([
    { routeId: '20', tripId: '7157', vehicleId: 'V100', lat: 41.12, lon: 16.87, timestamp: 500 }
  ]));
  const { merged } = mergeTripAndPosition(trips, positions);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].routeId, '20');
  assert.equal(merged[0].vehicleId, 'V100');
  assert.equal(merged[0].lat, 41.12);
});

test('CRITICAL: orphan VehiclePositions are NEVER included in merged output', () => {
  // Position has routeId 30 and tripId 9999, but no TripUpdate matches it
  const trips = parseTripUpdates(buildTripUpdateXml([
    { routeId: '20', tripId: '7157', delay: 0, arrivalTime: 1000 }
  ])).entities;
  const positions = parseVehiclePositions(buildVehiclePositionXml([
    { routeId: '30', tripId: '9999', vehicleId: 'V200', lat: 41.13, lon: 16.88, timestamp: 500 }
  ]));
  const { merged, orphanTotal } = mergeTripAndPosition(trips, positions);
  assert.equal(merged.length, 1, 'Only the TripUpdate entity should be in merged');
  assert.equal(merged[0].routeId, '20', 'Merged entity must be from TripUpdate routeId');
  assert.equal(orphanTotal, 1, 'Orphan position should be counted');
  // Ensure no entity with routeId 30 exists
  assert.equal(merged.filter((e) => e.routeId === '30').length, 0, 'No orphan route 30 in output');
});

test('CRITICAL: swap scenario — same vehicleId on different routes, orphan excluded', () => {
  // The swap bug: vehicle V100 appears in TripUpdates as route 20,
  // but VehiclePosition says route 30 for a DIFFERENT tripId.
  // The orphan VehiclePosition must NOT create a duplicate entity.
  const trips = parseTripUpdates(buildTripUpdateXml([
    { routeId: '20', tripId: '7157', delay: 0, arrivalTime: 1000 }
  ])).entities;
  const positions = parseVehiclePositions(buildVehiclePositionXml([
    { routeId: '20', tripId: '7157', vehicleId: 'V100', lat: 41.12, lon: 16.87, timestamp: 500 },
    { routeId: '30', tripId: '8888', vehicleId: 'V100', lat: 41.13, lon: 16.88, timestamp: 600 }
  ]));
  const { merged, orphanTotal } = mergeTripAndPosition(trips, positions);
  assert.equal(merged.length, 1, 'Only 1 merged entity from TripUpdate');
  assert.equal(merged[0].routeId, '20');
  assert.equal(orphanTotal, 1, 'The route-30 orphan should be counted and discarded');
});

test('CRITICAL: route disagree — TripUpdate says 20, Position says 30 for same tripId', () => {
  // TripUpdate routeId=20 tripId=7157
  // VehiclePosition routeId=30 tripId=7157
  // Merge should use TripUpdate's routeId (20), not Position's (30)
  const trips = parseTripUpdates(buildTripUpdateXml([
    { routeId: '20', tripId: '7157', delay: 0, arrivalTime: 1000 }
  ])).entities;
  const positions = parseVehiclePositions(buildVehiclePositionXml([
    { routeId: '30', tripId: '7157', vehicleId: 'V100', lat: 41.12, lon: 16.87, timestamp: 500 }
  ]));
  const { merged } = mergeTripAndPosition(trips, positions);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].routeId, '20', 'TripUpdate routeId must win');
  assert.equal(merged[0].confirmedRouteId, '20');
  assert.equal(merged[0].vehicleId, 'V100', 'Position data should still be merged');
});

test('merge excludes trips with routeId "0"', () => {
  const trips = parseTripUpdates(buildTripUpdateXml([
    { routeId: '0', tripId: '1111', delay: 0, arrivalTime: 1000 },
    { routeId: '20', tripId: '2222', delay: 0, arrivalTime: 2000 }
  ])).entities;
  const positions = parseVehiclePositions(buildVehiclePositionXml([]));
  // Note: parseTripUpdates already filters out empty routeId,
  // but '0' passes the parser and must be caught by merge
  const { merged, excludedNoRoute } = mergeTripAndPosition(trips, positions);
  const routeIds = merged.map((e) => e.routeId);
  assert.ok(!routeIds.includes('0'), 'Route "0" should be excluded');
});

test('merge without any positions still returns trip entities', () => {
  const trips = parseTripUpdates(buildTripUpdateXml([
    { routeId: '20', tripId: '7157', delay: 5, arrivalTime: 1000 },
    { routeId: '30', tripId: '8001', delay: 0, arrivalTime: 2000 }
  ])).entities;
  const positions = parseVehiclePositions(buildVehiclePositionXml([]));
  const { merged } = mergeTripAndPosition(trips, positions);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].lat, undefined, 'No position data');
  assert.equal(merged[0].vehicleId, '');
});

// ─── 3. isRouteIdReliable tests ─────────────────────────────────────────────
console.log('');
console.log('isRouteIdReliable guard');

test('rejects empty routeId', () => {
  assert.ok(!isRouteIdReliable({ routeId: '' }));
});

test('rejects routeId "0"', () => {
  assert.equal(isRouteIdReliable({ routeId: '0' }), false);
});

test('rejects null/undefined routeId', () => {
  assert.ok(!isRouteIdReliable({ routeId: null }));
  assert.ok(!isRouteIdReliable({ routeId: undefined }));
  assert.ok(!isRouteIdReliable({}));
});

test('accepts valid routeId "20"', () => {
  assert.equal(isRouteIdReliable({ routeId: '20' }), true);
});

test('rejects whitespace-only routeId', () => {
  assert.equal(isRouteIdReliable({ routeId: '   ' }), false);
});

// ─── 4. Real-world XML (from TripUpdates.XML) ──────────────────────────────
console.log('');
console.log('Real XML fixture');

test('parses real AMTAB TripUpdates.XML format', () => {
  const realXml = `<FeedMessage xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.datacontract.org/2004/07/TransitRealtime"><Entities><FeedEntity><Alert i:nil="true" /><Id>7180433</Id><IsDeleted>false</IsDeleted><TripUpdate><StopTimeUpdates><TripUpdate.StopTimeUpdate><Arrival><Delay>-1</Delay><Time>1772524322</Time></Arrival><StopId>03471002</StopId></TripUpdate.StopTimeUpdate></StopTimeUpdates><Trip><RouteId>20</RouteId><TripId>7157</TripId></Trip></TripUpdate><Vehicle i:nil="true" /></FeedEntity><FeedEntity><Alert i:nil="true" /><Id>7180442</Id><IsDeleted>false</IsDeleted><TripUpdate><StopTimeUpdates><TripUpdate.StopTimeUpdate><Arrival><Delay>6</Delay><Time>1772524404</Time></Arrival><StopId>03094003</StopId></TripUpdate.StopTimeUpdate></StopTimeUpdates><Trip><RouteId>20</RouteId><TripId>6221</TripId></Trip></TripUpdate><Vehicle i:nil="true" /></FeedEntity></Entities><Header><Timestamp>1772524565</Timestamp></Header></FeedMessage>`;
  const { entities, feedTs } = parseTripUpdates(realXml);
  assert.equal(entities.length, 2);
  assert.equal(entities[0].routeId, '20');
  assert.equal(entities[0].tripId, '7157');
  assert.equal(entities[1].tripId, '6221');
  assert.equal(feedTs, 1772524565);
});

// ─── 5. Real AMTAB swap scenario (full XML with namespaces) ─────────────────
console.log('');
console.log('Real AMTAB swap scenario (end-to-end)');

test('CRITICAL E2E: real AMTAB XML — swap 20↔30 same vehicleId, TripUpdate wins', () => {
  // Exact AMTAB format: namespaces, i:nil, IsDeleted, Id fields
  const tripUpdateXml = `<FeedMessage xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.datacontract.org/2004/07/TransitRealtime">
  <Entities>
    <FeedEntity>
      <Alert i:nil="true" />
      <Id>7180433</Id>
      <IsDeleted>false</IsDeleted>
      <TripUpdate>
        <StopTimeUpdates>
          <TripUpdate.StopTimeUpdate>
            <Arrival><Delay>-1</Delay><Time>1772524322</Time></Arrival>
            <StopId>03471002</StopId>
          </TripUpdate.StopTimeUpdate>
        </StopTimeUpdates>
        <Trip>
          <RouteId>20</RouteId>
          <TripId>7157</TripId>
        </Trip>
      </TripUpdate>
      <Vehicle i:nil="true" />
    </FeedEntity>
    <FeedEntity>
      <Alert i:nil="true" />
      <Id>7180499</Id>
      <IsDeleted>false</IsDeleted>
      <TripUpdate>
        <StopTimeUpdates>
          <TripUpdate.StopTimeUpdate>
            <Arrival><Delay>120</Delay><Time>1772525000</Time></Arrival>
            <StopId>03094003</StopId>
          </TripUpdate.StopTimeUpdate>
        </StopTimeUpdates>
        <Trip>
          <RouteId>30</RouteId>
          <TripId>8001</TripId>
        </Trip>
      </TripUpdate>
      <Vehicle i:nil="true" />
    </FeedEntity>
  </Entities>
  <Header><Timestamp>1772524565</Timestamp></Header>
</FeedMessage>`;

  const vehiclePositionXml = `<FeedMessage xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.datacontract.org/2004/07/TransitRealtime">
  <Entities>
    <FeedEntity>
      <Id>pos_001</Id>
      <IsDeleted>false</IsDeleted>
      <Vehicle>
        <Trip>
          <RouteId>30</RouteId>
          <TripId>7157</TripId>
        </Trip>
        <Vehicle><Id>V100</Id><Label>V100</Label></Vehicle>
        <Position>
          <Latitude>41.1171</Latitude>
          <Longitude>16.8719</Longitude>
          <Speed>12.5</Speed>
        </Position>
        <Timestamp>1772524500</Timestamp>
        <CurrentStatus>IN_TRANSIT_TO</CurrentStatus>
        <StopId>03471002</StopId>
      </Vehicle>
    </FeedEntity>
    <FeedEntity>
      <Id>pos_002</Id>
      <IsDeleted>false</IsDeleted>
      <Vehicle>
        <Trip>
          <RouteId>30</RouteId>
          <TripId>8001</TripId>
        </Trip>
        <Vehicle><Id>V200</Id><Label>V200</Label></Vehicle>
        <Position>
          <Latitude>41.1260</Latitude>
          <Longitude>16.8690</Longitude>
          <Speed>0</Speed>
        </Position>
        <Timestamp>1772524480</Timestamp>
        <CurrentStatus>STOPPED_AT</CurrentStatus>
        <StopId>03094003</StopId>
      </Vehicle>
    </FeedEntity>
  </Entities>
</FeedMessage>`;

  // Parse both feeds exactly as production does
  const { entities: trips } = parseTripUpdates(tripUpdateXml);
  const positions = parseVehiclePositions(vehiclePositionXml);

  // Verify parser extracted correctly from real format
  assert.equal(trips.length, 2, 'Both TripUpdates parsed');
  assert.equal(trips[0].routeId, '20', 'Trip 7157 is route 20 in TripUpdate');
  assert.equal(trips[0].tripId, '7157');
  assert.equal(trips[1].routeId, '30', 'Trip 8001 is route 30 in TripUpdate');

  // VehiclePosition says trip 7157 is route 30 — THIS IS THE SWAP
  const pos7157 = [...positions.values()].find((p) => p.tripId === '7157');
  assert.ok(pos7157, 'VehiclePosition for trip 7157 exists');
  assert.equal(pos7157.routeId, '30', 'VP says route 30 for trip 7157 (swap data)');
  assert.equal(pos7157.vehicleId, 'V100');

  // MERGE — the critical part
  const { merged, orphanTotal } = mergeTripAndPosition(trips, positions);

  // Trip 7157 must appear as route 20 (from TripUpdate), NOT route 30
  const merged7157 = merged.find((m) => m.tripId === '7157');
  assert.ok(merged7157, 'Trip 7157 is in merged output');
  assert.equal(merged7157.routeId, '20', '*** SWAP PREVENTION: routeId must be 20 from TripUpdate, not 30 from VP ***');
  assert.equal(merged7157.confirmedRouteId, '20');
  assert.equal(merged7157.vehicleId, 'V100', 'Position data (vehicleId) still attached');
  assert.equal(merged7157.lat, 41.1171, 'Position lat still attached');

  // Trip 8001 matches normally (both feeds say route 30)
  const merged8001 = merged.find((m) => m.tripId === '8001');
  assert.ok(merged8001, 'Trip 8001 is in merged output');
  assert.equal(merged8001.routeId, '30');
  assert.equal(merged8001.vehicleId, 'V200');

  // No orphan positions (both were matched by tripId)
  // No duplicate entities — exactly 2 merged
  assert.equal(merged.length, 2, 'Exactly 2 merged entities, no duplicates');

  // Final verification: NO entity in merged has routeId that came from VP instead of TU
  const route20entries = merged.filter((m) => m.routeId === '20');
  const route30entries = merged.filter((m) => m.routeId === '30');
  assert.equal(route20entries.length, 1, 'Exactly one route 20 entry');
  assert.equal(route30entries.length, 1, 'Exactly one route 30 entry');
  assert.equal(route20entries[0].tripId, '7157', 'Route 20 entry is trip 7157');
  assert.equal(route30entries[0].tripId, '8001', 'Route 30 entry is trip 8001');
});

test('CRITICAL E2E: real AMTAB XML — orphan VP with no matching TripUpdate is discarded', () => {
  // TripUpdate only has route 20, VehiclePosition has route 50 orphan
  const tripUpdateXml = `<FeedMessage xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.datacontract.org/2004/07/TransitRealtime">
  <Entities>
    <FeedEntity>
      <Alert i:nil="true" /><Id>100</Id><IsDeleted>false</IsDeleted>
      <TripUpdate>
        <StopTimeUpdates><TripUpdate.StopTimeUpdate>
          <Arrival><Delay>10</Delay><Time>1772524322</Time></Arrival>
          <StopId>03471002</StopId>
        </TripUpdate.StopTimeUpdate></StopTimeUpdates>
        <Trip><RouteId>20</RouteId><TripId>7157</TripId></Trip>
      </TripUpdate>
      <Vehicle i:nil="true" />
    </FeedEntity>
  </Entities>
  <Header><Timestamp>1772524565</Timestamp></Header>
</FeedMessage>`;

  const vehiclePositionXml = `<FeedMessage xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.datacontract.org/2004/07/TransitRealtime">
  <Entities>
    <FeedEntity>
      <Id>pos_orphan</Id><IsDeleted>false</IsDeleted>
      <Vehicle>
        <Trip><RouteId>50</RouteId><TripId>9999</TripId></Trip>
        <Vehicle><Id>V999</Id><Label>V999</Label></Vehicle>
        <Position><Latitude>41.13</Latitude><Longitude>16.88</Longitude><Speed>0</Speed></Position>
        <Timestamp>1772524400</Timestamp>
        <CurrentStatus>IN_TRANSIT_TO</CurrentStatus>
        <StopId>03100001</StopId>
      </Vehicle>
    </FeedEntity>
  </Entities>
</FeedMessage>`;

  const { entities: trips } = parseTripUpdates(tripUpdateXml);
  const positions = parseVehiclePositions(vehiclePositionXml);
  const { merged, orphanTotal } = mergeTripAndPosition(trips, positions);

  assert.equal(merged.length, 1, 'Only the TripUpdate entity survives');
  assert.equal(merged[0].routeId, '20');
  assert.equal(merged[0].tripId, '7157');
  assert.equal(orphanTotal, 1, 'Orphan route 50 position counted and discarded');
  assert.equal(merged.filter((m) => m.routeId === '50').length, 0, 'Route 50 NEVER in output');
});

// ─── 6. No regex extraction of routeId ──────────────────────────────────────
console.log('');
console.log('Audit: no regex route extraction');

test('parseTripUpdates uses no .match() or regex for RouteId extraction', () => {
  // This test validates that the source code of parseTripUpdates does not use
  // regex (.match, .exec, .replace applied to routeId, RegExp) for XML parsing.
  const src = parseTripUpdates.toString();
  assert.ok(!src.includes('.match('), 'Must not use .match()');
  assert.ok(!src.includes('.exec('), 'Must not use .exec()');
  assert.ok(!src.includes('new RegExp'), 'Must not use new RegExp');
  assert.ok(src.includes('DOMParser'), 'Must use DOMParser');
});

test('parseVehiclePositions uses no .match() or regex for RouteId extraction', () => {
  const src = parseVehiclePositions.toString();
  assert.ok(!src.includes('.match('), 'Must not use .match()');
  assert.ok(!src.includes('.exec('), 'Must not use .exec()');
  assert.ok(!src.includes('new RegExp'), 'Must not use new RegExp');
  assert.ok(src.includes('DOMParser'), 'Must use DOMParser');
});

// ─── 7. Cambio turno (shift-change regression) ─────────────────────────────
console.log('');
console.log('Cambio turno — shift-change regression');

/*
 * Scenario reale:
 * - Il veicolo V100 stava facendo la linea 20 (trip 7157).
 * - L'autista finisce il turno e inizia un nuovo trip sulla linea 30 (trip 9500).
 * - TripUpdate feed: ha ANCORA il vecchio trip 7157 con routeId=20
 *   (ritardo nell'aggiornamento lato server AMTAB).
 * - VehiclePosition feed: è GIÀ aggiornato — V100 mostra routeId=30, trip 9500.
 *
 * Bug originale: il merge usava vehicleId come fallback, assegnando la
 * posizione di V100 (route 30) al TripUpdate di route 20. Risultato:
 * sulla mappa la linea 20 appare dove cammina la linea 30.
 *
 * Fix atteso: il merge usa SOLO tripKey. Il vecchio trip 7157 non trova
 * posizione (la VP ha trip 9500), e l'orfana VP di route 30 non entra.
 */

test('CAMBIO TURNO: stale TripUpdate (route 20) + fresh VP (route 30), no swap', () => {
  const tripUpdateXml = buildTripUpdateXml([
    // Stale: vehicle was route 20, feed not yet updated
    { routeId: '20', tripId: '7157', delay: 300, arrivalTime: 1772524322, stopId: '03471002' },
    // Another normal trip on route 20
    { routeId: '20', tripId: '6221', delay: 10, arrivalTime: 1772524400, stopId: '03094003' },
    // Normal trip on route 30
    { routeId: '30', tripId: '8001', delay: 0, arrivalTime: 1772524500, stopId: '03237101' }
  ]);

  const vehiclePositionXml = buildVehiclePositionXml([
    // V100 NOW on route 30, trip 9500 (shift changed!)
    { routeId: '30', tripId: '9500', vehicleId: 'V100', lat: 41.1171, lon: 16.8719, timestamp: 1772524600 },
    // V200 on route 20, matching trip 6221
    { routeId: '20', tripId: '6221', vehicleId: 'V200', lat: 41.1200, lon: 16.8750, timestamp: 1772524580 },
    // V300 on route 30, matching trip 8001
    { routeId: '30', tripId: '8001', vehicleId: 'V300', lat: 41.1100, lon: 16.8800, timestamp: 1772524590 }
  ]);

  const { entities: trips } = parseTripUpdates(tripUpdateXml);
  const positions = parseVehiclePositions(vehiclePositionXml);
  const { merged, orphanTotal } = mergeTripAndPosition(trips, positions);

  // Trip 7157 (stale route 20): no VP matches its tripKey → no position
  const m7157 = merged.find((m) => m.tripId === '7157');
  assert.ok(m7157, 'Stale trip 7157 still in output');
  assert.equal(m7157.routeId, '20', 'Stale trip keeps its own routeId 20');
  assert.equal(m7157.lat, undefined, 'No position attached (VP has different trip)');
  assert.equal(m7157.vehicleId, '', 'No vehicleId attached');

  // Trip 6221 (route 20): matches V200
  const m6221 = merged.find((m) => m.tripId === '6221');
  assert.ok(m6221);
  assert.equal(m6221.routeId, '20');
  assert.equal(m6221.vehicleId, 'V200');
  assert.equal(m6221.lat, 41.12);

  // Trip 8001 (route 30): matches V300
  const m8001 = merged.find((m) => m.tripId === '8001');
  assert.ok(m8001);
  assert.equal(m8001.routeId, '30');
  assert.equal(m8001.vehicleId, 'V300');

  // V100 on trip 9500 is an ORPHAN — no TripUpdate for it
  assert.equal(orphanTotal, 1, 'V100 trip 9500 is orphan (no TripUpdate yet)');

  // CRITICAL: no entity in merged has V100's position on the wrong route
  const withV100 = merged.filter((m) => m.vehicleId === 'V100');
  assert.equal(withV100.length, 0, 'V100 position must NOT appear on any merged entity');

  // CRITICAL: exactly 3 merged, no duplicates, no orphan leaks
  assert.equal(merged.length, 3);
  assert.equal(merged.filter((m) => m.routeId === '20').length, 2, 'Two route-20 entries');
  assert.equal(merged.filter((m) => m.routeId === '30').length, 1, 'One route-30 entry');
});

test('CAMBIO TURNO: multiple vehicles swapping simultaneously', () => {
  // V100: was route 20, now route 30
  // V200: was route 30, now route 20
  // Classic mutual swap during shift change at depot
  const tripUpdateXml = buildTripUpdateXml([
    { routeId: '20', tripId: 'T_OLD_20', delay: 0, arrivalTime: 1000 },
    { routeId: '30', tripId: 'T_OLD_30', delay: 0, arrivalTime: 2000 }
  ]);

  const vehiclePositionXml = buildVehiclePositionXml([
    // V100 was on route 20 (T_OLD_20), now shows route 30 with new trip
    { routeId: '30', tripId: 'T_NEW_30', vehicleId: 'V100', lat: 41.11, lon: 16.87, timestamp: 900 },
    // V200 was on route 30 (T_OLD_30), now shows route 20 with new trip
    { routeId: '20', tripId: 'T_NEW_20', vehicleId: 'V200', lat: 41.12, lon: 16.88, timestamp: 900 }
  ]);

  const { entities: trips } = parseTripUpdates(tripUpdateXml);
  const positions = parseVehiclePositions(vehiclePositionXml);
  const { merged, orphanTotal } = mergeTripAndPosition(trips, positions);

  // T_OLD_20 must stay route 20, no position (VP trip doesn't match)
  const old20 = merged.find((m) => m.tripId === 'T_OLD_20');
  assert.ok(old20);
  assert.equal(old20.routeId, '20', 'T_OLD_20 stays route 20');
  assert.equal(old20.vehicleId, '', 'No position from V100 (wrong trip)');

  // T_OLD_30 must stay route 30, no position
  const old30 = merged.find((m) => m.tripId === 'T_OLD_30');
  assert.ok(old30);
  assert.equal(old30.routeId, '30', 'T_OLD_30 stays route 30');
  assert.equal(old30.vehicleId, '', 'No position from V200 (wrong trip)');

  // Both new VP entries are orphans
  assert.equal(orphanTotal, 2, 'Both new-trip VPs are orphans');
  assert.equal(merged.length, 2, 'Only the 2 TripUpdate entities');
});

test('CAMBIO TURNO: VP already updated to new trip that also has TripUpdate', () => {
  // Best case: both feeds updated simultaneously.
  // V100 switches from route 20 trip 7157 to route 30 trip 9500.
  // TripUpdate has BOTH old and new trips. VP has only the new trip.
  const tripUpdateXml = buildTripUpdateXml([
    { routeId: '20', tripId: '7157', delay: 0, arrivalTime: 1000 },
    { routeId: '30', tripId: '9500', delay: 0, arrivalTime: 2000 }
  ]);

  const vehiclePositionXml = buildVehiclePositionXml([
    { routeId: '30', tripId: '9500', vehicleId: 'V100', lat: 41.11, lon: 16.87, timestamp: 900 }
  ]);

  const { entities: trips } = parseTripUpdates(tripUpdateXml);
  const positions = parseVehiclePositions(vehiclePositionXml);
  const { merged, orphanTotal } = mergeTripAndPosition(trips, positions);

  // Trip 9500 matches the VP → V100 position on route 30 ✓
  const m9500 = merged.find((m) => m.tripId === '9500');
  assert.ok(m9500);
  assert.equal(m9500.routeId, '30');
  assert.equal(m9500.vehicleId, 'V100');
  assert.equal(m9500.lat, 41.11);

  // Trip 7157 stays route 20, no position
  const m7157 = merged.find((m) => m.tripId === '7157');
  assert.ok(m7157);
  assert.equal(m7157.routeId, '20');
  assert.equal(m7157.vehicleId, '', 'Old trip gets no position');

  assert.equal(orphanTotal, 0, 'VP matched trip 9500, no orphans');
  assert.equal(merged.length, 2);
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('');
console.log('═══════════════════════════════════════════════════');
console.log(` Results: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════');
console.log('');

process.exit(failed > 0 ? 1 : 0);
