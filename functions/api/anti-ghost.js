/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MODULO ANTI-FANTASMA — Filtri di validazione bus in tempo reale
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Problema "Bus Swap": un veicolo fisicamente assegnato alla linea 20 viene
 *  trasmesso dal sistema AVM come linea 30 (o viceversa) perché l'autista
 *  non ha aggiornato la missione dopo una sostituzione d'emergenza del mezzo.
 *  Il display LED mostra la linea corretta, ma il GPS trasmette l'ID vecchio.
 *
 *  Questo modulo implementa 3 filtri indipendenti + un classificatore combinato:
 *
 *    1. isOnRoute     — Geofencing sul percorso GTFS (shapes.txt)
 *    2. isInDepot     — Rilevamento deposito AMTAB
 *    3. isSpeedAnomaly — Velocità fuori soglia urbana
 *    4. classifyBus   — Applica i 3 filtri in cascata
 *
 *  Ogni filtro è una funzione pura (nessun side-effect, nessuno stato globale).
 *  I dati GTFS statici vengono passati come argomento (pre-caricati da server.mjs).
 *
 *  Nessuna dipendenza esterna — usa Haversine puro per i calcoli geodetici.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Costanti di configurazione ──────────────────────────────────────────────

/**
 * Distanza massima (in metri) dalla shape ufficiale della linea
 * oltre la quale il bus viene considerato "fantasma" (fuori percorso).
 */
const GEOFENCE_ROUTE_THRESHOLD_METERS = 300;

/**
 * Coordinate del deposito AMTAB — Viale Jacobini, zona industriale, Bari.
 * Il deposito principale si trova nell'area industriale a ovest della città.
 */
const DEPOT_LOCATION = {
  lat: 41.0947,
  lon: 16.8340
};

/**
 * Raggio del geofence circolare attorno al deposito (in metri).
 */
const DEPOT_RADIUS_METERS = 500;

/**
 * Velocità massima (in km/h) considerata plausibile per un bus urbano
 * nel traffico cittadino di Bari. Oltre questa soglia il bus è
 * probabilmente fuori servizio (rientro a deposito su tangenziale).
 */
const SPEED_ANOMALY_THRESHOLD_KMH = 110;

// ─── Utilità geodetica: Haversine puro ───────────────────────────────────────

/**
 * Calcola la distanza tra due punti sulla superficie terrestre
 * usando la formula di Haversine (approssimazione sferica).
 *
 * @param {number} lat1 - Latitudine del primo punto (gradi decimali)
 * @param {number} lon1 - Longitudine del primo punto (gradi decimali)
 * @param {number} lat2 - Latitudine del secondo punto (gradi decimali)
 * @param {number} lon2 - Longitudine del secondo punto (gradi decimali)
 * @returns {number} Distanza in metri
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6_371_000; // raggio medio terrestre in metri

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ─── Filtro 1: Geofencing sul percorso (isOnRoute) ──────────────────────────

/**
 * Verifica se un bus si trova effettivamente sul percorso ufficiale
 * della linea dichiarata, confrontando la posizione GPS con i punti
 * del tracciato (shape) GTFS.
 *
 * Algoritmo:
 *   1. Dal routeId del bus, cerca tutti i trip associati a quella linea
 *   2. Per ogni trip trova lo shapeId e i corrispondenti punti del tracciato
 *   3. Calcola la distanza minima tra la posizione GPS e qualsiasi punto shape
 *   4. Se la distanza minima supera GEOFENCE_ROUTE_THRESHOLD_METERS → ghost
 *
 * Ottimizzazione: attraversa tutti gli shape della stessa linea (andata/ritorno)
 * perché il feed potrebbe avere un directionId non sempre affidabile.
 *
 * @param {object} busData - Dati real-time del bus
 * @param {number} busData.lat - Latitudine GPS corrente
 * @param {number} busData.lon - Longitudine GPS corrente
 * @param {string} busData.routeId - ID della linea dichiarata nel feed
 * @param {string} [busData.tripId] - ID della corsa (opzionale, usato per match diretto)
 * @param {object} gtfsData - Dati GTFS statici pre-caricati (da loadGtfsData)
 * @param {Map}    gtfsData.tripsByTripId - Mappa trip_id → { routeId, shapeId, ... }
 * @param {Map}    gtfsData.shapesByShapeId - Mappa shape_id → [{ lat, lon, sequence }]
 * @param {object} [options] - Opzioni di configurazione
 * @param {number} [options.thresholdMeters=300] - Soglia di distanza in metri
 * @returns {{ onRoute: boolean, minDistanceMeters: number, shapesChecked: number }}
 */
