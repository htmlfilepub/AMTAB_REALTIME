import { requestStaticPlan } from './planner.js';
import {
  calculateTrafficLightState,
  calculateTrafficLightArmState,
  trafficLightStateBadgeClass,
  trafficLightStateEmoji
} from './traffic-lights.js';

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

async function readJsonResponse(response, label) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    return response.json();
  }

  const raw = await response.text();
  const preview = raw.slice(0, 80).replace(/\s+/g, ' ').trim();
  throw new Error(`${label} non restituisce JSON valido (${preview || 'risposta vuota'})`);
}

const tableBody = document.querySelector('#tableBody');
const message = document.querySelector('#message');
const refreshBtn = document.querySelector('#refreshBtn');
const autoRefreshCheckbox = document.querySelector('#autoRefresh');
const mapAllToggle = document.querySelector('#mapAllToggle');
const toggleSemafori = document.querySelector('#toggleSemafori');
const semaforiZoomHint = document.querySelector('#semaforiZoomHint');
const lineSelect = document.querySelector('#lineSelect');
const mapTitle = document.querySelector('#mapTitle');
const vehiclesCount = document.querySelector('#vehiclesCount');
const avgDelay = document.querySelector('#avgDelay');
const feedTimestamp = document.querySelector('#feedTimestamp');
const tripDetailsSummary = document.querySelector('#tripDetailsSummary');
const upcomingStops = document.querySelector('#upcomingStops');
const serviceCalendarText = document.querySelector('#serviceCalendarText');
const locateBtn = document.querySelector('#locateBtn');
const pickFromMapBtn = document.querySelector('#pickFromMapBtn');
const pickDestinationFromMapBtn = document.querySelector('#pickDestinationFromMapBtn');
const destinationStopSelect = document.querySelector('#destinationStopSelect');
const routeNowBtn = document.querySelector('#routeNowBtn');
const allowTransfers = document.querySelector('#allowTransfers');
const routeAutoRefresh = document.querySelector('#routeAutoRefresh');
const mapDestinationText = document.querySelector('#mapDestinationText');

const feedBanner = document.querySelector('#feedBanner');
const feedBannerText = document.querySelector('#feedBannerText');
const feedBannerDismiss = document.querySelector('#feedBannerDismiss');

let feedConsecutiveFailures = 0;
let feedBannerDismissedAt = 0;
const routeSummaryText = document.querySelector('#routeSummaryText');
const routeSteps = document.querySelector('#routeSteps');
const routeOptionsList = document.querySelector('#routeOptionsList');
const routeDebugToggle = document.querySelector('#routeDebugToggle');
const routeDebugOutput = document.querySelector('#routeDebugOutput');

const REFRESH_MS = 15000;
const MAP_DEFAULT_CENTER = [41.1171, 16.8719];
const MAP_DEFAULT_ZOOM = 13;
const WALK_SPEED_MPS = 1.35;
const MAX_WALK_METERS = 500;
const MAX_WALK_METERS_FALLBACK = 2800;
const BOARDING_BUFFER_SECONDS = 45;
const MAX_FUTURE_LOOKAHEAD_SECONDS = 90 * 60;
const DESTINATION_ALTERNATIVE_RADIUS_METERS = 900;
const SEMAFORI_REFRESH_MS = 1000;
const SEMAFORI_MIN_ZOOM = 14;
let timer = null;
let map = null;
const markerByTripId = new Map();
let hasCenteredOnVehicles = false;
let selectedRouteId = '';
let lastMergedEntities = [];
let lastFeedTimestamp = 0;
let showAllOnMap = false;
let stopNameById = new Map();
let stopLocationById = new Map();
let routeShapeLayer = null;
let selectedTripContext = null;
let userPosition = null;
let manualPosition = null;
let activeOriginMode = 'gps';
let userMarker = null;
let userWatchId = null;
let navRouteLayer = null;
let routingBusy = false;
let mapPickMode = null;
let routeDebugEnabled = true;
let destinationPosition = null;
let destinationMarker = null;
let currentRouteOptions = [];
let selectedRouteOptionKey = '';
let stopsEndpointCache = '';
let stopsApiDisabled = false;
let semaforiLayer = null;
let semaforiLoaded = false;
let semaforiData = [];
let semaforiTimer = null;
const semaforiMarkersById = new Map();
const tripDetailsCache = new Map();
const routeDebugLines = [];

function renderRouteDebug() {
  if (!routeDebugOutput) {
    return;
  }

  if (!routeDebugEnabled) {
    routeDebugOutput.textContent = 'Debug disattivato.';
    return;
  }

  routeDebugOutput.textContent = routeDebugLines.length ? routeDebugLines.join('\n') : 'Debug attivo.';
}

function clearRouteDebug() {
  routeDebugLines.length = 0;
  renderRouteDebug();
}

function appendRouteDebug(text) {
  if (!routeDebugEnabled) {
    return;
  }

  const stamp = new Date().toLocaleTimeString('it-IT');
  routeDebugLines.push(`[${stamp}] ${text}`);
  if (routeDebugLines.length > 80) {
    routeDebugLines.splice(0, routeDebugLines.length - 80);
  }
  renderRouteDebug();
}

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

function showFeedBanner(text, level) {
  if (!feedBanner) return;
  const now = Date.now();
  if (level !== 'error' && feedBannerDismissedAt && now - feedBannerDismissedAt < 60_000) return;
  feedBanner.className = `feed-banner feed-banner--${level}`;
  feedBannerText.textContent = text;
  feedBanner.hidden = false;
}

function hideFeedBanner() {
  if (!feedBanner) return;
  feedBanner.hidden = true;
}

if (feedBannerDismiss) {
  feedBannerDismiss.addEventListener('click', () => {
    hideFeedBanner();
    feedBannerDismissedAt = Date.now();
  });
}

