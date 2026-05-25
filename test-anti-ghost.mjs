/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TEST ANTI-FANTASMA — Scenari di verifica con dati mock
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Esecuzione:  node test-anti-ghost.mjs
 *
 *  Verifica i 3 filtri con scenari realistici basati sulla rete AMTAB di Bari:
 *    - Bus regolare sul percorso
 *    - Bus fantasma (swap linea 20↔30)
 *    - Bus nel deposito AMTAB
 *    - Bus con velocità anomala (tangenziale)
 *    - Casi limite (dati mancanti, velocità zero, ecc.)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  isOnRoute,
  isInDepot,
  isSpeedAnomaly,
  classifyBus,
  buildRouteShapeIndex,
  haversineMeters,
  GEOFENCE_ROUTE_THRESHOLD_METERS,
  DEPOT_LOCATION,
  DEPOT_RADIUS_METERS,
  SPEED_ANOMALY_THRESHOLD_KMH
} from './functions/api/anti-ghost.js';

// ─── Dati GTFS mock ──────────────────────────────────────────────────────────
// Simulano la struttura restituita da loadGtfsData() in server.mjs.
// Shape della linea 20: punti lungo Corso Cavour → Via Sparano → Lungomare (Bari)
// Shape della linea 30: punti lungo Via Capruzzi → Viale Unità d'Italia

function buildMockGtfsData() {
  const tripsByTripId = new Map();
  const shapesByShapeId = new Map();

  // ── Linea 20: percorso centro storico → lungomare ──────────────
  tripsByTripId.set('7157', {
    tripId: '7157',
    routeId: '20',
    serviceId: 'FER',
    shapeId: 'shape_20_andata',
    tripHeadsign: 'Lungomare'
  });

  tripsByTripId.set('7158', {
    tripId: '7158',
    routeId: '20',
    serviceId: 'FER',
    shapeId: 'shape_20_ritorno',
    tripHeadsign: 'San Paolo'
  });

  // Shape linea 20 andata (punti lungo il percorso reale approssimato)
  shapesByShapeId.set('shape_20_andata', [
    { lat: 41.1252, lon: 16.8696, sequence: 1 },   // Piazza Moro (Stazione)
    { lat: 41.1235, lon: 16.8710, sequence: 2 },   // Via Sparano inizio
    { lat: 41.1220, lon: 16.8725, sequence: 3 },   // Via Sparano centro
    { lat: 41.1200, lon: 16.8740, sequence: 4 },   // Via Sparano fine
    { lat: 41.1185, lon: 16.8680, sequence: 5 },   // Corso Vittorio Emanuele
    { lat: 41.1170, lon: 16.8650, sequence: 6 },   // Lungomare Nazario Sauro
    { lat: 41.1162, lon: 16.8620, sequence: 7 },   // Lungomare est
    { lat: 41.1155, lon: 16.8590, sequence: 8 },   // Lungomare ovest
  ]);

  // Shape linea 20 ritorno
  shapesByShapeId.set('shape_20_ritorno', [
    { lat: 41.1155, lon: 16.8590, sequence: 1 },   // Lungomare ovest
    { lat: 41.1170, lon: 16.8650, sequence: 2 },   // Lungomare Nazario Sauro
    { lat: 41.1200, lon: 16.8740, sequence: 3 },   // Via Sparano
    { lat: 41.1252, lon: 16.8696, sequence: 4 },   // Piazza Moro
    { lat: 41.1280, lon: 16.8660, sequence: 5 },   // Via Capruzzi (verso periferia)
    { lat: 41.1310, lon: 16.8600, sequence: 6 },   // S. Paolo
  ]);

  // ── Linea 30: percorso periferia sud ───────────────────────────
  tripsByTripId.set('8001', {
    tripId: '8001',
    routeId: '30',
    serviceId: 'FER',
    shapeId: 'shape_30_andata',
    tripHeadsign: 'Carbonara'
  });

  // Shape linea 30 (periferia sud — chiaramente diversa dalla 20)
  shapesByShapeId.set('shape_30_andata', [
    { lat: 41.1252, lon: 16.8696, sequence: 1 },   // Piazza Moro (capolinea comune)
    { lat: 41.1240, lon: 16.8780, sequence: 2 },   // Via Capruzzi est
    { lat: 41.1215, lon: 16.8850, sequence: 3 },   // Via Amendola
    { lat: 41.1180, lon: 16.8920, sequence: 4 },   // Viale Unità d'Italia
    { lat: 41.1100, lon: 16.9000, sequence: 5 },   // Poggiofranco
    { lat: 41.1050, lon: 16.9100, sequence: 6 },   // Carbonara
  ]);

  return { tripsByTripId, shapesByShapeId };
}

