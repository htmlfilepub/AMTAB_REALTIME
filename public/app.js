const tableBody = document.querySelector('#tableBody');
const message = document.querySelector('#message');
const refreshBtn = document.querySelector('#refreshBtn');
const autoRefreshCheckbox = document.querySelector('#autoRefresh');
const mapAllToggle = document.querySelector('#mapAllToggle');
const lineSelect = document.querySelector('#lineSelect');
const mapTitle = document.querySelector('#mapTitle');
const vehiclesCount = document.querySelector('#vehiclesCount');
const avgDelay = document.querySelector('#avgDelay');
const feedTimestamp = document.querySelector('#feedTimestamp');

const REFRESH_MS = 15000;
const MAP_DEFAULT_CENTER = [41.1171, 16.8719];
const MAP_DEFAULT_ZOOM = 13;
let timer = null;
let map = null;
const markerByTripId = new Map();
let hasCenteredOnVehicles = false;
let selectedRouteId = '';
let lastMergedEntities = [];
let lastFeedTimestamp = 0;
let showAllOnMap = false;

function createBusIcon(routeId) {
  if (typeof L === 'undefined') {
    return null;
  }

  return L.divIcon({
    className: 'bus-marker',
    html: `<span class="bus-marker__badge">🚌 ${routeId || '?'}</span>`,
    iconSize: [56, 26],
    iconAnchor: [28, 13]
  });
}

function formatDelay(delaySeconds) {
  if (delaySeconds == null || Number.isNaN(delaySeconds)) {
    return 'n/d';
  }

  if (delaySeconds <= 0) {
    return 'in orario';
  }

  const minutes = Math.round(delaySeconds / 60);
  return `+${minutes} min`;
}

function formatUnix(seconds) {
  if (!seconds || Number.isNaN(seconds)) {
    return 'n/d';
  }

  const date = new Date(seconds * 1000);
  return date.toLocaleString('it-IT');
}

function formatSpeed(metersPerSecond) {
  if (metersPerSecond == null || Number.isNaN(metersPerSecond)) {
    return 'n/d';
  }

  const kmh = Math.round(metersPerSecond * 3.6 * 10) / 10;
  return `${kmh} km/h`;
}

function formatCoordinate(lat, lon) {
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) {
    return 'n/d';
  }

  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function delayToStatus(delay) {
  if (delay <= 60) {
    return { label: 'Regolare', className: 'green' };
  }

  if (delay <= 300) {
    return { label: 'Ritardo lieve', className: 'orange' };
  }

  return { label: 'Ritardo alto', className: 'red' };
}

function compareRouteIds(a, b) {
  const aNum = Number(a);
  const bNum = Number(b);
  const isANum = !Number.isNaN(aNum);
  const isBNum = !Number.isNaN(bNum);

  if (isANum && isBNum) {
    return aNum - bNum;
  }

  return String(a).localeCompare(String(b), 'it-IT');
}

function makeTripKey(routeId, tripId, vehicleId = '') {
  const cleanRouteId = routeId || '';
  const cleanTripId = tripId || '';
  const cleanVehicleId = vehicleId || '';

  if (cleanTripId) {
    return `${cleanRouteId}__trip__${cleanTripId}`;
  }

  if (cleanVehicleId) {
    return `${cleanRouteId}__veh__${cleanVehicleId}`;
  }

  return '';
}

function getChildText(parent, selector) {
  return parent.querySelector(selector)?.textContent?.trim() ?? '';
}