function formatPositionAge(positionTimestamp) {
  if (!positionTimestamp) return '';
  const ageSeconds = Math.floor(Date.now() / 1000 - positionTimestamp);
  if (ageSeconds < 0 || Number.isNaN(ageSeconds)) return '';
  if (ageSeconds < 30) return '';
  if (ageSeconds < 60) return `${ageSeconds}s fa`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)} min fa`;
  return `${Math.floor(ageSeconds / 3600)}h fa`;
}

function formatStopName(stopId) {
  if (!stopId) {
    return 'n/d';
  }

  const name = stopNameById.get(stopId);
  return name || 'Fermata non disponibile';
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

  if (!map.getPane('semaforiPane')) {
    const pane = map.createPane('semaforiPane');
    pane.style.zIndex = '620';
  }

  map.on('zoomend', () => {
    applySemaforiVisibility();
  });

  map.on('click', (event) => {
    if (!mapPickMode) {
      return;
    }

    if (mapPickMode === 'origin') {
      manualPosition = {
        lat: event.latlng.lat,
        lon: event.latlng.lng,
        accuracy: null
      };
      activeOriginMode = 'manual';
      mapPickMode = null;
      updateUserMarker();
      setRouteSummary(
        `Posizione partenza impostata (${manualPosition.lat.toFixed(5)}, ${manualPosition.lon.toFixed(5)}).`
      );

      if (routeAutoRefresh.checked) {
        calculateRouteToSelectedStop();
      }
      return;
    }

    if (mapPickMode === 'destination') {
      destinationPosition = {
        lat: event.latlng.lat,
        lon: event.latlng.lng
      };
      mapPickMode = null;
      syncDestinationFromMapPoint();
      if (routeAutoRefresh.checked) {
        calculateRouteToSelectedStop();
      }
    }
  });

  applySemaforiVisibility();
}

function semaforoStatusLabel(stato) {
  switch (stato) {
    case 'verde':
      return 'Verde';
    case 'giallo':
      return 'Giallo';
    case 'rosso':
      return 'Rosso';
    case 'lampeggiante':
      return 'Giallo lampeggiante';
    case 'spento':
      return 'Spento';
    default:
      return 'Spento';
  }
}

function createSemaforoIcon(stato) {
  const activeRed = stato === 'rosso';
  const activeYellow = stato === 'giallo' || stato === 'lampeggiante';
  const activeGreen = stato === 'verde';
  const flashingClass = stato === 'lampeggiante' ? ' semaforo-lampeggiante' : '';

  return L.divIcon({
    className: `semaforo-icon${flashingClass}`,
    html: `
      <svg class="semaforo-svg" viewBox="0 0 16 32" aria-hidden="true">
        <rect x="2" y="1" width="12" height="30" rx="3" fill="#1f2937" stroke="#111827" stroke-width="1"/>
        <rect x="4" y="4.6" width="8" height="1.4" rx="0.8" fill="#0b0f16"/>
        <rect x="4" y="13.6" width="8" height="1.4" rx="0.8" fill="#0b0f16"/>
        <rect x="4" y="22.6" width="8" height="1.4" rx="0.8" fill="#0b0f16"/>
        <circle class="semaforo-luce luce-rosso${activeRed ? ' attiva' : ''}" cx="8" cy="8" r="2.8" fill="#ef4444" style="color:#ef4444" />
        <circle class="semaforo-luce luce-giallo${activeYellow ? ' attiva' : ''}" cx="8" cy="16" r="2.8" fill="#eab308" style="color:#eab308" />
        <circle class="semaforo-luce luce-verde${activeGreen ? ' attiva' : ''}" cx="8" cy="24" r="2.8" fill="#22c55e" style="color:#22c55e" />
      </svg>
    `,
    iconSize: [16, 32],
    iconAnchor: [8, 16]
  });
}

function renderSemaforoPopup(item, state) {
  const badgeClass = trafficLightStateBadgeClass(state.stato);
  const emoji = trafficLightStateEmoji(state.stato);
  const seconds = Math.max(0, Math.round((state.rimanentiMs || 0) / 1000));

  return [
    `<b>Semaforo #${item.id}</b>`,
    `📍 ${item.indirizzo || 'n/d'}`,
    `🏛️ ${item.municipio || 'n/d'}`,
    `Stato: <span class="semaforo-popup-badge ${badgeClass}">${emoji} ${semaforoStatusLabel(state.stato)}</span>`,
    `Cambio tra: ${seconds}s`,
    item.isOndaVerde ? '🌊 Onda Verde attiva' : ''
  ]
    .filter(Boolean)
    .join('<br>');
}

function clampSemaforiApproachCount(value) {
  const n = Number(value);
  if (Number.isNaN(n)) {
    return 1;
  }
  return Math.max(1, Math.min(8, Math.round(n)));
}

function offsetLatLonMeters(lat, lon, distanceMeters, bearingDeg) {
  const earth = 6378137;
  const bearing = (bearingDeg * Math.PI) / 180;
  const dLat = (distanceMeters * Math.cos(bearing)) / earth;
  const dLon = (distanceMeters * Math.sin(bearing)) / (earth * Math.cos((lat * Math.PI) / 180));

  return {
    lat: lat + (dLat * 180) / Math.PI,
    lon: lon + (dLon * 180) / Math.PI
  };
}

function buildSemaforiArmBearings(count) {
  if (count <= 1) {
    return [0];
  }

  if (count === 2) {
    return [90, 270];
  }

  if (count === 3) {
    return [30, 150, 270];
  }

  if (count === 4) {
    return [45, 135, 225, 315];
  }

  const values = [];
  const step = 360 / count;
  for (let i = 0; i < count; i += 1) {
    values.push((i * step) % 360);
  }
  return values;
}

function getSemaforoArmPoints(item) {
  const count = clampSemaforiApproachCount(item.approachCount);
  if (count <= 1) {
    return [{ lat: item.lat, lon: item.lon, armIndex: 1, armTotal: 1 }];
  }

  const radiusMeters = count <= 4 ? 7.5 : 9;
  const bearings = buildSemaforiArmBearings(count);
  return bearings.map((bearing, idx) => {
    const point = offsetLatLonMeters(item.lat, item.lon, radiusMeters, bearing);
    return {
      lat: point.lat,
      lon: point.lon,
      armIndex: idx + 1,
      armTotal: count
    };
  });
}

function renderSemaforoPopupWithArm(item, state, armIndex, armTotal) {
  const suffix = armTotal > 1 ? `<br>🚦 Braccio ${armIndex}/${armTotal}` : '';
  const source = item.approachCountSource ? `<br>Conteggio: ${item.approachCountSource}` : '';
  return `${renderSemaforoPopup(item, state)}${suffix}${source}`;
}

function semaforiShouldBeVisible() {
  return Boolean(toggleSemafori?.checked) && Boolean(map) && map.getZoom() >= SEMAFORI_MIN_ZOOM;
}

function updateSemaforiZoomHint() {
  if (!semaforiZoomHint) {
    return;
  }

  if (!toggleSemafori?.checked) {
    semaforiZoomHint.textContent = '';
    return;
  }

  if (!map || map.getZoom() < SEMAFORI_MIN_ZOOM) {
    semaforiZoomHint.textContent = 'Zoom in per vedere i semafori.';
    return;
  }

  semaforiZoomHint.textContent = '';
}

function stopSemaforiTicker() {
  if (semaforiTimer) {
    clearInterval(semaforiTimer);
    semaforiTimer = null;
  }
}

function startSemaforiTicker() {
  if (semaforiTimer) {
    return;
  }

  semaforiTimer = setInterval(() => {
    updateSemaforiStates();
  }, SEMAFORI_REFRESH_MS);
}