// ─── Utility di test ─────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    passCount += 1;
    console.log(`  ✅ ${testName}`);
  } else {
    failCount += 1;
    console.error(`  ❌ ${testName}${details ? ` — ${details}` : ''}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════════════════════

const gtfsData = buildMockGtfsData();

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('  TEST ANTI-FANTASMA — Filtri di validazione bus');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

// ─── 1. Test isOnRoute ───────────────────────────────────────────────────────

console.log('── Filtro 1: isOnRoute (Geofencing percorso) ──');

// Scenario 1a: Bus regolare sulla linea 20, vicino a Via Sparano
{
  const bus = { lat: 41.1222, lon: 16.8722, routeId: '20', tripId: '7157' };
  const result = isOnRoute(bus, gtfsData);
  assert(result.onRoute === true, 'Bus linea 20 su Via Sparano → onRoute=true',
    `distanza: ${result.minDistanceMeters}m`);
}

// Scenario 1b: Bus FANTASMA — dichiarato linea 20 ma fisicamente sul percorso della 30
// (a Poggiofranco, lontano dalla shape della 20)
{
  const bus = { lat: 41.1100, lon: 16.9000, routeId: '20' };
  const result = isOnRoute(bus, gtfsData);
  assert(result.onRoute === false, 'Bus "linea 20" a Poggiofranco (percorso 30) → onRoute=false (GHOST)',
    `distanza: ${result.minDistanceMeters}m, soglia: ${GEOFENCE_ROUTE_THRESHOLD_METERS}m`);
}

// Scenario 1c: Bus linea 30 effettivamente a Poggiofranco → regolare
{
  const bus = { lat: 41.1100, lon: 16.9000, routeId: '30', tripId: '8001' };
  const result = isOnRoute(bus, gtfsData);
  assert(result.onRoute === true, 'Bus linea 30 a Poggiofranco → onRoute=true',
    `distanza: ${result.minDistanceMeters}m`);
}

// Scenario 1d: Bus sul punto esatto di una shape
{
  const bus = { lat: 41.1252, lon: 16.8696, routeId: '20' };
  const result = isOnRoute(bus, gtfsData);
  assert(result.onRoute === true, 'Bus linea 20 esattamente su Piazza Moro → onRoute=true',
    `distanza: ${result.minDistanceMeters}m`);
}

// Scenario 1e: Nessun routeId o tripId → onRoute=false
{
  const bus = { lat: 41.1220, lon: 16.8725 };
  const result = isOnRoute(bus, gtfsData);
  assert(result.onRoute === false, 'Bus senza routeId/tripId → onRoute=false');
}

// Scenario 1f: routeId senza shape nel GTFS → assume onRoute (non filtrabile)
{
  const bus = { lat: 41.1220, lon: 16.8725, routeId: '999' };
  const result = isOnRoute(bus, gtfsData);
  assert(result.onRoute === true, 'Bus linea 999 (nessuna shape) → onRoute=true (non filtrabile)');
}

console.log('');

// ─── 2. Test isInDepot ───────────────────────────────────────────────────────

console.log('── Filtro 2: isInDepot (Rilevamento deposito) ──');

// Scenario 2a: Bus nel deposito AMTAB (Viale Jacobini)
{
  const bus = { lat: 41.0950, lon: 16.8335 };
  const result = isInDepot(bus);
  assert(result.inDepot === true, 'Bus a Viale Jacobini (deposito) → inDepot=true',
    `distanza dal deposito: ${result.distanceFromDepotMeters}m`);
}

// Scenario 2b: Bus in centro città, lontano dal deposito
{
  const bus = { lat: 41.1220, lon: 16.8725 };
  const result = isInDepot(bus);
  assert(result.inDepot === false, 'Bus in centro (Via Sparano) → inDepot=false',
    `distanza dal deposito: ${result.distanceFromDepotMeters}m`);
}

// Scenario 2c: Bus al bordo del geofence (500m esatti)
{
  // Calcoliamo un punto a ~500m dal deposito
  const bus = { lat: DEPOT_LOCATION.lat + 0.0045, lon: DEPOT_LOCATION.lon };
  const dist = haversineMeters(bus.lat, bus.lon, DEPOT_LOCATION.lat, DEPOT_LOCATION.lon);
  const result = isInDepot(bus);
  assert(dist > DEPOT_RADIUS_METERS, `Bus a ~${Math.round(dist)}m dal deposito → inDepot=false (fuori raggio)`,
    `inDepot=${result.inDepot}`);
}

// Scenario 2d: Bus esattamente al deposito
{
  const bus = { lat: DEPOT_LOCATION.lat, lon: DEPOT_LOCATION.lon };
  const result = isInDepot(bus);
  assert(result.inDepot === true, 'Bus esattamente sulle coordinate deposito → inDepot=true',
    `distanza: ${result.distanceFromDepotMeters}m`);
}

console.log('');

// ─── 3. Test isSpeedAnomaly ──────────────────────────────────────────────────

console.log('── Filtro 3: isSpeedAnomaly (Velocità anomala) ──');

// Scenario 3a: Bus a velocità urbana normale (30 km/h ≈ 8.33 m/s)
{
  const bus = { speed: 8.33 };
  const result = isSpeedAnomaly(bus);
  assert(result.anomaly === false, 'Bus a ~30 km/h → anomaly=false',
    `${result.speedKmh} km/h, soglia: ${result.thresholdKmh} km/h`);
}

// Scenario 3b: Bus su tangenziale a 80 km/h (≈ 22.2 m/s) → fuori servizio
{
  const bus = { speed: 22.2 };
  const result = isSpeedAnomaly(bus);
  assert(result.anomaly === true, 'Bus a ~80 km/h (tangenziale) → anomaly=true',
    `${result.speedKmh} km/h, soglia: ${result.thresholdKmh} km/h`);
}

// Scenario 3c: Bus fermo (speed = 0)
{
  const bus = { speed: 0 };
  const result = isSpeedAnomaly(bus);
  assert(result.anomaly === false, 'Bus fermo (0 m/s) → anomaly=false');
}

// Scenario 3d: Speed al limite esatto (70 km/h = 19.44 m/s)
{
  const bus = { speed: 19.44 };
  const result = isSpeedAnomaly(bus);
  // 19.44 * 3.6 = 69.984 km/h → sotto soglia di 70
  assert(result.anomaly === false, 'Bus a 69.98 km/h (sotto soglia) → anomaly=false',
    `${result.speedKmh} km/h`);
}

// Scenario 3e: Speed appena sopra soglia
{
  const bus = { speed: 19.5 };
  const result = isSpeedAnomaly(bus);
  // 19.5 * 3.6 = 70.2 km/h → sopra soglia
  assert(result.anomaly === true, 'Bus a 70.2 km/h (sopra soglia) → anomaly=true',
    `${result.speedKmh} km/h`);
}

// Scenario 3f: Speed null/undefined → nessuna anomalia
{
  const bus = { speed: null };
  const result = isSpeedAnomaly(bus);
  assert(result.anomaly === false, 'Bus con speed=null → anomaly=false');
}

// Scenario 3g: Input in km/h (speedUnit='kmh')
{
  const bus = { speed: 75 };
  const result = isSpeedAnomaly(bus, { speedUnit: 'kmh' });
  assert(result.anomaly === true, 'Bus a 75 km/h (input kmh) → anomaly=true',
    `${result.speedKmh} km/h`);
}

console.log('');

// ─── 4. Test classifyBus (classificatore combinato) ──────────────────────────

console.log('── Classificatore combinato: classifyBus ──');

// Scenario 4a: Bus regolare — linea 20 su percorso, velocità normale, lontano dal deposito
{
  const bus = {
    vehicleId: '3203',
    routeId: '20',
    tripId: '7157',
    lat: 41.1220,
    lon: 16.8725,
    speed: 8.33  // ~30 km/h
  };
  const result = classifyBus(bus, gtfsData);
  assert(result.shouldDisplay === true, 'Bus regolare (linea 20, centro, 30 km/h) → shouldDisplay=true');
  assert(result.isGhost === false, '  → isGhost=false');
  assert(result.isInDepot === false, '  → isInDepot=false');
  assert(result.isOutOfService === false, '  → isOutOfService=false');
}

// Scenario 4b: BUS FANTASMA — dichiarato linea 20 ma sul percorso della 30
{
  const bus = {
    vehicleId: '2501',
    routeId: '20',      // Dichiara linea 20...
    lat: 41.1050,        // ...ma è a Carbonara (percorso linea 30)
    lon: 16.9100,
    speed: 5.5           // ~20 km/h, velocità normale
  };
  const result = classifyBus(bus, gtfsData);
  assert(result.shouldDisplay === false, 'Bus fantasma (linea 20 ma a Carbonara) → shouldDisplay=false');
  assert(result.isGhost === true, '  → isGhost=true (BUS SWAP RILEVATO!)');
  assert(result.isInDepot === false, '  → isInDepot=false');
  assert(result.isOutOfService === false, '  → isOutOfService=false');
}

// Scenario 4c: Bus nel deposito AMTAB
{
  const bus = {
    vehicleId: '1800',
    routeId: '20',
    lat: DEPOT_LOCATION.lat,
    lon: DEPOT_LOCATION.lon,
    speed: 0
  };
  const result = classifyBus(bus, gtfsData);
  assert(result.shouldDisplay === false, 'Bus nel deposito → shouldDisplay=false');
  assert(result.isInDepot === true, '  → isInDepot=true (IN_DEPOT)');
}

// Scenario 4d: Bus su tangenziale a velocità anomala
{
  const bus = {
    vehicleId: '3300',
    routeId: '20',
    tripId: '7157',
    lat: 41.1252,         // Su Piazza Moro (tecnicamente on-route)
    lon: 16.8696,
    speed: 25.0           // 90 km/h — rientro veloce
  };
  const result = classifyBus(bus, gtfsData);
  assert(result.shouldDisplay === false, 'Bus a 90 km/h (tangenziale) → shouldDisplay=false');
  assert(result.isOutOfService === true, '  → isOutOfService=true');
}

// Scenario 4e: Bus con TUTTI i problemi contemporaneamente
// (nel deposito + veloce + fuori percorso — caso estremo)
{
  const bus = {
    vehicleId: '9999',
    routeId: '20',
    lat: DEPOT_LOCATION.lat,
    lon: DEPOT_LOCATION.lon,
    speed: 22.0           // 79 km/h
  };
  const result = classifyBus(bus, gtfsData);
  assert(result.shouldDisplay === false, 'Bus con tutti i flag → shouldDisplay=false');
  assert(result.isGhost === true, '  → isGhost=true');
  assert(result.isInDepot === true, '  → isInDepot=true');
  assert(result.isOutOfService === true, '  → isOutOfService=true');
}

console.log('');

// ─── 5. Test buildRouteShapeIndex ────────────────────────────────────────────

console.log('── Helper: buildRouteShapeIndex ──');

{
  const index = buildRouteShapeIndex(gtfsData);
  assert(index.has('20'), 'Index contiene linea 20');
  assert(index.get('20').size === 2, 'Linea 20 ha 2 shapes (andata + ritorno)');
  assert(index.has('30'), 'Index contiene linea 30');
  assert(index.get('30').size === 1, 'Linea 30 ha 1 shape');
}

console.log('');

// ─── 6. Test haversineMeters ─────────────────────────────────────────────────

console.log('── Utilità: haversineMeters ──');

{
  // Distanza Piazza Moro → Lungomare (circa 1 km)
  const d = haversineMeters(41.1252, 16.8696, 41.1170, 16.8650);
  assert(d > 800 && d < 1200, `Piazza Moro → Lungomare: ${Math.round(d)}m (atteso ~950m)`);
}

{
  // Stesso punto → 0m
  const d = haversineMeters(41.1252, 16.8696, 41.1252, 16.8696);
  assert(d === 0, 'Stesso punto → 0m');
}

console.log('');

// ─── Riepilogo ───────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════');
console.log(`  RISULTATO: ${passCount} passed, ${failCount} failed`);
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

process.exit(failCount > 0 ? 1 : 0);