function initMap() {
  if (map || typeof L === 'undefined') {
    return;
  }

  map = L.map('map', {
    center: MAP_DEFAULT_CENTER,
    zoom: MAP_DEFAULT_ZOOM,
    zoomControl: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
}

function buildPopup(item) {
  return [
    `<strong>Linea:</strong> ${item.routeId || 'n/d'}`,
    `<strong>Veicolo:</strong> ${item.vehicleId || 'n/d'}`,
    `<strong>Trip:</strong> ${item.tripId || 'n/d'}`,
    `<strong>Velocità:</strong> ${formatSpeed(item.speed)}`,
    `<strong>Ritardo:</strong> ${formatDelay(item.delay)}`
  ].join('<br/>');
}

function updateMap(entities) {
  initMap();
  if (!map) {
    return;
  }

  const activeKeys = new Set();
  const pointsForBounds = [];

  for (const item of entities) {
    const key = item.vehicleId || item.tripKey || item.tripId;
    if (key) {
      activeKeys.add(key);
    }

    if (item.lat == null || item.lon == null || Number.isNaN(item.lat) || Number.isNaN(item.lon)) {
      continue;
    }

    pointsForBounds.push([item.lat, item.lon]);
    if (!key) {
      continue;
    }

    const existing = markerByTripId.get(key);
    if (!existing) {
      const icon = createBusIcon(item.routeId);
      const marker = L.marker([item.lat, item.lon], icon ? { icon } : undefined).addTo(map);
      marker.bindPopup(buildPopup(item));
      markerByTripId.set(key, {
        marker
      });
      continue;
    }

    existing.marker.setLatLng([item.lat, item.lon]);
    existing.marker.setPopupContent(buildPopup(item));
    const icon = createBusIcon(item.routeId);
    if (icon) {
      existing.marker.setIcon(icon);
    }
  }

  for (const [key, item] of markerByTripId.entries()) {
    if (!activeKeys.has(key)) {
      map.removeLayer(item.marker);
      markerByTripId.delete(key);
    }
  }

  if (pointsForBounds.length && !hasCenteredOnVehicles) {
    map.fitBounds(pointsForBounds, { padding: [25, 25] });
    hasCenteredOnVehicles = true;
  }
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
      if (!routeId) {
        return null;
      }

      const tripId = getChildText(entity, 'TripUpdate > Trip > TripId');
      const stopId = getChildText(entity, 'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > StopId');

      const arrivalTimeRaw = getChildText(
        entity,
        'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > Arrival > Time'
      );

      const delayRaw = getChildText(
        entity,
        'TripUpdate > StopTimeUpdates > TripUpdate\\.StopTimeUpdate > Arrival > Delay'
      );

      const delay = Number(delayRaw);
      const arrivalTime = Number(arrivalTimeRaw);
      const status = delayToStatus(Number.isNaN(delay) ? 0 : Math.max(delay, 0));

      return {
        routeId,
        tripKey: makeTripKey(routeId, tripId),
        tripId,
        stopId,
        delay,
        arrivalTime,
        status
      };
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
      if (!routeId) {
        return null;
      }

      const tripId = getChildText(entity, 'Vehicle > Trip > TripId');
      const vehicleId = getChildText(entity, 'Vehicle > Vehicle > Id') || getChildText(entity, 'Vehicle > Vehicle > Label');
      const positionKey = makeTripKey(routeId, tripId, vehicleId);
      const lat = Number(getChildText(entity, 'Vehicle > Position > Latitude'));
      const lon = Number(getChildText(entity, 'Vehicle > Position > Longitude'));
      const speed = Number(getChildText(entity, 'Vehicle > Position > Speed'));
      const currentStatus = getChildText(entity, 'Vehicle > CurrentStatus');
      const timestamp = Number(getChildText(entity, 'Vehicle > Timestamp'));

      return {
        routeId,
        positionKey,
        tripKey: makeTripKey(routeId, tripId),
        tripId,
        vehicleId,
        lat,
        lon,
        speed,
        currentStatus,
        timestamp
      };
    })
    .filter(Boolean);

  const byTripId = new Map();
  for (const item of positions) {
    const key = item.positionKey;
    if (!key) {
      continue;
    }

    const previous = byTripId.get(key);
    if (!previous || item.timestamp > previous.timestamp) {
      byTripId.set(key, item);
    }
  }

  return byTripId;
}

function mergeTripAndPosition(trips, positionsByTripId) {
  const merged = trips.map((trip) => {
    const position = positionsByTripId.get(trip.tripKey) || positionsByTripId.get(makeTripKey(trip.routeId, '', trip.vehicleId));
    return {
      ...trip,
      vehicleId: position?.vehicleId ?? '',
      lat: position?.lat,
      lon: position?.lon,
      speed: position?.speed,
      currentStatus: position?.currentStatus ?? ''
    };
  });

  for (const [positionKey, position] of positionsByTripId.entries()) {
    const alreadyPresent = merged.some((item) => item.tripKey === positionKey || makeTripKey(item.routeId, '', item.vehicleId) === positionKey);
    if (alreadyPresent) {
      continue;
    }

    merged.push({
      routeId: position.routeId,
      tripKey: position.tripKey,
      tripId: position.tripId,
      stopId: '',
      delay: NaN,
      arrivalTime: position.timestamp,
      status: delayToStatus(0),
      vehicleId: position.vehicleId,
      lat: position.lat,
      lon: position.lon,
      speed: position.speed,
      currentStatus: position.currentStatus
    });
  }

  return merged.sort((a, b) => a.arrivalTime - b.arrivalTime);
}