async function loadSemafori() {
  const candidates = buildApiCandidates('api/semafori');
  let lastError = null;

  for (const endpoint of candidates) {
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Semafori HTTP ${response.status}`);
      }

      const source = (response.headers.get('x-data-source') || '').toLowerCase();
      const payload = await readJsonResponse(response, 'Semafori API');
      const data = Array.isArray(payload) ? payload : [];

      if (source === 'unavailable') {
        message.textContent = 'Dati semafori non disponibili.';
      }

      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Semafori non disponibili');
}

function renderSemaforiMarkers() {
  if (!map || typeof L === 'undefined') {
    return;
  }

  if (!semaforiLayer) {
    semaforiLayer = L.layerGroup();
  }

  semaforiLayer.clearLayers();
  semaforiMarkersById.clear();

  for (const item of semaforiData) {
    const now = Date.now();
    const armPoints = getSemaforoArmPoints(item);

    armPoints.forEach((armPoint) => {
      const state = calculateTrafficLightArmState(item, armPoint.armIndex, armPoint.armTotal, now);
      const marker = L.marker([armPoint.lat, armPoint.lon], {
        icon: createSemaforoIcon(state.stato),
        pane: 'semaforiPane'
      });

      marker.bindPopup(renderSemaforoPopupWithArm(item, state, armPoint.armIndex, armPoint.armTotal));
      semaforiLayer.addLayer(marker);

      const markerKey = `${item.id}__${item.lat.toFixed(5)}__${item.lon.toFixed(5)}__${armPoint.armIndex}`;
      semaforiMarkersById.set(markerKey, {
        marker,
        item,
        stato: state.stato,
        armIndex: armPoint.armIndex,
        armTotal: armPoint.armTotal
      });
    });
  }
}

function updateSemaforiStates() {
  if (!semaforiMarkersById.size) {
    return;
  }

  const now = Date.now();

  for (const data of semaforiMarkersById.values()) {
    const next = calculateTrafficLightArmState(data.item, data.armIndex, data.armTotal, now);

    if (next.stato !== data.stato) {
      data.marker.setIcon(createSemaforoIcon(next.stato));
      data.stato = next.stato;
    }

    const element = data.marker.getElement();
    if (element) {
      element.classList.toggle('semaforo-lampeggiante', next.stato === 'lampeggiante');
    }

    if (data.marker.isPopupOpen()) {
      data.marker.setPopupContent(renderSemaforoPopupWithArm(data.item, next, data.armIndex, data.armTotal));
    }
  }
}

async function enableSemaforiLayer() {
  initMap();

  if (!semaforiLoaded) {
    try {
      semaforiData = await loadSemafori();
      semaforiLoaded = true;
      renderSemaforiMarkers();
    } catch {
      semaforiData = [];
      semaforiLoaded = true;
      message.textContent = 'Dati semafori non disponibili.';
    }
  }

  updateSemaforiStates();

  if (semaforiShouldBeVisible() && semaforiLayer) {
    semaforiLayer.addTo(map);
  } else if (semaforiLayer && map.hasLayer(semaforiLayer)) {
    map.removeLayer(semaforiLayer);
  }

  startSemaforiTicker();
  updateSemaforiZoomHint();
}

function disableSemaforiLayer() {
  stopSemaforiTicker();
  if (map && semaforiLayer && map.hasLayer(semaforiLayer)) {
    map.removeLayer(semaforiLayer);
  }
  updateSemaforiZoomHint();
}

function applySemaforiVisibility() {
  updateSemaforiZoomHint();
  if (!toggleSemafori?.checked) {
    disableSemaforiLayer();
    return;
  }

  if (!map) {
    return;
  }

  if (!semaforiShouldBeVisible()) {
    if (semaforiLayer && map.hasLayer(semaforiLayer)) {
      map.removeLayer(semaforiLayer);
    }
    return;
  }

  if (semaforiLayer) {
    semaforiLayer.addTo(map);
  }
}

function findNearestStopToPoint(point) {
  if (!point) {
    return null;
  }

  let nearest = null;
  for (const [stopId, location] of stopLocationById.entries()) {
    const distanceMeters = haversineMeters(point.lat, point.lon, location.lat, location.lon);
    if (!nearest || distanceMeters < nearest.distanceMeters) {
      nearest = {
        stopId,
        location,
        distanceMeters
      };
    }
  }

  return nearest;
}

function updateDestinationMarker() {
  if (!map) {
    return;
  }

  if (!destinationPosition) {
    if (destinationMarker) {
      map.removeLayer(destinationMarker);
      destinationMarker = null;
    }
    return;
  }

  const latLng = [destinationPosition.lat, destinationPosition.lon];
  if (!destinationMarker) {
    destinationMarker = L.circleMarker(latLng, {
      radius: 7,
      color: '#6a1b9a',
      fillColor: '#ab47bc',
      fillOpacity: 0.9,
      weight: 2
    }).addTo(map);
    destinationMarker.bindPopup('Punto di arrivo');
    return;
  }

  destinationMarker.setLatLng(latLng);
}

function syncDestinationFromMapPoint() {
  updateDestinationMarker();

  if (!destinationPosition) {
    mapDestinationText.textContent = 'Arrivo non impostato. Clicca “Scegli arrivo dalla mappa”.';
    return;
  }

  const nearest = findNearestStopToPoint(destinationPosition);
  if (!nearest) {
    mapDestinationText.textContent = `Arrivo impostato (${destinationPosition.lat.toFixed(5)}, ${destinationPosition.lon.toFixed(5)}), ma nessuna fermata disponibile.`;
    return;
  }

  if (destinationStopSelect.querySelector(`option[value="${nearest.stopId}"]`)) {
    destinationStopSelect.value = nearest.stopId;
  }

  mapDestinationText.textContent = `Arrivo mappa (${destinationPosition.lat.toFixed(5)}, ${destinationPosition.lon.toFixed(5)}) · fermata più vicina: ${formatStopName(nearest.stopId)} (${Math.round(nearest.distanceMeters)} m).`;
}

function buildPopup(item) {
  const lines = [
    `<strong>Linea:</strong> ${item.routeId || 'n/d'}`,
    `<strong>Veicolo:</strong> ${item.vehicleId || 'n/d'}`,
    `<strong>Trip:</strong> ${item.tripId || 'n/d'}`,
    `<strong>Velocità:</strong> ${formatSpeed(item.speed)}`,
    `<strong>Ritardo:</strong> ${formatDelay(item.delay)}`
  ];

  const age = formatPositionAge(item.positionTimestamp);
  if (age) {
    lines.push(`<span class="popup-stale">📡 Posizione aggiornata ${age}</span>`);
  }

  if (item.confirmedRouteId && item.routeId !== item.confirmedRouteId) {
    lines.push(`<span class="popup-stale">⚠️ Linea confermata: ${item.confirmedRouteId}</span>`);
  }

  return lines.join('<br/>');
}

function formatDistanceMeters(meters) {
  if (meters == null || Number.isNaN(meters)) {
    return 'n/d';
  }

  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }

  return `${Math.round(meters)} m`;
}

function formatDurationSeconds(seconds) {
  if (seconds == null || Number.isNaN(seconds)) {
    return 'n/d';
  }

  const mins = Math.round(seconds / 60);
  if (mins < 60) {
    return `${mins} min`;
  }

  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function formatClockFromEta(etaSeconds) {
  if (etaSeconds == null || Number.isNaN(etaSeconds)) {
    return 'n/d';
  }

  const date = new Date(Date.now() + etaSeconds * 1000);
  return date.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getRouteOptionKey(option) {
  const route = option?.routeId || '';
  const trip = option?.tripId || '';
  const board = option?.boardStopId || '';
  const transferRoute = option?.transferRouteId || '';
  const transferStop = option?.transferStopId || '';
  const destination = option?.destinationStopId || '';
  return `${route}__${trip}__${board}__${transferRoute}__${transferStop}__${destination}`;
}

function parseGtfsTimeToSeconds(timeText) {
  if (!timeText) {
    return NaN;
  }

  const [h, m, s] = timeText.split(':').map((value) => Number(value));
  if ([h, m, s].some((value) => Number.isNaN(value))) {
    return NaN;
  }

  return h * 3600 + m * 60 + s;
}

function toFutureDeltaSeconds(gtfsTimeText) {
  const now = new Date();
  const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const target = parseGtfsTimeToSeconds(gtfsTimeText);
  if (Number.isNaN(target)) {
    return NaN;
  }

  const delta = target - nowSeconds;
  if (delta < -1800) {
    return NaN;
  }

  if (delta < 0) {
    return 0;
  }

  if (delta > MAX_FUTURE_LOOKAHEAD_SECONDS) {
    return NaN;
  }

  return delta;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function setRouteSummary(text) {
  routeSummaryText.textContent = text;
}

function clearNavigationLayer() {
  if (map && navRouteLayer) {
    map.removeLayer(navRouteLayer);
    navRouteLayer = null;
  }
}

function getEffectiveOriginPosition() {
  if (activeOriginMode === 'manual' && manualPosition) {
    return manualPosition;
  }

  return userPosition;
}

function updateUserMarker() {
  const origin = getEffectiveOriginPosition();
  if (!map || !origin) {
    return;
  }

  if (!userMarker) {
    userMarker = L.circleMarker([origin.lat, origin.lon], {
      radius: 8,
      color: '#f57c00',
      fillColor: '#ffb74d',
      fillOpacity: 0.9,
      weight: 2
    }).addTo(map);
    userMarker.bindPopup('La tua posizione');
    return;
  }

  userMarker.setLatLng([origin.lat, origin.lon]);
}

function refreshDestinationOptions() {
  const currentValue = destinationStopSelect.value;
  const unique = new Map();
  const seenNameKeys = new Set();
  for (const [stopId] of stopLocationById.entries()) {
    const stopName = formatStopName(stopId);
    const nameKey = stopName.trim().toLocaleLowerCase('it-IT');
    if (seenNameKeys.has(nameKey)) {
      continue;
    }
    seenNameKeys.add(nameKey);

    unique.set(stopId, {
      stopId,
      label: `${stopName} (${stopId})`
    });
  }

  destinationStopSelect.innerHTML = '';

  if (!unique.size) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Nessuna fermata disponibile';
    destinationStopSelect.appendChild(option);
    destinationStopSelect.disabled = true;
    return;
  }

  destinationStopSelect.disabled = false;
  [...unique.values()].sort((a, b) => a.label.localeCompare(b.label, 'it-IT')).forEach((item) => {
    const option = document.createElement('option');
    option.value = item.stopId;
    option.textContent = item.label;
    destinationStopSelect.appendChild(option);
  });

  if (selectedTripContext?.currentStopId && unique.has(selectedTripContext.currentStopId)) {
    destinationStopSelect.value = selectedTripContext.currentStopId;
  } else if (currentValue && unique.has(currentValue)) {
    destinationStopSelect.value = currentValue;
  }

  syncDestinationFromMapPoint();
}

function renderRouteSteps(route) {
  routeSteps.innerHTML = '';

  const steps = route?.legs?.[0]?.steps || [];
  if (!steps.length) {
    routeSteps.innerHTML = '<li>Nessuna indicazione disponibile</li>';
    return;
  }

  routeSteps.innerHTML = steps
    .slice(0, 12)
    .map((step) => {
      const road = step.name ? ` su ${step.name}` : '';
      const action = step.maneuver?.type || 'Procedi';
      return `<li>${action}${road} · ${formatDistanceMeters(step.distance)} · ${formatDurationSeconds(step.duration)}</li>`;
    })
    .join('');
}

function renderBusRouteSteps(best) {
  routeSteps.innerHTML = '';

  const boardTimeText = formatClockFromEta(best.boardEtaSeconds);
  const destinationTimeText = formatClockFromEta(best.destinationEtaSeconds);
  const transferBoardTimeText = formatClockFromEta(best.transferBoardEtaSeconds);

  if (best.transferCount > 0 && best.transferStopName) {
    const lines = [
      `Raggiungi a piedi ${best.boardStopName} (${formatDistanceMeters(best.walkDistanceMeters)}, circa ${formatDurationSeconds(best.walkSeconds)}).`,
      `Primo bus: linea ${best.routeId} (partenza ${boardTimeText}) fino a ${best.transferStopName}.`,
      `Cambio: linea ${best.transferRouteId} da ${best.transferStopName} (partenza ${transferBoardTimeText}) a ${best.destinationStopName}.`,
      `Arrivo previsto: ${destinationTimeText}. Tempo totale: ${formatDurationSeconds(best.totalSeconds)}.`
    ];
    routeSteps.innerHTML = lines.map((line) => `<li>${line}</li>`).join('');
    return;
  }

  const lines = [
    `Raggiungi a piedi ${best.boardStopName} (${formatDistanceMeters(best.walkDistanceMeters)}, circa ${formatDurationSeconds(best.walkSeconds)}).`,
    `Attendi il bus linea ${best.routeId} (veicolo ${best.vehicleId || 'n/d'}) con partenza prevista alle ${boardTimeText}.`,
    `Sali e scendi a ${best.destinationStopName} dopo ${best.stopsToTravel} fermate (arrivo previsto alle ${destinationTimeText}).`
  ];

  routeSteps.innerHTML = lines.map((line) => `<li>${line}</li>`).join('');
}

function renderRouteOptionCards(options, best) {
  if (!routeOptionsList) {
    return;
  }

  if (!Array.isArray(options) || !options.length) {
    routeOptionsList.innerHTML = '';
    return;
  }

  const top = options.slice(0, 24);

  const DEDUP_BUCKET_SECONDS = 180; // 3-minute window
  const uiUnique = [];
  const uiSeen = new Set();
  for (const item of top) {
    const uiKey = [
      item.routeId,
      item.transferRouteId || '',
      item.boardStopId,
      item.destinationStopId,
      Math.floor((item.boardEtaSeconds || 0) / DEDUP_BUCKET_SECONDS),
      Math.floor((item.transferBoardEtaSeconds || 0) / DEDUP_BUCKET_SECONDS),
      Math.floor((item.destinationEtaSeconds || 0) / DEDUP_BUCKET_SECONDS),
      Math.floor((item.totalSeconds || 0) / DEDUP_BUCKET_SECONDS)
    ].join('__');
    if (uiSeen.has(uiKey)) {
      continue;
    }
    uiSeen.add(uiKey);
    uiUnique.push(item);
  }

  const groups = new Map();
  for (const item of uiUnique) {
    const lineLabel = item.transferCount > 0 && item.transferRouteId
      ? `${item.routeId} → ${item.transferRouteId}`
      : String(item.routeId || '?');
    const values = groups.get(lineLabel) || [];
    values.push(item);
    groups.set(lineLabel, values);
  }

  const groupCards = [...groups.entries()].map(([lineLabel, values]) => {
    values.sort((a, b) => a.boardEtaSeconds - b.boardEtaSeconds || a.totalSeconds - b.totalSeconds || a.walkDistanceMeters - b.walkDistanceMeters);
    const head = values[0];
    const others = values.slice(1, 6);
    const headKey = getRouteOptionKey(head);
    const isBest =
      best &&
      head.routeId === best.routeId &&
      head.tripId === best.tripId &&
      head.boardStopId === best.boardStopId &&
      (head.transferRouteId || '') === (best.transferRouteId || '');
    const isSelected = selectedRouteOptionKey && selectedRouteOptionKey === headKey;

    const lineText = head.transferCount > 0
      ? `Linee ${lineLabel}`
      : `Linea ${lineLabel}`;

    const transferText = head.transferCount > 0 && head.transferStopName
      ? ` · Cambio: ${head.transferStopName}`
      : '';

    const othersMarkup = others.length
      ? `
        <details class="route-option-more">
          <summary>Vedi altri orari (${others.length})</summary>
          <div class="route-option-more-list">
            ${others
              .map(
                (item) => {
                  const itemKey = getRouteOptionKey(item);
                  const isItemSelected = selectedRouteOptionKey && selectedRouteOptionKey === itemKey;
                  return `
              <article class="route-option-card route-option-card--extra ${isItemSelected ? 'route-option-card--selected' : ''}" data-route-key="${itemKey}">
                <div class="route-option-meta">
                  <span class="route-option-chip">Walk ${formatDistanceMeters(item.walkDistanceMeters)}</span>
                  <span class="route-option-chip">Partenza ${formatClockFromEta(item.boardEtaSeconds)}</span>
                  ${item.transferCount > 0 ? `<span class="route-option-chip">Cambio ${formatClockFromEta(item.transferBoardEtaSeconds)}</span>` : ''}
                  <span class="route-option-chip">Arrivo ${formatClockFromEta(item.destinationEtaSeconds)}</span>
                  <span class="route-option-chip">Totale ${formatDurationSeconds(item.totalSeconds)}</span>
                </div>
                <p class="route-option-line">Salita: ${item.boardStopName} · Discesa: ${item.destinationStopName}</p>
              </article>
            `;
                }
              )
              .join('')}
          </div>
        </details>
      `
      : '';

    return `
      <article class="route-option-card ${isBest ? 'route-option-card--best' : ''} ${isSelected ? 'route-option-card--selected' : ''}" data-route-key="${headKey}">
        <p class="route-option-title">${lineText}${head.vehicleId ? ` · Veicolo ${head.vehicleId}` : ''}</p>
        <div class="route-option-meta">
          <span class="route-option-chip">Walk ${formatDistanceMeters(head.walkDistanceMeters)}</span>
          <span class="route-option-chip">Partenza ${formatClockFromEta(head.boardEtaSeconds)}</span>
          ${head.transferCount > 0 ? `<span class="route-option-chip">Cambio ${formatClockFromEta(head.transferBoardEtaSeconds)}</span>` : ''}
          <span class="route-option-chip">Arrivo ${formatClockFromEta(head.destinationEtaSeconds)}</span>
          <span class="route-option-chip">Totale ${formatDurationSeconds(head.totalSeconds)}</span>
        </div>
        <p class="route-option-line">Salita: ${head.boardStopName}</p>
        <p class="route-option-line">Discesa: ${head.destinationStopName}</p>
        <p class="route-option-line">Fermate: ${head.stopsToTravel}${transferText}${isBest ? ' · Consigliato' : ''}</p>
        ${othersMarkup}
      </article>
    `;
  });

  routeOptionsList.innerHTML = groupCards.join('');
}

function buildFallbackSegment(start, end) {
  if (!start || !end) {
    return [];
  }

  return [
    [start.lat, start.lon],
    [end.lat, end.lon]
  ];
}

function extractStopPathFromTimeline(timeline, startStopId, endStopId) {
  if (!Array.isArray(timeline) || !timeline.length || !startStopId || !endStopId) {
    return [];
  }

  const startIndex = timeline.findIndex((item) => item.stopId === startStopId);
  if (startIndex < 0) {
    return [];
  }

  const endIndex = timeline.findIndex((item, index) => index > startIndex && item.stopId === endStopId);
  if (endIndex < 0) {
    return [];
  }

  const points = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const stopId = timeline[index].stopId;
    const loc = stopLocationById.get(stopId);
    if (!loc) {
      continue;
    }

    const prev = points[points.length - 1];
    if (prev && prev[0] === loc.lat && prev[1] === loc.lon) {
      continue;
    }

    points.push([loc.lat, loc.lon]);
  }

  return points;
}

function findNearestPointIndex(points, location, startIndex = 0, endIndex = points.length - 1) {
  if (!Array.isArray(points) || !points.length || !location) {
    return -1;
  }

  const safeStart = Math.max(0, startIndex);
  const safeEnd = Math.min(points.length - 1, endIndex);
  if (safeStart > safeEnd) {
    return -1;
  }

  let bestIndex = -1;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (let index = safeStart; index <= safeEnd; index += 1) {
    const point = points[index];
    if (!Array.isArray(point) || point.length < 2) {
      continue;
    }

    const lat = Number(point[0]);
    const lon = Number(point[1]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      continue;
    }

    const distance = haversineMeters(location.lat, location.lon, lat, lon);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function extractPathFromShape(shapePoints, startLocation, endLocation) {
  if (!Array.isArray(shapePoints) || shapePoints.length < 2 || !startLocation || !endLocation) {
    return [];
  }

  const startIndex = findNearestPointIndex(shapePoints, startLocation);
  if (startIndex < 0) {
    return [];
  }

  const endIndex = findNearestPointIndex(shapePoints, endLocation, startIndex + 1, shapePoints.length - 1);
  if (endIndex < 0 || endIndex <= startIndex) {
    return [];
  }

  const segment = shapePoints.slice(startIndex, endIndex + 1);
  if (segment.length < 2) {
    return [];
  }

  const startPoint = [startLocation.lat, startLocation.lon];
  const endPoint = [endLocation.lat, endLocation.lon];
  const first = segment[0];
  const last = segment[segment.length - 1];

  if (haversineMeters(first[0], first[1], startPoint[0], startPoint[1]) > 15) {
    segment.unshift(startPoint);
  } else {
    segment[0] = startPoint;
  }

  if (haversineMeters(last[0], last[1], endPoint[0], endPoint[1]) > 15) {
    segment.push(endPoint);
  } else {
    segment[segment.length - 1] = endPoint;
  }

  return segment;
}

async function getTripDetailsForRouteSegment(routeId, tripId, currentStopId) {
  if (!tripId) {
    return null;
  }

  const cacheKey = `${routeId || ''}__${tripId}`;
  if (tripDetailsCache.has(cacheKey)) {
    return tripDetailsCache.get(cacheKey);
  }

  const params = new URLSearchParams({
    routeId: routeId || '',
    tripId,
    currentStopId: currentStopId || '',
    delay: '0'
  });

  const response = await fetch(apiUrl(`api/tripdetails?${params.toString()}`), { cache: 'no-store' });
  if (!response.ok) {
    return null;
  }

  const details = await response.json();
  tripDetailsCache.set(cacheKey, details);
  return details;
}

async function resolveBusPathSegments(best) {
  const board = best.boardStopLocation;
  const transfer = best.transferStopLocation;
  const destination = best.destinationStopLocation;

  if (best.transferCount > 0) {
    const [firstTripId, secondTripId] = String(best.tripId || '').split('|');

    const firstDetails = await getTripDetailsForRouteSegment(best.routeId, firstTripId || best.tripId, best.boardStopId);
    const secondDetails = await getTripDetailsForRouteSegment(best.transferRouteId, secondTripId || '', best.transferStopId);

    const firstSegmentFromTimeline = extractStopPathFromTimeline(
      firstDetails?.stopTimeline || [],
      best.boardStopId,
      best.transferStopId
    );

    const firstFullShape = Array.isArray(firstDetails?.shapePoints) ? firstDetails.shapePoints : [];
    const firstSegmentFromShape = extractPathFromShape(firstFullShape, board, transfer || destination);

    const secondSegmentFromTimeline = extractStopPathFromTimeline(
      secondDetails?.stopTimeline || [],
      best.transferStopId,
      best.destinationStopId
    );

    const secondFullShape = Array.isArray(secondDetails?.shapePoints) ? secondDetails.shapePoints : [];
    const secondSegmentFromShape = extractPathFromShape(secondFullShape, transfer || board, destination);

    const firstSegment = firstSegmentFromShape.length >= 2
      ? firstSegmentFromShape
      : firstSegmentFromTimeline.length >= 2
        ? firstSegmentFromTimeline
        : buildFallbackSegment(board, transfer || destination);

    const secondSegment = secondSegmentFromShape.length >= 2
      ? secondSegmentFromShape
      : secondSegmentFromTimeline.length >= 2
        ? secondSegmentFromTimeline
        : buildFallbackSegment(transfer || board, destination);

    return {
      firstSegment,
      secondSegment
    };
  }

  const directTripId = String(best.tripId || '').split('|')[0] || best.tripId;
  const directDetails = await getTripDetailsForRouteSegment(best.routeId, directTripId, best.boardStopId);
  const directSegmentFromTimeline = extractStopPathFromTimeline(
    directDetails?.stopTimeline || [],
    best.boardStopId,
    best.destinationStopId
  );

  const directFullShape = Array.isArray(directDetails?.shapePoints) ? directDetails.shapePoints : [];
  const directSegmentFromShape = extractPathFromShape(directFullShape, board, destination);

  const directSegment = directSegmentFromShape.length >= 2
    ? directSegmentFromShape
    : directSegmentFromTimeline.length >= 2
      ? directSegmentFromTimeline
      : buildFallbackSegment(board, destination);

  return {
    firstSegment: directSegment,
    secondSegment: []
  };
}

async function renderBusRouteOnMap(best) {
  clearNavigationLayer();
  if (!map) {
    return;
  }

  const origin = getEffectiveOriginPosition();
  if (!origin) {
    return;
  }

  const board = best.boardStopLocation;
  const transfer = best.transferStopLocation;
  const destination = best.destinationStopLocation;
  if (!board || !destination) {
    return;
  }

  const segments = await resolveBusPathSegments(best);

  navRouteLayer = L.layerGroup();

  const walkSegment = L.polyline(
    [
      [origin.lat, origin.lon],
      [board.lat, board.lon]
    ],
    {
      color: '#2e7d32',
      weight: 4,
      dashArray: '8,6',
      opacity: 0.9
    }
  );

  const busSegmentA = L.polyline(
    segments.firstSegment,
    {
      color: '#e53935',
      weight: 5,
      opacity: 0.9
    }
  );

  let busSegmentB = null;
  if (best.transferCount > 0 && transfer) {
    busSegmentB = L.polyline(
      segments.secondSegment.length >= 2 ? segments.secondSegment : buildFallbackSegment(transfer, destination),
      {
        color: '#1565c0',
        weight: 5,
        opacity: 0.9
      }
    );
  }

  const boardMarker = L.circleMarker([board.lat, board.lon], {
    radius: 6,
    color: '#2e7d32',
    fillColor: '#66bb6a',
    fillOpacity: 1,
    weight: 2
  }).bindPopup(`Salita: ${best.boardStopName}`);

  const destinationMarker = L.circleMarker([destination.lat, destination.lon], {
    radius: 6,
    color: '#c62828',
    fillColor: '#ef5350',
    fillOpacity: 1,
    weight: 2
  }).bindPopup(`Discesa: ${best.destinationStopName}`);

  let transferMarker = null;
  if (best.transferCount > 0 && transfer) {
    transferMarker = L.circleMarker([transfer.lat, transfer.lon], {
      radius: 6,
      color: '#0d47a1',
      fillColor: '#42a5f5',
      fillOpacity: 1,
      weight: 2
    }).bindPopup(`Cambio: ${best.transferStopName}`);
  }

  navRouteLayer.addLayer(walkSegment);
  navRouteLayer.addLayer(busSegmentA);
  if (busSegmentB) {
    navRouteLayer.addLayer(busSegmentB);
  }
  navRouteLayer.addLayer(boardMarker);
  if (transferMarker) {
    navRouteLayer.addLayer(transferMarker);
  }
  navRouteLayer.addLayer(destinationMarker);
  navRouteLayer.addTo(map);

  const boundsPoints = [
    [origin.lat, origin.lon],
    [board.lat, board.lon],
    [destination.lat, destination.lon]
  ];
  if (best.transferCount > 0 && transfer) {
    boundsPoints.push([transfer.lat, transfer.lon]);
  }

  const bounds = L.latLngBounds(boundsPoints);
  map.fitBounds(bounds, { padding: [40, 40] });
}

// pickBestBusForDestination removed — was dead code, replaced by server-side planner (requestStaticPlan)

async function calculateRouteToSelectedStop() {
  if (routingBusy) {
    return;
  }

  const origin = getEffectiveOriginPosition();
  if (!origin) {
    setRouteSummary('Attiva la geolocalizzazione o inserisci una posizione manuale.');
    return;
  }

  if (!destinationPosition) {
    setRouteSummary('Imposta prima il punto di arrivo dalla mappa.');
    return;
  }

  const stopId = destinationStopSelect.value;
  const stopLocation = stopLocationById.get(stopId);
  if (!stopId || !stopLocation) {
    setRouteSummary('Seleziona una fermata valida con coordinate disponibili.');
    return;
  }

  routingBusy = true;
  clearRouteDebug();
  appendRouteDebug(
    `Avvio calcolo: origine (${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}), destinazione ${stopId} (${formatStopName(stopId)}).`
  );
  setRouteSummary('Ricerca bus migliore in corso...');

  try {
    const plan = await requestStaticPlan({
      origin,
      destinationStopId: stopId,
      destinationPoint: destinationPosition,
      maxWalkMeters: MAX_WALK_METERS_FALLBACK,
      destinationRadiusMeters: DESTINATION_ALTERNATIVE_RADIUS_METERS,
      maxLookAheadSeconds: MAX_FUTURE_LOOKAHEAD_SECONDS,
      allowTransfers: Boolean(allowTransfers?.checked),
      maxTransfers: allowTransfers?.checked ? 1 : 0
    });

    appendRouteDebug(
      `Planner statico: fermate vicine=${plan.nearbyOriginStopsCount}, alternative destinazione=${plan.destinationAlternativesCount}, opzioni=${plan.options?.length || 0}.`
    );

    const options = (plan.options || [])
      .map((item) => {
        const live = lastMergedEntities.find((entity) => entity.routeId === item.routeId && entity.tripId === item.tripId);
        return {
          ...item,
          vehicleId: live?.vehicleId || '',
          boardStopLocation: stopLocationById.get(item.boardStopId),
          transferStopLocation: item.transferStopId ? stopLocationById.get(item.transferStopId) : null,
          destinationStopLocation: stopLocationById.get(item.destinationStopId)
        };
      })
      .filter((item) => item.boardStopLocation && item.destinationStopLocation);

    if (!options.length) {
      clearNavigationLayer();
      routeSteps.innerHTML = '';
      renderRouteOptionCards([], null);
      currentRouteOptions = [];
      selectedRouteOptionKey = '';
      setRouteSummary('Nessun bus compatibile trovato ora per questa destinazione. Prova a cambiare fermata o riprovare tra poco.');
      return;
    }

    currentRouteOptions = options;
    const preservedSelection = selectedRouteOptionKey
      ? options.find((item) => getRouteOptionKey(item) === selectedRouteOptionKey)
      : null;
    const best = preservedSelection || options[0];
    selectedRouteOptionKey = getRouteOptionKey(best);

    await renderBusRouteOnMap(best);
    renderBusRouteSteps(best);
    renderRouteOptionCards(options, best);
    setRouteSummary(
      `Percorso migliore: ${best.transferCount > 0 ? `linee ${best.routeId}→${best.transferRouteId}` : `linea ${best.routeId}`} (${best.vehicleId || 'n/d'}) · Partenza ${formatClockFromEta(best.boardEtaSeconds)} · Arrivo ${formatClockFromEta(best.destinationEtaSeconds)} · Totale ${formatDurationSeconds(best.totalSeconds)} · Salita a ${best.boardStopName}`
    );
  } catch (error) {
    appendRouteDebug(`Errore globale calcolo percorso: ${error.message}`);
    setRouteSummary(`Errore percorso: ${error.message}`);
    routeSteps.innerHTML = '';
    renderRouteOptionCards([], null);
    currentRouteOptions = [];
    selectedRouteOptionKey = '';
  } finally {
    routingBusy = false;
  }
}

function onGeolocationUpdate(position) {
  userPosition = {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: position.coords.accuracy
  };

  if (activeOriginMode !== 'manual') {
    activeOriginMode = 'gps';
  }

  updateUserMarker();
  const accuracyText = userPosition.accuracy ? `±${Math.round(userPosition.accuracy)}m` : 'accuratezza n/d';
  if (activeOriginMode === 'gps') {
    setRouteSummary(`Posizione GPS aggiornata (${accuracyText}).`);
  }

  if (routeAutoRefresh.checked) {
    calculateRouteToSelectedStop();
  }
}

function onGeolocationError(error) {
  setRouteSummary(`Geolocalizzazione non disponibile: ${error.message}`);
}

function startUserLocationWatch() {
  if (!navigator.geolocation) {
    setRouteSummary('Geolocalizzazione non supportata dal browser.');
    return;
  }

  if (userWatchId != null) {
    navigator.geolocation.clearWatch(userWatchId);
  }

  userWatchId = navigator.geolocation.watchPosition(onGeolocationUpdate, onGeolocationError, {
    enableHighAccuracy: true,
    maximumAge: 10000,
    timeout: 15000
  });

  setRouteSummary('Ricerca posizione in corso...');
}

function renderTripDetailsPlaceholder(text) {
  tripDetailsSummary.textContent = text;
  upcomingStops.innerHTML = '';
  serviceCalendarText.textContent = '-';

  if (map && routeShapeLayer) {
    map.removeLayer(routeShapeLayer);
    routeShapeLayer = null;
  }
}

function formatDays(days) {
  const mapDay = {
    monday: 'Lun',
    tuesday: 'Mar',
    wednesday: 'Mer',
    thursday: 'Gio',
    friday: 'Ven',
    saturday: 'Sab',
    sunday: 'Dom'
  };

  return Object.keys(mapDay)
    .filter((key) => days?.[key])
    .map((key) => mapDay[key])
    .join(', ');
}

function formatCalendarSummary(serviceSummary) {
  if (!serviceSummary?.serviceId) {
    return 'Service non disponibile';
  }

  const base = serviceSummary.baseCalendar;
  if (!base) {
    return `Service ${serviceSummary.serviceId} (nessun calendario base trovato)`;
  }

  const days = formatDays(base.days) || 'nessun giorno';
  const active = serviceSummary.activeOnDate;
  const activeText = active == null ? 'stato data non disponibile' : active ? 'attiva oggi' : 'non attiva oggi';
  return `Service ${serviceSummary.serviceId}: ${days}. Validità ${base.startDate} - ${base.endDate} (${activeText}).`;
}

function renderTripDetails(data) {
  const route = data.routeId || 'n/d';
  const trip = data.tripId || 'n/d';
  const total = data.totalStops || 0;
  tripDetailsSummary.textContent = `Linea ${route} · Trip ${trip} · Fermate totali: ${total}`;

  if (Array.isArray(data.upcomingStops) && data.upcomingStops.length) {
    upcomingStops.innerHTML = data.upcomingStops
      .map((item) => `<li>${item.stopSequence}. ${item.stopName} — prev. ${item.arrivalTime} · stimato ${item.predictedArrivalTime}</li>`)
      .join('');
  } else {
    upcomingStops.innerHTML = '<li>Nessuna fermata in arrivo disponibile</li>';
  }

  serviceCalendarText.textContent = formatCalendarSummary(data.serviceSummary);

  if (Array.isArray(data.upcomingStops) && data.upcomingStops.length) {
    const candidateStopId = data.upcomingStops[0].stopId;
    if (!destinationPosition && candidateStopId && stopLocationById.has(candidateStopId)) {
      destinationStopSelect.value = candidateStopId;
    }
  }

  if (map && routeShapeLayer) {
    map.removeLayer(routeShapeLayer);
    routeShapeLayer = null;
  }

  if (map && Array.isArray(data.shapePoints) && data.shapePoints.length > 1) {
    routeShapeLayer = L.polyline(data.shapePoints, {
      color: '#0b63ce',
      weight: 4,
      opacity: 0.65
    }).addTo(map);
  }
}

async function loadTripDetails(context) {
  if (!context?.tripId) {
    renderTripDetailsPlaceholder('Trip non disponibile per questo mezzo');
    return;
  }

  const params = new URLSearchParams({
    routeId: context.routeId || '',
    tripId: context.tripId || '',
    currentStopId: context.currentStopId || '',
    delay: String(context.delay || 0)
  });

  const response = await fetch(apiUrl(`api/tripdetails?${params.toString()}`), {
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`TripDetails HTTP ${response.status}`);
  }

  const details = await response.json();
  renderTripDetails(details);
}

async function handleMarkerSelection(item) {
  try {
    selectedTripContext = {
      routeId: item.routeId || '',
      tripId: item.tripId || '',
      currentStopId: item.stopId || '',
      delay: Number.isNaN(item.delay) ? 0 : item.delay
    };

    await loadTripDetails(selectedTripContext);
  } catch (error) {
    renderTripDetailsPlaceholder(`Dettagli corsa non disponibili: ${error.message}`);
  }
}

function updateMap(entities) {
  initMap();
  if (!map) {
    return;
  }

  const activeKeys = new Set();
  const pointsForBounds = [];

  for (const item of entities) {
    if (!isRouteIdReliable(item)) {
      continue;
    }

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
      marker.on('click', () => {
        handleMarkerSelection(item);
      });
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
    existing.marker.off('click');
    existing.marker.on('click', () => {
      handleMarkerSelection(item);
    });
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
      const stopId = getChildText(entity, 'Vehicle > StopId');

      return {
        routeId,
        positionKey,
        tripKey: makeTripKey(routeId, tripId),
        tripId,
        vehicleId,
        stopId,
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

function isRouteIdReliable(entity) {
  return (
    entity.routeId &&
    typeof entity.routeId === 'string' &&
    entity.routeId.trim().length > 0 &&
    entity.routeId !== '0'
  );
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
  let mergeExact = 0;
  let mergeTripOnly = 0;
  let mergeNoPosition = 0;
  let mergeRouteDisagree = 0;
  let excludedNoRoute = 0;

  for (const trip of trips) {
    let position = positionsByKey.get(trip.tripKey);

    if (!position && trip.tripId) {
      const candidate = positionsByTripIdOnly.get(trip.tripId);
      if (candidate) {
        if (!candidate.routeId || candidate.routeId === trip.routeId) {
          position = candidate;
          mergeTripOnly += 1;
        } else {
          position = candidate;
          mergeRouteDisagree += 1;
        }
      }
    }

    if (position) {
      if (!positionsByKey.has(trip.tripKey)) {
        /* tripId-only match already counted above */
      } else {
        mergeExact += 1;
      }
      usedPositionKeys.add(position.positionKey);
    } else {
      mergeNoPosition += 1;
    }

    // TripUpdates always provides a routeId — trust it as source of truth
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

  // Orphan VehiclePositions (no matching TripUpdate) are NEVER rendered.
  // They lack a reliable routeId and are the primary source of route swaps.
  let orphanTotal = 0;
  for (const [positionKey] of positionsByKey.entries()) {
    if (!usedPositionKeys.has(positionKey)) {
      orphanTotal += 1;
    }
  }

  const accepted = merged.length;
  console.log(
    `[MERGE] ${accepted} veicoli con routeId certa, ${excludedNoRoute} esclusi (no routeId), ${orphanTotal} posizioni orfane scartate | exact=${mergeExact}, tripOnly=${mergeTripOnly}, routeDisagree=${mergeRouteDisagree}, noPosition=${mergeNoPosition}`
  );

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
        <td>${formatStopName(item.stopId)}</td>
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
      fetch(apiRootUrl('api/tripupdates'), { cache: 'no-store' }),
      fetch(apiRootUrl('api/vehicleposition'), { cache: 'no-store' })
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

    let stopsJson = { stops: {}, stopLocations: {} };
    if (!stopsApiDisabled) {
      const stopCandidates = stopsEndpointCache
        ? [stopsEndpointCache]
        : buildApiCandidates('api/stops');

      let lastStopsError = null;
      for (const stopEndpoint of stopCandidates) {
        try {
          const stopsResponse = await fetch(stopEndpoint, { cache: 'no-store' });
          if (!stopsResponse.ok) {
            throw new Error(`Stops HTTP ${stopsResponse.status}`);
          }

          stopsJson = await readJsonResponse(stopsResponse, 'Stops API');
          stopsEndpointCache = stopEndpoint;
          lastStopsError = null;
          break;
        } catch (error) {
          lastStopsError = error;
        }
      }

      if (lastStopsError) {
        stopsApiDisabled = true;
        appendRouteDebug(`Stops non disponibili: ${lastStopsError.message}`);
      }
    }

    stopNameById = new Map(Object.entries(stopsJson?.stops || {}));
    stopLocationById = new Map(
      Object.entries(stopsJson?.stopLocations || {}).map(([key, value]) => [key, { lat: Number(value.lat), lon: Number(value.lon) }])
    );

    const { entities: tripEntities, feedTs } = parseTripUpdates(tripUpdatesXml);
    const positionsByKey = parseVehiclePositions(vehiclePositionXml);
    lastMergedEntities = mergeTripAndPosition(tripEntities, positionsByKey);
    lastFeedTimestamp = feedTs;

    const routeIds = [...new Set(lastMergedEntities.map((item) => item.routeId).filter(Boolean))];
    console.log(`[FEED] parsed ${tripEntities.length} tripUpdates, ${positionsByKey.size} vehiclePositions, merged ${lastMergedEntities.length} entities, routeIds: [${routeIds.sort(compareRouteIds).join(', ')}]`);

    const suspiciousPairs = [['20', '30'], ['20', '120'], ['06', '60']];
    for (const entity of lastMergedEntities) {
      if (entity.confirmedRouteId && entity.routeId !== entity.confirmedRouteId) {
        console.error(`[SWAP DETECTED] vehicleId=${entity.vehicleId} displayed=${entity.routeId} confirmed=${entity.confirmedRouteId}`);
      }

      for (const [a, b] of suspiciousPairs) {
        if (entity.routeId === a) {
          const sameVehicleOther = lastMergedEntities.find(
            (other) => other !== entity && other.vehicleId === entity.vehicleId && other.routeId === b
          );

          if (sameVehicleOther) {
            console.warn(`[SWAP RISK] vehicleId=${entity.vehicleId} appears as both route ${a} and ${b}`);
          }
        }
      }
    }

    const availableRouteIds = getAvailableRouteIds(lastMergedEntities);
    ensureSelectedRoute(availableRouteIds);
    renderRouteSelector(availableRouteIds);
    renderSelectedRouteView();
    refreshDestinationOptions();

    if (selectedTripContext?.tripId) {
      const refreshed = lastMergedEntities.find(
        (item) => item.tripId === selectedTripContext.tripId && item.routeId === selectedTripContext.routeId
      );

      if (refreshed) {
        selectedTripContext = {
          routeId: refreshed.routeId || '',
          tripId: refreshed.tripId || '',
          currentStopId: refreshed.stopId || '',
          delay: Number.isNaN(refreshed.delay) ? 0 : refreshed.delay
        };

        try {
          await loadTripDetails(selectedTripContext);
        } catch (error) {
          renderTripDetailsPlaceholder(`Dettagli corsa non disponibili: ${error.message}`);
        }
      } else {
        renderTripDetailsPlaceholder('La corsa selezionata non è più presente nel feed live');
      }
    }

    // Feed staleness check
    if (feedTs) {
      const feedAgeSeconds = Math.floor(Date.now() / 1000 - feedTs);
      if (feedAgeSeconds > 120) {
        const mins = Math.floor(feedAgeSeconds / 60);
        showFeedBanner(`⚠️ Feed GTFS-RT non aggiornato da ${mins} minuti — i dati potrebbero non essere attendibili.`, 'warn');
      } else if (feedConsecutiveFailures > 0) {
        showFeedBanner('✅ Connessione al feed ripristinata.', 'ok');
        setTimeout(hideFeedBanner, 5000);
      } else {
        hideFeedBanner();
      }
    } else {
      hideFeedBanner();
    }
    feedConsecutiveFailures = 0;

    message.textContent = `Dati aggiornati alle ${new Date().toLocaleTimeString('it-IT')}`;
  } catch (error) {
    feedConsecutiveFailures++;
    const level = feedConsecutiveFailures >= 3 ? 'error' : 'warn';
    const label = feedConsecutiveFailures >= 3
      ? `🔴 Feed non disponibile (${feedConsecutiveFailures} tentativi falliti): ${error.message}`
      : `⚠️ Errore temporaneo feed: ${error.message}`;
    showFeedBanner(label, level);

    message.textContent = `Errore durante il recupero feed: ${error.message}`;
    tableBody.innerHTML = '<tr><td colspan="7" class="placeholder">Impossibile leggere il feed in questo momento</td></tr>';
    lineSelect.innerHTML = '<option value="">Errore feed</option>';
    lineSelect.disabled = true;
    mapTitle.textContent = 'Mappa live';
    vehiclesCount.textContent = '-';
    avgDelay.textContent = '-';
    feedTimestamp.textContent = '-';
    renderTripDetailsPlaceholder('Impossibile caricare i dettagli corsa in questo momento');
    destinationStopSelect.innerHTML = '<option value="">Fermate non disponibili</option>';
    destinationStopSelect.disabled = true;
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

toggleSemafori?.addEventListener('change', async () => {
  if (toggleSemafori.checked) {
    await enableSemaforiLayer();
    return;
  }

  disableSemaforiLayer();
});

locateBtn.addEventListener('click', () => {
  activeOriginMode = 'gps';
  mapPickMode = null;
  startUserLocationWatch();
});

pickFromMapBtn.addEventListener('click', () => {
  initMap();
  mapPickMode = 'origin';
  setRouteSummary('Clicca un punto sulla mappa per impostare la posizione di partenza.');
});

pickDestinationFromMapBtn.addEventListener('click', () => {
  initMap();
  mapPickMode = 'destination';
  setRouteSummary('Clicca un punto sulla mappa per impostare il punto di arrivo.');
});

routeNowBtn.addEventListener('click', () => {
  calculateRouteToSelectedStop();
});

routeDebugToggle.addEventListener('change', () => {
  routeDebugEnabled = routeDebugToggle.checked;
  renderRouteDebug();
});

routeOptionsList.addEventListener('click', async (event) => {
  if (event.target.closest('.route-option-more > summary')) {
    return;
  }

  const card = event.target.closest('.route-option-card[data-route-key]');
  if (!card) {
    return;
  }

  const key = card.getAttribute('data-route-key') || '';
  if (!key || !currentRouteOptions.length) {
    return;
  }

  const selected = currentRouteOptions.find((item) => getRouteOptionKey(item) === key);
  if (!selected) {
    return;
  }

  selectedRouteOptionKey = key;
  await renderBusRouteOnMap(selected);
  renderBusRouteSteps(selected);
  renderRouteOptionCards(currentRouteOptions, selected);
  setRouteSummary(
    `Percorso selezionato: ${selected.transferCount > 0 ? `linee ${selected.routeId}→${selected.transferRouteId}` : `linea ${selected.routeId}`} · Partenza ${formatClockFromEta(selected.boardEtaSeconds)} · Arrivo ${formatClockFromEta(selected.destinationEtaSeconds)} · Totale ${formatDurationSeconds(selected.totalSeconds)}.`
  );
});

destinationStopSelect.addEventListener('change', () => {
  const selected = destinationStopSelect.value;
  const location = stopLocationById.get(selected);
  if (location) {
    destinationPosition = { lat: location.lat, lon: location.lon };
    syncDestinationFromMapPoint();
  }

  if (routeAutoRefresh.checked) {
    calculateRouteToSelectedStop();
  }
});

renderTripDetailsPlaceholder('Clicca su un bus nella mappa per vedere percorso completo, shape e calendario corsa');
setRouteSummary('Posizione non rilevata. Usa GPS o scegli un punto dalla mappa.');
syncDestinationFromMapPoint();
renderRouteDebug();
updateSemaforiZoomHint();

loadData();
startAutoRefresh();