export function isOnRoute(busData, gtfsData, options = {}) {
  const { lat, lon, routeId, tripId } = busData;
  const threshold = options.thresholdMeters ?? GEOFENCE_ROUTE_THRESHOLD_METERS;

  // Validazione input
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) {
    return { onRoute: false, minDistanceMeters: Infinity, shapesChecked: 0 };
  }

  if (!routeId && !tripId) {
    return { onRoute: false, minDistanceMeters: Infinity, shapesChecked: 0 };
  }

  // Raccogliamo tutti gli shapeId unici per questa linea.
  // Se abbiamo un tripId diretto, proviamo prima quello;
  // altrimenti iteriamo tutti i trip della stessa route.
  const shapeIds = new Set();

  // Tentativo diretto col tripId
  if (tripId) {
    const trip = gtfsData.tripsByTripId.get(tripId);
    if (trip?.shapeId) {
      shapeIds.add(trip.shapeId);
    }
  }

  // Raccogliamo shapes di tutti i trip della stessa linea
  // (copre andata, ritorno e varianti di percorso)
  if (routeId) {
    for (const trip of gtfsData.tripsByTripId.values()) {
      if (trip.routeId === routeId && trip.shapeId) {
        shapeIds.add(trip.shapeId);
      }
    }
  }

  if (shapeIds.size === 0) {
    // Nessuna shape trovata → non possiamo filtrare, assumiamo on-route
    return { onRoute: true, minDistanceMeters: 0, shapesChecked: 0 };
  }

  // Calcola la distanza minima tra il bus e qualsiasi punto shape
  let globalMinDistance = Infinity;
  let shapesChecked = 0;

  for (const shapeId of shapeIds) {
    const points = gtfsData.shapesByShapeId.get(shapeId);
    if (!points || points.length === 0) {
      continue;
    }

    shapesChecked += 1;

    for (const point of points) {
      const distance = haversineMeters(lat, lon, point.lat, point.lon);
      if (distance < globalMinDistance) {
        globalMinDistance = distance;
      }

      // Early exit: se siamo già sotto soglia, il bus è sul percorso
      if (globalMinDistance <= threshold) {
        return { onRoute: true, minDistanceMeters: Math.round(globalMinDistance), shapesChecked };
      }
    }
  }

  return {
    onRoute: globalMinDistance <= threshold,
    minDistanceMeters: globalMinDistance === Infinity ? Infinity : Math.round(globalMinDistance),
    shapesChecked
  };
}

// ─── Filtro 2: Rilevamento deposito (isInDepot) ─────────────────────────────

/**
 * Verifica se un bus si trova all'interno del geofence circolare
 * del deposito AMTAB (Viale Jacobini, Bari — zona industriale).
 *
 * Quando un bus è nel deposito, indipendentemente dal LineId trasmesso,
 * va considerato inattivo: potrebbe essere appena uscito dal servizio,
 * in manutenzione, oppure in attesa di essere assegnato a una nuova missione.
 *
 * @param {object} busData - Dati real-time del bus
 * @param {number} busData.lat - Latitudine GPS corrente
 * @param {number} busData.lon - Longitudine GPS corrente
 * @param {object} [options] - Opzioni di configurazione
 * @param {object} [options.depotLocation] - Coordinate del deposito { lat, lon }
 * @param {number} [options.depotRadiusMeters=500] - Raggio del geofence in metri
 * @returns {{ inDepot: boolean, distanceFromDepotMeters: number }}
 */