function renderRows(items) {
  if (!items.length) {
    tableBody.innerHTML = '<tr><td colspan="7" class="placeholder">Nessun veicolo disponibile per la linea selezionata</td></tr>';
    return;
  }

  tableBody.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${item.vehicleId || 'n/d'}</td>
        <td>${item.tripId || 'n/d'}</td>
        <td>${item.stopId || 'n/d'}</td>
        <td>${formatUnix(item.arrivalTime)}</td>
        <td>${formatDelay(item.delay)}</td>
        <td>${formatCoordinate(item.lat, item.lon)}</td>
        <td>${formatSpeed(item.speed)}</td>
      </tr>
    `
    )
    .join('');
}

function renderStats(items, feedTs) {
  vehiclesCount.textContent = String(items.length);
  const totalDelay = items.reduce((acc, current) => acc + (Number.isNaN(current.delay) ? 0 : Math.max(current.delay, 0)), 0);
  const average = items.length ? Math.round(totalDelay / items.length / 60) : 0;
  avgDelay.textContent = `${average} min`;
  feedTimestamp.textContent = formatUnix(feedTs);
}

function getAvailableRouteIds(items) {
  return [...new Set(items.map((item) => item.routeId).filter(Boolean))].sort(compareRouteIds);
}

function ensureSelectedRoute(availableRouteIds) {
  if (!availableRouteIds.length) {
    selectedRouteId = '';
    return;
  }

  if (!selectedRouteId || !availableRouteIds.includes(selectedRouteId)) {
    selectedRouteId = availableRouteIds[0];
  }
}

function renderRouteSelector(availableRouteIds) {
  lineSelect.innerHTML = '';

  if (!availableRouteIds.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Nessuna linea disponibile';
    lineSelect.appendChild(option);
    lineSelect.disabled = true;
    mapTitle.textContent = 'Mappa live';
    return;
  }

  lineSelect.disabled = false;

  for (const routeId of availableRouteIds) {
    const option = document.createElement('option');
    option.value = routeId;
    option.textContent = `Linea ${routeId}`;
    if (routeId === selectedRouteId) {
      option.selected = true;
    }
    lineSelect.appendChild(option);
  }

  mapTitle.textContent = selectedRouteId ? `Mappa live linea ${selectedRouteId}` : 'Mappa live';
}

function updateMapTitle() {
  if (showAllOnMap) {
    mapTitle.textContent = 'Mappa live - tutte le linee';
    return;
  }

  mapTitle.textContent = selectedRouteId ? `Mappa live linea ${selectedRouteId}` : 'Mappa live';
}

function renderSelectedRouteView() {
  const filtered = selectedRouteId
    ? lastMergedEntities.filter((item) => item.routeId === selectedRouteId)
    : lastMergedEntities;

  const mapEntities = showAllOnMap ? lastMergedEntities : filtered;

  renderRows(filtered);
  renderStats(filtered, lastFeedTimestamp);
  updateMap(mapEntities);
  updateMapTitle();
}

async function loadData() {
  message.textContent = 'Aggiornamento in corso...';

  try {
    const [tripUpdatesResponse, vehiclePositionResponse] = await Promise.all([
      fetch('/api/tripupdates', { cache: 'no-store' }),
      fetch('/api/vehicleposition', { cache: 'no-store' })
    ]);

    if (!tripUpdatesResponse.ok) {
      throw new Error(`TripUpdates HTTP ${tripUpdatesResponse.status}`);
    }

    if (!vehiclePositionResponse.ok) {
      throw new Error(`VehiclePosition HTTP ${vehiclePositionResponse.status}`);
    }

    const [tripUpdatesXml, vehiclePositionXml] = await Promise.all([
      tripUpdatesResponse.text(),
      vehiclePositionResponse.text()
    ]);

    const { entities: tripEntities, feedTs } = parseTripUpdates(tripUpdatesXml);
    const positionsByTripId = parseVehiclePositions(vehiclePositionXml);
    lastMergedEntities = mergeTripAndPosition(tripEntities, positionsByTripId);
    lastFeedTimestamp = feedTs;

    const availableRouteIds = getAvailableRouteIds(lastMergedEntities);
    ensureSelectedRoute(availableRouteIds);
    renderRouteSelector(availableRouteIds);
    renderSelectedRouteView();

    message.textContent = `Dati aggiornati alle ${new Date().toLocaleTimeString('it-IT')}`;
  } catch (error) {
    message.textContent = `Errore durante il recupero feed: ${error.message}`;
    tableBody.innerHTML = '<tr><td colspan="7" class="placeholder">Impossibile leggere il feed in questo momento</td></tr>';
    lineSelect.innerHTML = '<option value="">Errore feed</option>';
    lineSelect.disabled = true;
    mapTitle.textContent = 'Mappa live';
    vehiclesCount.textContent = '-';
    avgDelay.textContent = '-';
    feedTimestamp.textContent = '-';
  }
}

function startAutoRefresh() {
  clearInterval(timer);
  timer = setInterval(loadData, REFRESH_MS);
}

refreshBtn.addEventListener('click', () => {
  loadData();
});

autoRefreshCheckbox.addEventListener('change', () => {
  if (autoRefreshCheckbox.checked) {
    startAutoRefresh();
  } else {
    clearInterval(timer);
  }
});

lineSelect.addEventListener('change', () => {
  selectedRouteId = lineSelect.value;
  renderSelectedRouteView();
});

mapAllToggle.addEventListener('change', () => {
  showAllOnMap = mapAllToggle.checked;
  renderSelectedRouteView();
});

loadData();
startAutoRefresh();