export function isInDepot(busData, options = {}) {
  const { lat, lon } = busData;
  const depot = options.depotLocation ?? DEPOT_LOCATION;
  const radius = options.depotRadiusMeters ?? DEPOT_RADIUS_METERS;

  // Validazione input
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) {
    return { inDepot: false, distanceFromDepotMeters: Infinity };
  }

  const distance = haversineMeters(lat, lon, depot.lat, depot.lon);

  return {
    inDepot: distance <= radius,
    distanceFromDepotMeters: Math.round(distance)
  };
}

// ─── Filtro 3: Velocità anomala (isSpeedAnomaly) ─────────────────────────────

/**
 * Verifica se la velocità del bus supera la soglia urbana plausibile.
 *
 * I bus urbani di Bari raramente superano i 50 km/h nel traffico cittadino.
 * Una velocità superiore a 70 km/h indica che il veicolo è probabilmente
 * fuori servizio — ad esempio in rientro veloce al deposito lungo la
 * tangenziale o la strada statale.
 *
 * Il campo <Speed> nel feed XML è espresso in m/s (standard GTFS-RT).
 * La funzione accetta sia m/s che km/h tramite il parametro `speedUnit`.
 *
 * @param {object} busData - Dati real-time del bus
 * @param {number} busData.speed - Velocità corrente del bus
 * @param {object} [options] - Opzioni di configurazione
 * @param {number} [options.thresholdKmh=70] - Soglia massima in km/h
 * @param {'mps'|'kmh'} [options.speedUnit='mps'] - Unità della velocità in input
 * @returns {{ anomaly: boolean, speedKmh: number, thresholdKmh: number }}
 */
export function isSpeedAnomaly(busData, options = {}) {
  const { speed } = busData;
  const thresholdKmh = options.thresholdKmh ?? SPEED_ANOMALY_THRESHOLD_KMH;
  const speedUnit = options.speedUnit ?? 'mps';

  // Validazione input
  if (speed == null || Number.isNaN(speed) || speed < 0) {
    return { anomaly: false, speedKmh: 0, thresholdKmh };
  }

  // Converte la velocità in km/h per il confronto
  const speedKmh = speedUnit === 'kmh'
    ? speed
    : speed * 3.6; // m/s → km/h

  return {
    anomaly: speedKmh > thresholdKmh,
    speedKmh: Math.round(speedKmh * 10) / 10,
    thresholdKmh
  };
}

// ─── Classificatore combinato ────────────────────────────────────────────────

/**
 * Applica tutti e 3 i filtri anti-fantasma in cascata e restituisce
 * un oggetto con i flag di classificazione per il bus.
 *
 * Ordine di valutazione (cascata con priorità):
 *   1. isInDepot      → il bus è al deposito, non mostrare
 *   2. isSpeedAnomaly → velocità anomala, fuori servizio
 *   3. isOnRoute      → geofencing, possibile bus fantasma (swap)
 *
 * Il campo `shouldDisplay` è `true` solo se NESSUNO dei filtri scatta.
 * I singoli flag permettono al frontend di gestire l'UI in modo granulare
 * (es. grigio per deposito, icona di warning per ghost, ecc.).
 *
 * @param {object} busData - Dati real-time del bus dal feed XML
 * @param {number}  busData.lat       - Latitudine GPS corrente
 * @param {number}  busData.lon       - Longitudine GPS corrente
 * @param {string}  busData.routeId   - ID linea dichiarata (es. "20")
 * @param {string}  [busData.tripId]  - ID corsa (opzionale)
 * @param {number}  busData.speed     - Velocità in m/s (standard GTFS-RT)
 * @param {string}  [busData.vehicleId] - ID veicolo (per logging)
 * @param {object} gtfsData - Dati GTFS statici pre-caricati
 * @param {object} [options] - Opzioni per i singoli filtri
 * @param {number}  [options.routeThresholdMeters=300]  - Soglia geofencing
 * @param {object}  [options.depotLocation]              - Coordinate deposito
 * @param {number}  [options.depotRadiusMeters=500]      - Raggio deposito
 * @param {number}  [options.speedThresholdKmh=70]       - Soglia velocità
 * @param {'mps'|'kmh'} [options.speedUnit='mps']        - Unità velocità
 * @returns {{
 *   isGhost: boolean,
 *   isInDepot: boolean,
 *   isOutOfService: boolean,
 *   shouldDisplay: boolean,
 *   details: {
 *     route: { onRoute: boolean, minDistanceMeters: number, shapesChecked: number },
 *     depot: { inDepot: boolean, distanceFromDepotMeters: number },
 *     speed: { anomaly: boolean, speedKmh: number, thresholdKmh: number }
 *   }
 * }}
 */
export function classifyBus(busData, gtfsData, options = {}) {
  // ── Filtro 1: Deposito ─────────────────────────────────────────
  // Controllato per primo perché un bus al deposito non va mai mostrato,
  // indipendentemente da linea o velocità.
  const depotResult = isInDepot(busData, {
    depotLocation: options.depotLocation,
    depotRadiusMeters: options.depotRadiusMeters
  });

  // ── Filtro 2: Velocità anomala ─────────────────────────────────
  // Se il bus viaggia troppo veloce per il contesto urbano,
  // probabilmente è in rientro su tangenziale → fuori servizio.
  const speedResult = isSpeedAnomaly(busData, {
    thresholdKmh: options.speedThresholdKmh,
    speedUnit: options.speedUnit
  });

  // ── Filtro 3: Geofencing percorso ──────────────────────────────
  // Confronta la posizione GPS con le shapes GTFS della linea dichiarata.
  // Se la distanza supera la soglia → sospetto bus swap / fantasma.
  const routeResult = isOnRoute(busData, gtfsData, {
    thresholdMeters: options.routeThresholdMeters
  });

  // ── Classificazione finale ─────────────────────────────────────
  const isGhostFlag = !routeResult.onRoute;
  const isInDepotFlag = depotResult.inDepot;
  const isOutOfServiceFlag = speedResult.anomaly;

  // Il bus va mostrato sulla mappa solo se tutti e 3 i filtri passano
  const shouldDisplay = !isGhostFlag && !isInDepotFlag && !isOutOfServiceFlag;

  return {
    isGhost: isGhostFlag,
    isInDepot: isInDepotFlag,
    isOutOfService: isOutOfServiceFlag,
    shouldDisplay,
    details: {
      route: routeResult,
      depot: depotResult,
      speed: speedResult
    }
  };
}

// ─── Helper: costruisce la lookup routeId → shapeIds dai dati GTFS ──────────

/**
 * Pre-computa un indice routeId → Set<shapeId> per velocizzare
 * ripetute chiamate a isOnRoute sulla stessa linea.
 * Utile quando si classificano molti bus nella stessa richiesta.
 *
 * @param {object} gtfsData - Dati GTFS statici
 * @returns {Map<string, Set<string>>}
 */
export function buildRouteShapeIndex(gtfsData) {
  const index = new Map();

  for (const trip of gtfsData.tripsByTripId.values()) {
    if (!trip.routeId || !trip.shapeId) {
      continue;
    }

    if (!index.has(trip.routeId)) {
      index.set(trip.routeId, new Set());
    }

    index.get(trip.routeId).add(trip.shapeId);
  }

  return index;
}

// ─── Export costanti per test e configurazione esterna ────────────────────────

export {
  GEOFENCE_ROUTE_THRESHOLD_METERS,
  DEPOT_LOCATION,
  DEPOT_RADIUS_METERS,
  SPEED_ANOMALY_THRESHOLD_KMH,
  haversineMeters
};
