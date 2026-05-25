import { requestStaticPlan } from './planner.js';

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

// DOM refs: removed elements get null-safe fallback
const message = document.querySelector('#message');
const lineSelect = document.querySelector('#lineSelect');
const destinationStopSelect = document.querySelector('#destinationStopSelect');
const locateBtn = document.querySelector('#locateBtn');
const routeNowBtn = document.querySelector('#routeNowBtn');
const allowTransfers = document.querySelector('#allowTransfers');
const routeAutoRefresh = document.querySelector('#routeAutoRefresh');
const mapDestinationText = document.querySelector('#mapDestinationText');
const originSearchInput = document.querySelector('#originSearchInput');
const destinationSearchInput = document.querySelector('#destinationSearchInput');
const originSearchResults = document.querySelector('#originSearchResults');
const destinationSearchResults = document.querySelector('#destinationSearchResults');

const feedBanner = document.querySelector('#feedBanner');
const feedBannerText = document.querySelector('#feedBannerText');
const feedBannerDismiss = document.querySelector('#feedBannerDismiss');

// New UI elements
const searchCard = document.querySelector('#searchCard');
const editRouteBtn = document.querySelector('#editRouteBtn');
const searchCardCollapseBtn = document.querySelector('#searchCardCollapseBtn');
const swapBtn = document.querySelector('#swapBtn');
const routeSummaryWrap = document.querySelector('#routeSummaryWrap');
const sheetHandle = document.querySelector('#sheetHandle');
const lineFilterSelect = document.querySelector('#lineFilterSelect');
const basemapToggleBtn = document.querySelector('#basemapToggleBtn');
const trafficLightsToggleBtn = document.querySelector('#trafficLightsToggleBtn');
const simulatedToggleBtn = document.querySelector('#simulatedToggleBtn');
const streetViewToggleBtn = document.querySelector('#streetViewToggleBtn');
const startupAlertModal = document.querySelector('#startupAlertModal');
const startupAlertCloseBtn = document.querySelector('#startupAlertCloseBtn');
const nextJourneyTimes = document.querySelector('#nextJourneyTimes');
const streetViewPanel = document.querySelector('#streetViewPanel');
const streetViewMap = document.querySelector('#streetViewMap');
const streetViewCloseBtn = document.querySelector('#streetViewCloseBtn');
const streetViewStatus = document.querySelector('#streetViewStatus');
const busActionCard = document.querySelector('#busActionCard');
const busActionTitle = document.querySelector('#busActionTitle');
const busActionSubtitle = document.querySelector('#busActionSubtitle');
const busActionMeta = document.querySelector('#busActionMeta');
const busTrackBtn = document.querySelector('#busTrackBtn');
const busCenterBtn = document.querySelector('#busCenterBtn');
const busActionCloseBtn = document.querySelector('#busActionCloseBtn');
const recentDestinations = document.querySelector('#recentDestinations');
const recentDestinationsList = document.querySelector('#recentDestinationsList');
const clearRecentDestinationsBtn = document.querySelector('#clearRecentDestinations');

let feedConsecutiveFailures = 0;
let feedBannerDismissedAt = 0;
const routeSummaryText = document.querySelector('#routeSummaryText');
const routeOptionsList = document.querySelector('#routeOptionsList');

// Removed elements - null-safe stubs for code that still references them
const tableBody = null;
const toggleSemafori = null;
const semaforiZoomHint = null;
const routeDebugToggle = null;
const routeDebugOutput = null;
const routeSteps = null;
const mapTitle = null;
const vehiclesCount = null;
const avgDelay = null;
const feedTimestamp = null;
const tripDetailsSummary = null;
const upcomingStops = null;
const serviceCalendarText = null;

const REFRESH_MS = 15000;
const MAP_DEFAULT_CENTER = [41.1171, 16.8719];
const MAP_DEFAULT_ZOOM = 13;
const WALK_SPEED_MPS = 1.35;
const MAX_WALK_METERS = 500;
const MAX_WALK_METERS_FALLBACK = 500;
const BOARDING_BUFFER_SECONDS = 45;
const MAX_FUTURE_LOOKAHEAD_SECONDS = 90 * 60;
const DESTINATION_ALTERNATIVE_RADIUS_METERS = 900;
const WALKING_ROUTE_BASE_URL = 'https://router.project-osrm.org/route/v1/foot';
const WALKING_ROUTE_TIMEOUT_MS = 4500;
const WALKING_ROUTE_CACHE_MS = 5 * 60 * 1000;
const WALKING_ROUTE_MAX_REQUESTS_PER_PLAN = 18;
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse';
const NOMINATIM_RESULT_LIMIT = 5;
const STARTUP_ALERT_SESSION_KEY = 'muvt_startup_alert_seen_session';
const STARTUP_ALERT_SEEN_KEY = 'muvt_startup_alert_seen';
const TRAFFIC_LIGHTS_TOGGLE_KEY = 'muvt_traffic_lights_enabled';
const SIMULATED_TOGGLE_KEY = 'muvt_simulated_enabled';
const RECENT_DESTINATIONS_KEY = 'muvt_recent_destinations';
const RECENT_DESTINATIONS_LIMIT = 6;
const SEARCH_MIN_QUERY_LENGTH = 3;
const SEARCH_DEBOUNCE_MS = 350;
const DIRECT_ONLY_WALK_CAP_METERS = 1500;
const SECONDARY_MIN_WALK_GAIN_METERS = 250;
const SECONDARY_MAX_EXTRA_SECONDS = 20 * 60;
const SEMAFORI_MIN_ZOOM = 13;
const SIMULATION_MAX_AGE_MS = 20 * 60 * 1000;
const SIMULATION_DWELL_SECONDS = 60;
const SIMULATION_SPEED_MPS = 4.5;
const SIMULATION_MAX_OFFSET_METERS = 1200;
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
let searchOriginPosition = null;
let activeOriginMode = 'gps';
let userMarker = null;
let userWatchId = null;
let navRouteLayer = null;
let routingBusy = false;
let mapPickMode = null;
let routeDebugEnabled = true;
let destinationPosition = null;
let destinationSource = 'map';
let destinationMarker = null;
let currentRouteOptions = [];
let currentSecondaryRouteOptions = [];
let selectedRouteOptionKey = '';
let stopsEndpointCache = '';
let stopsApiDisabled = false;
let semaforiLayer = null;
let semaforiLoaded = false;
let semaforiData = [];
let semaforiEnabled = true;
let simulatedEnabled = true;
let lastSimulatedCount = 0;
const tripDetailsCache = new Map();
const routeDebugLines = [];
const walkingRouteCache = new Map();
const geocodeResultCache = new Map();
const geocodeDebounceTimers = new Map();
const geocodeAbortControllers = new Map();
let walkingRouteRequestBudget = WALKING_ROUTE_MAX_REQUESTS_PER_PLAN;
const simulatedTripStateByKey = new Map();
const lastLivePositionByTripKey = new Map();
let selectedLineFilter = 'all';
let darkTileLayer = null;
let satelliteTileLayer = null;
let activeBaseLayer = null;
let isSatelliteMode = false;
let suppressNextMapClick = false;
let reverseGeocodeAbortController = null;
let selectedBusSnapshot = null;
let trackedBusKey = '';
let followBusMode = false;
let trackedBusMissingCount = 0;
let streetViewOpen = false;
let streetViewPanorama = null;
let streetViewService = null;
let streetViewLoadPromise = null;
const streetViewLastByKey = new Map();

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

function createBusIcon(routeId, options = {}) {
  if (typeof L === 'undefined') {
    return null;
  }

  const simulated = options.simulated === true;

  return L.divIcon({
    className: simulated ? 'bus-marker bus-marker--simulated' : 'bus-marker',
    html: `<span class="bus-marker__badge">${routeId || '?'}${simulated ? ' SIM' : ''}</span>`,
    iconSize: simulated ? [78, 28] : [56, 26],
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

function computeBearingDegrees(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const toDeg = (value) => (value * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return Number.isNaN(bearing) ? 0 : bearing;
}

function updateStreetViewStatus(text) {
  if (!streetViewStatus) {
    return;
  }

  if (!text) {
    streetViewStatus.textContent = '';
    streetViewStatus.hidden = true;
    return;
  }

  streetViewStatus.textContent = text;
  streetViewStatus.hidden = false;
}

async function loadGoogleMapsApi() {
  if (window.google?.maps?.StreetViewPanorama) {
    return;
  }

  if (streetViewLoadPromise) {
    return streetViewLoadPromise;
  }

  streetViewLoadPromise = (async () => {
    const response = await fetch(apiRootUrl('api/maps-key'), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Chiave Google Maps non disponibile');
    }

    const payload = await response.json();
    const apiKey = String(payload?.key || '').trim();
    if (!apiKey) {
      throw new Error('Chiave Google Maps mancante');
    }

    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Caricamento Google Maps fallito'));
      document.head.appendChild(script);
    });
  })();

  return streetViewLoadPromise;
}

async function ensureStreetViewReady() {
  if (!streetViewMap) {
    return;
  }

  await loadGoogleMapsApi();

  if (!streetViewPanorama && window.google?.maps) {
    streetViewPanorama = new window.google.maps.StreetViewPanorama(streetViewMap, {
      addressControl: false,
      linksControl: true,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      showRoadLabels: true,
      disableDefaultUI: true
    });
    streetViewService = new window.google.maps.StreetViewService();
  }
}

function getStreetViewTargetEntity() {
  const key = trackedBusKey || selectedBusSnapshot?.key || '';
  if (!key) {
    return null;
  }

  const live = lastMergedEntities.find((item) => getEntityKey(item) === key);
  if (live) {
    return live;
  }

  if (selectedBusSnapshot && selectedBusSnapshot.key === key) {
    return {
      ...selectedBusSnapshot,
      tripKey: selectedBusSnapshot.key
    };
  }

  return null;
}

function updateStreetViewForEntity(entity) {
  if (!streetViewOpen || !entity || !streetViewPanorama || !streetViewService) {
    return;
  }

  const lat = Number(entity.lat);
  const lon = Number(entity.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    updateStreetViewStatus('Posizione bus non disponibile.');
    return;
  }

  const key = getEntityKey(entity) || 'bus';
  const previous = streetViewLastByKey.get(key);
  const heading = previous
    ? computeBearingDegrees(previous.lat, previous.lon, lat, lon)
    : 0;
  streetViewLastByKey.set(key, { lat, lon });

  const location = { lat, lng: lon };
  streetViewService.getPanorama({ location, radius: 60 }, (data, status) => {
    if (!streetViewOpen || !streetViewPanorama) {
      return;
    }

    if (status === 'OK' && data?.location?.pano) {
      streetViewPanorama.setPano(data.location.pano);
      streetViewPanorama.setPov({ heading, pitch: 0 });
      updateStreetViewStatus('');
      return;
    }

    streetViewPanorama.setPosition(location);
    streetViewPanorama.setPov({ heading, pitch: 0 });
    updateStreetViewStatus('Street View non disponibile in zona.');
  });
}

async function openStreetViewPanel() {
  if (!streetViewPanel) {
    return;
  }

  streetViewOpen = true;
  streetViewPanel.hidden = false;
  updateStreetViewStatus('Caricamento Street View...');

  try {
    await ensureStreetViewReady();
  } catch (error) {
    updateStreetViewStatus(error.message || 'Errore Street View');
    return;
  }

  const target = getStreetViewTargetEntity();
  if (!target) {
    updateStreetViewStatus('Seleziona un bus da tracciare.');
    return;
  }

  updateStreetViewForEntity(target);
}

function closeStreetViewPanel() {
  streetViewOpen = false;
  if (streetViewPanel) {
    streetViewPanel.hidden = true;
  }
  updateStreetViewStatus('');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSimulationKey(item) {
  if (item.tripKey) {
    return item.tripKey;
  }

  if (item.routeId && item.tripId) {
    return `${item.routeId}__${item.tripId}`;
  }

  if (item.routeId && item.stopId && item.arrivalTime) {
    return `${item.routeId}__${item.stopId}__${item.arrivalTime}`;
  }

  return '';
}

function hashString(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function hasValidCoordinates(item) {
  return item.lat != null && item.lon != null && !Number.isNaN(item.lat) && !Number.isNaN(item.lon);
}

function applyScheduledSimulation(entities) {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  let simulatedCount = 0;
  let switchedToLiveCount = 0;
  const activeKeys = new Set();

  for (const item of entities) {
    const key = getSimulationKey(item);
    if (!key) {
      continue;
    }

    activeKeys.add(key);
    if (!hasValidCoordinates(item)) {
      continue;
    }

    lastLivePositionByTripKey.set(key, {
      lat: item.lat,
      lon: item.lon,
      updatedAt: nowMs
    });

    if (simulatedTripStateByKey.has(key)) {
      simulatedTripStateByKey.delete(key);
      switchedToLiveCount += 1;
    }
  }

  const output = entities.map((item) => {
    if (hasValidCoordinates(item)) {
      return {
        ...item,
        isSimulated: false,
        simulationReason: ''
      };
    }

    if (!isRouteIdReliable(item)) {
      return {
        ...item,
        isSimulated: false,
        simulationReason: ''
      };
    }

    const scheduledTs = Number(item.arrivalTime);
    if (!scheduledTs || Number.isNaN(scheduledTs) || nowSeconds < scheduledTs) {
      return {
        ...item,
        isSimulated: false,
        simulationReason: ''
      };
    }

    const key = getSimulationKey(item);
    if (!key) {
      return {
        ...item,
        isSimulated: false,
        simulationReason: ''
      };
    }

    const stopLocation = stopLocationById.get(item.stopId);
    const lastLive = lastLivePositionByTripKey.get(key);
    const baseLat = stopLocation?.lat ?? lastLive?.lat;
    const baseLon = stopLocation?.lon ?? lastLive?.lon;
    if (baseLat == null || baseLon == null || Number.isNaN(baseLat) || Number.isNaN(baseLon)) {
      return {
        ...item,
        isSimulated: false,
        simulationReason: ''
      };
    }

    let state = simulatedTripStateByKey.get(key);
    if (!state) {
      const seedHash = hashString(`${item.routeId || ''}__${item.tripId || ''}__${item.stopId || ''}`);
      state = {
        startedAt: nowMs,
        bearingDeg: seedHash % 360,
        baseLat,
        baseLon,
        lastSeenAt: nowMs
      };
      simulatedTripStateByKey.set(key, state);
    } else {
      state.lastSeenAt = nowMs;
      if (stopLocation) {
        state.baseLat = stopLocation.lat;
        state.baseLon = stopLocation.lon;
      }
    }

    const elapsedSeconds = Math.max(0, Math.floor((nowMs - state.startedAt) / 1000));
    const movingSeconds = Math.max(0, elapsedSeconds - SIMULATION_DWELL_SECONDS);
    const simulatedDistance = Math.min(SIMULATION_MAX_OFFSET_METERS, movingSeconds * SIMULATION_SPEED_MPS);
    const simulatedPoint = offsetLatLonMeters(state.baseLat, state.baseLon, simulatedDistance, state.bearingDeg);

    simulatedCount += 1;

    return {
      ...item,
      vehicleId: item.vehicleId || `SIM-${item.routeId || 'X'}-${item.tripId || 'trip'}`,
      lat: simulatedPoint.lat,
      lon: simulatedPoint.lon,
      speed: movingSeconds > 0 ? SIMULATION_SPEED_MPS : 0,
      currentStatus: 'SimulatedNoSignal',
      positionTimestamp: nowSeconds,
      isSimulated: true,
      simulationReason: 'Segnale assente: posizione stimata da orario previsto e fermata corrente.'
    };
  });

  for (const [key, state] of simulatedTripStateByKey.entries()) {
    if (!activeKeys.has(key) || nowMs - state.lastSeenAt > SIMULATION_MAX_AGE_MS) {
      simulatedTripStateByKey.delete(key);
    }
  }

  for (const [key, state] of lastLivePositionByTripKey.entries()) {
    if (nowMs - state.updatedAt > SIMULATION_MAX_AGE_MS) {
      lastLivePositionByTripKey.delete(key);
    }
  }

  return {
    entities: output,
    simulatedCount,
    switchedToLiveCount
  };
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

function getEntityKey(entity) {
  if (!entity) {
    return '';
  }

  return entity.vehicleId || entity.tripKey || entity.tripId || '';
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
    zoomControl: false
  });

  darkTileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
  });

  satelliteTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  });

  applyBasemapMode();

  if (!map.getPane('semaforiPane')) {
    const pane = map.createPane('semaforiPane');
    pane.style.zIndex = '620';
  }

  map.on('zoomend', () => {
    applySemaforiVisibility();
  });

  map.on('dragstart', () => {
    if (followBusMode) {
      followBusMode = false;
      updateBusActionCard();
    }
  });

  map.on('click', (event) => {
    if (suppressNextMapClick) {
      suppressNextMapClick = false;
      return;
    }

    if (!mapPickMode) {
      if (!isMapInteractiveTarget(event)) {
        resetActiveMapSelection();
      }
      return;
    }

    if (mapPickMode === 'origin') {
      manualPosition = {
        lat: event.latlng.lat,
        lon: event.latlng.lng,
        accuracy: null
      };
      searchOriginPosition = null;
      activeOriginMode = 'manual';
      mapPickMode = null;
      if (originSearchInput) {
        originSearchInput.value = '';
      }
      hideSearchResults('origin');
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
      setDestinationFromMapPoint(event.latlng.lat, event.latlng.lng);
    }
  });

  map.on('contextmenu', (event) => {
    setDestinationFromMapPoint(event.latlng.lat, event.latlng.lng);
  });

  applySemaforiVisibility();
}

function createSemaforoIcon() {
  return L.divIcon({
    className: 'semaforo-icon semaforo-lampeggiante',
    html: `
      <svg class="semaforo-svg" viewBox="0 0 16 32" aria-hidden="true">
        <rect x="2" y="1" width="12" height="30" rx="3" fill="#1f2937" stroke="#111827" stroke-width="1"/>
        <rect x="4" y="4.6" width="8" height="1.4" rx="0.8" fill="#0b0f16"/>
        <rect x="4" y="13.6" width="8" height="1.4" rx="0.8" fill="#0b0f16"/>
        <rect x="4" y="22.6" width="8" height="1.4" rx="0.8" fill="#0b0f16"/>
        <circle class="semaforo-luce luce-rosso" cx="8" cy="8" r="2.8" fill="#ef4444" style="color:#ef4444" />
        <circle class="semaforo-luce luce-giallo attiva" cx="8" cy="16" r="2.8" fill="#eab308" style="color:#eab308" />
        <circle class="semaforo-luce luce-verde" cx="8" cy="24" r="2.8" fill="#22c55e" style="color:#22c55e" />
      </svg>
    `,
    iconSize: [16, 32],
    iconAnchor: [8, 16]
  });
}

function renderSemaforoPopup(item) {
  return [
    `<b>Semaforo #${item.id}</b>`,
    '⚠️ Segnalazione semaforo',
    `📍 ${item.indirizzo || 'n/d'}`,
    `🏛️ ${item.municipio || 'n/d'}`
  ].join('<br>');
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

function renderSemaforoPopupWithArm(item, armIndex, armTotal) {
  const suffix = armTotal > 1 ? `<br>🚦 Braccio ${armIndex}/${armTotal}` : '';
  const source = item.approachCountSource ? `<br>Conteggio: ${item.approachCountSource}` : '';
  return `${renderSemaforoPopup(item)}${suffix}${source}`;
}

function semaforiShouldBeVisible() {
  return Boolean(map) && semaforiEnabled && map.getZoom() >= SEMAFORI_MIN_ZOOM;
}

function updateSemaforiZoomHint() {
  if (!semaforiZoomHint) {
    return;
  }

  if (!map || map.getZoom() < SEMAFORI_MIN_ZOOM) {
    semaforiZoomHint.textContent = 'Zoom in per vedere i semafori.';
    return;
  }

  semaforiZoomHint.textContent = '';
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

  for (const item of semaforiData) {
    const armPoints = getSemaforoArmPoints(item);

    armPoints.forEach((armPoint) => {
      const marker = L.marker([armPoint.lat, armPoint.lon], {
        icon: createSemaforoIcon(),
        pane: 'semaforiPane'
      });

      marker.bindPopup(renderSemaforoPopupWithArm(item, armPoint.armIndex, armPoint.armTotal));
      semaforiLayer.addLayer(marker);
    });
  }
}

async function enableSemaforiLayer() {
  initMap();
  if (!semaforiEnabled) {
    disableSemaforiLayer();
    return;
  }

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

  if (semaforiShouldBeVisible() && semaforiLayer) {
    semaforiLayer.addTo(map);
  } else if (semaforiLayer && map.hasLayer(semaforiLayer)) {
    map.removeLayer(semaforiLayer);
  }

  updateSemaforiZoomHint();
}

function disableSemaforiLayer() {
  if (map && semaforiLayer && map.hasLayer(semaforiLayer)) {
    map.removeLayer(semaforiLayer);
  }
  updateSemaforiZoomHint();
}

function applySemaforiVisibility() {
  updateSemaforiZoomHint();
  if (!map) {
    return;
  }

  if (!semaforiEnabled) {
    disableSemaforiLayer();
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
    mapDestinationText.textContent = 'Arrivo non impostato. Usa mappa o ricerca indirizzo.';
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

  const sourceLabel = destinationSource === 'search' ? 'Arrivo ricerca' : 'Arrivo mappa';
  mapDestinationText.textContent = `${sourceLabel} (${destinationPosition.lat.toFixed(5)}, ${destinationPosition.lon.toFixed(5)}) - fermata piu vicina: ${formatStopName(nearest.stopId)} (${Math.round(nearest.distanceMeters)} m).`;
}

function buildPopup(item) {
  const routeLabel = item.routeId || '?';
  const stopName = formatStopName(item.stopId);
  const destText = stopName && stopName !== 'n/d' && stopName !== 'Fermata non disponibile'
    ? stopName
    : '';

  let html = `<div class="popup-route">Bus ${routeLabel}</div>`;
  if (destText) {
    html += `<div class="popup-dest">-> ${destText}</div>`;
  }

  if (item.isSimulated) {
    html += '<div class="popup-stale">Posizione stimata</div>';
  }

  return html;
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

function buildGeocodeCacheKey(rawQuery) {
  return rawQuery.trim().toLocaleLowerCase('it-IT');
}

function formatGeocodeResultLabel(item) {
  const text = String(item?.display_name || '').trim();
  if (!text) {
    return 'Indirizzo non disponibile';
  }

  return text;
}

function hideSearchResults(target) {
  const box = target === 'origin' ? originSearchResults : destinationSearchResults;
  if (!box) {
    return;
  }

  box.hidden = true;
  box.innerHTML = '';
  delete box.dataset.items;
}

function renderSearchResults(target, items) {
  const box = target === 'origin' ? originSearchResults : destinationSearchResults;
  if (!box) {
    return;
  }

  if (!items.length) {
    box.hidden = false;
    box.innerHTML = '<div class="geocode-empty">Nessun risultato</div>';
    return;
  }

  box.hidden = false;
  box.innerHTML = items
    .map((item, index) => {
      const label = formatGeocodeResultLabel(item);
      return `<button type="button" class="geocode-result-item" data-target="${target}" data-index="${index}">${label}</button>`;
    })
    .join('');
  box.dataset.items = JSON.stringify(items);
}

function readRenderedSearchItems(target) {
  const box = target === 'origin' ? originSearchResults : destinationSearchResults;
  if (!box) {
    return [];
  }

  try {
    const raw = box.dataset.items || '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchNominatimSuggestions(rawQuery, signal) {
  const query = rawQuery.trim();
  if (query.length < SEARCH_MIN_QUERY_LENGTH) {
    return [];
  }

  const cacheKey = buildGeocodeCacheKey(query);
  const now = Date.now();
  const cached = geocodeResultCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.items;
  }

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    limit: String(NOMINATIM_RESULT_LIMIT),
    dedupe: '1',
    viewbox: '16.76,41.15,16.95,41.05',
    bounded: '0',
    countrycodes: 'it'
  });

  const response = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    cache: 'no-store',
    signal,
    headers: {
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    return [];
  }

  const payload = await response.json();
  const items = (Array.isArray(payload) ? payload : [])
    .map((item) => {
      const lat = Number(item?.lat);
      const lon = Number(item?.lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        return null;
      }

      return {
        lat,
        lon,
        display_name: String(item?.display_name || '').trim()
      };
    })
    .filter(Boolean);

  geocodeResultCache.set(cacheKey, {
    items,
    expiresAt: now + WALKING_ROUTE_CACHE_MS
  });
  return items;
}

function scheduleSearch(target, query) {
  const previousTimer = geocodeDebounceTimers.get(target);
  if (previousTimer) {
    clearTimeout(previousTimer);
  }

  if (query.trim().length < SEARCH_MIN_QUERY_LENGTH) {
    hideSearchResults(target);
    return;
  }

  const timerId = setTimeout(async () => {
    const previousController = geocodeAbortControllers.get(target);
    if (previousController) {
      previousController.abort();
    }

    const controller = new AbortController();
    geocodeAbortControllers.set(target, controller);

    try {
      const items = await fetchNominatimSuggestions(query, controller.signal);
      renderSearchResults(target, items);
    } catch {
      hideSearchResults(target);
    }
  }, SEARCH_DEBOUNCE_MS);

  geocodeDebounceTimers.set(target, timerId);
}

function applyOriginSearchSelection(item) {
  if (!item) {
    return;
  }

  searchOriginPosition = {
    lat: item.lat,
    lon: item.lon,
    accuracy: null
  };
  manualPosition = null;
  activeOriginMode = 'search';
  mapPickMode = null;

  if (originSearchInput) {
    originSearchInput.value = formatGeocodeResultLabel(item);
  }

  updateUserMarker();
  hideSearchResults('origin');
  setRouteSummary(`Partenza impostata da ricerca: ${formatGeocodeResultLabel(item)}.`);

  if (routeAutoRefresh.checked) {
    calculateRouteToSelectedStop();
  }
}

function applyDestinationSearchSelection(item) {
  if (!item) {
    return;
  }

  destinationPosition = {
    lat: item.lat,
    lon: item.lon
  };
  destinationSource = 'search';
  mapPickMode = null;

  if (destinationSearchInput) {
    destinationSearchInput.value = formatGeocodeResultLabel(item);
  }

  hideSearchResults('destination');
  syncDestinationFromMapPoint();

  addRecentDestination(formatGeocodeResultLabel(item), item.lat, item.lon);

  if (routeAutoRefresh.checked) {
    calculateRouteToSelectedStop();
  }
}

function readRecentDestinations() {
  try {
    const raw = localStorage.getItem(RECENT_DESTINATIONS_KEY) || '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentDestinations(items) {
  try {
    localStorage.setItem(RECENT_DESTINATIONS_KEY, JSON.stringify(items));
  } catch {
    /* ignore storage errors */
  }
}

function renderRecentDestinations() {
  if (!recentDestinations || !recentDestinationsList) {
    return;
  }

  const items = readRecentDestinations();
  if (!items.length) {
    recentDestinations.hidden = true;
    recentDestinationsList.innerHTML = '';
    return;
  }

  recentDestinations.hidden = false;
  recentDestinationsList.innerHTML = items
    .map((item, index) => {
      const safeLabel = escapeHtml(item.label);
      return `<button class="recent-destination-chip" type="button" data-index="${index}">${safeLabel}</button>`;
    })
    .join('');
}

function addRecentDestination(label, lat, lon) {
  if (lat == null || lon == null || Number.isNaN(lat) || Number.isNaN(lon)) {
    return;
  }

  const safeLabel = String(label || '').trim() || `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
  const key = `${Number(lat).toFixed(5)}__${Number(lon).toFixed(5)}`;
  const existing = readRecentDestinations().filter((item) => item.key !== key);
  const next = [{
    key,
    label: safeLabel,
    lat: Number(lat),
    lon: Number(lon)
  }, ...existing].slice(0, RECENT_DESTINATIONS_LIMIT);

  saveRecentDestinations(next);
  renderRecentDestinations();
}

function applyRecentDestination(item) {
  if (!item) {
    return;
  }

  const lat = Number(item.lat);
  const lon = Number(item.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return;
  }

  destinationPosition = { lat, lon };
  destinationSource = 'recent';
  mapPickMode = null;
  hideSearchResults('destination');
  syncDestinationFromMapPoint();

  if (destinationSearchInput) {
    destinationSearchInput.value = String(item.label || '').trim();
  }

  if (routeAutoRefresh.checked) {
    calculateRouteToSelectedStop();
  }
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

function resetWalkingRouteBudget() {
  walkingRouteRequestBudget = WALKING_ROUTE_MAX_REQUESTS_PER_PLAN;
}

function buildWalkingRouteCacheKey(origin, destination) {
  return [
    Number(origin.lat).toFixed(5),
    Number(origin.lon).toFixed(5),
    Number(destination.lat).toFixed(5),
    Number(destination.lon).toFixed(5)
  ].join('__');
}

function buildStraightWalkFallback(origin, destination) {
  const distanceMeters = haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon);
  const durationSeconds = Math.max(1, Math.round(distanceMeters / WALK_SPEED_MPS));
  return {
    points: [
      [origin.lat, origin.lon],
      [destination.lat, destination.lon]
    ],
    distanceMeters: Math.round(distanceMeters),
    durationSeconds,
    source: 'airline-fallback'
  };
}

async function fetchWalkingRoute(origin, destination) {
  if (!origin || !destination) {
    return null;
  }

  const cacheKey = buildWalkingRouteCacheKey(origin, destination);
  const now = Date.now();
  const cached = walkingRouteCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const fallback = buildStraightWalkFallback(origin, destination);
  if (walkingRouteRequestBudget <= 0) {
    return fallback;
  }

  walkingRouteRequestBudget -= 1;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WALKING_ROUTE_TIMEOUT_MS);

  try {
    const url = `${WALKING_ROUTE_BASE_URL}/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson&steps=false`;
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal
    });

    if (!response.ok) {
      return fallback;
    }

    const payload = await response.json();
    const route = Array.isArray(payload?.routes) ? payload.routes[0] : null;
    const coords = Array.isArray(route?.geometry?.coordinates) ? route.geometry.coordinates : [];

    if (!route || coords.length < 2) {
      return fallback;
    }

    const points = coords
      .map((item) => {
        const lon = Number(item?.[0]);
        const lat = Number(item?.[1]);
        if (Number.isNaN(lat) || Number.isNaN(lon)) {
          return null;
        }
        return [lat, lon];
      })
      .filter(Boolean);

    if (points.length < 2) {
      return fallback;
    }

    const value = {
      points,
      distanceMeters: Math.round(Number(route.distance) || fallback.distanceMeters),
      durationSeconds: Math.round(Number(route.duration) || fallback.durationSeconds),
      source: 'osrm-foot'
    };

    walkingRouteCache.set(cacheKey, {
      expiresAt: now + WALKING_ROUTE_CACHE_MS,
      value
    });

    return value;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

function collectBoardingCandidates(option) {
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (stopId, stopName, location) => {
    if (!stopId || !location) {
      return;
    }
    const key = String(stopId);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({ stopId, stopName: stopName || formatStopName(stopId), location });
  };

  pushCandidate(option.boardStopId, option.boardStopName, option.boardStopLocation);
  for (const alt of option.alternativeBoardingStops || []) {
    pushCandidate(alt?.stopId, alt?.stopName, stopLocationById.get(alt?.stopId));
  }

  return candidates;
}

async function enrichOptionWithWalking(option, origin) {
  const candidates = collectBoardingCandidates(option);
  if (!candidates.length) {
    return option;
  }

  let best = null;
  for (const candidate of candidates.slice(0, 5)) {
    const walking = await fetchWalkingRoute(origin, candidate.location);
    if (!walking) {
      continue;
    }

    const walkSeconds = Math.max(1, Math.round(walking.durationSeconds));
    const reachable = (option.boardEtaSeconds || 0) + BOARDING_BUFFER_SECONDS >= walkSeconds;
    if (!reachable) {
      continue;
    }

    const waitSeconds = Math.max(0, (option.boardEtaSeconds || 0) - walkSeconds);
    const totalSeconds = walkSeconds + waitSeconds + Math.max(0, Number(option.rideSeconds) || 0);

    if (!best || totalSeconds < best.totalSeconds || (totalSeconds === best.totalSeconds && walkSeconds < best.walkSeconds)) {
      best = {
        candidate,
        walking,
        walkSeconds,
        waitSeconds,
        totalSeconds
      };
    }
  }

  if (!best) {
    const fallback = await fetchWalkingRoute(origin, candidates[0].location);
    if (!fallback) {
      return option;
    }

    const walkSeconds = Math.max(1, Math.round(fallback.durationSeconds));
    const waitSeconds = Math.max(0, (option.boardEtaSeconds || 0) - walkSeconds);
    return {
      ...option,
      walkDistanceMeters: Math.round(fallback.distanceMeters),
      walkSeconds,
      waitSeconds,
      totalSeconds: Math.round(walkSeconds + waitSeconds + Math.max(0, Number(option.rideSeconds) || 0)),
      walkPathCoordinates: fallback.points,
      walkRouteSource: fallback.source
    };
  }

  return {
    ...option,
    boardStopId: best.candidate.stopId,
    boardStopName: best.candidate.stopName,
    boardStopLocation: best.candidate.location,
    walkDistanceMeters: Math.round(best.walking.distanceMeters),
    walkSeconds: best.walkSeconds,
    waitSeconds: Math.round(best.waitSeconds),
    totalSeconds: Math.round(best.totalSeconds),
    walkPathCoordinates: best.walking.points,
    walkRouteSource: best.walking.source
  };
}

async function enrichOptionsWithWalkingRoutes(options, origin) {
  resetWalkingRouteBudget();
  const result = [];
  for (const option of options) {
    result.push(await enrichOptionWithWalking(option, origin));
  }
  return result;
}

function applyDestinationWalkMetrics(options, destinationPoint) {
  if (!destinationPoint) {
    return options.map((item) => ({
      ...item,
      destinationWalkMeters: 0,
      destinationWalkSeconds: 0,
      totalWalkMeters: Math.round(Number(item.walkDistanceMeters) || 0),
      totalEffectiveSeconds: Math.round(Number(item.totalSeconds) || 0)
    }));
  }

  return options.map((item) => {
    const destinationLoc = item.destinationStopLocation;
    const destinationWalkMeters = destinationLoc
      ? Math.round(haversineMeters(destinationLoc.lat, destinationLoc.lon, destinationPoint.lat, destinationPoint.lon))
      : 0;
    const destinationWalkSeconds = Math.max(0, Math.round(destinationWalkMeters / WALK_SPEED_MPS));
    const totalWalkMeters = Math.round((Number(item.walkDistanceMeters) || 0) + destinationWalkMeters);
    const totalEffectiveSeconds = Math.round((Number(item.totalSeconds) || 0) + destinationWalkSeconds);

    return {
      ...item,
      destinationWalkMeters,
      destinationWalkSeconds,
      totalWalkMeters,
      totalEffectiveSeconds
    };
  });
}

function setRouteSummary(text) {
  if (routeSummaryText) routeSummaryText.textContent = text;
  if (routeSummaryWrap) routeSummaryWrap.hidden = false;
}

function getRoutePathKey(option) {
  if (!option) {
    return '';
  }
  return [
    option.transferCount > 0 ? 'transfer' : 'direct',
    option.routeId || '',
    option.transferRouteId || '',
    option.boardStopId || '',
    option.transferStopId || '',
    option.destinationStopId || ''
  ].join('__');
}

function renderNextJourneyTimes(selectedOption) {
  if (!nextJourneyTimes) {
    return;
  }

  if (!selectedOption || !Array.isArray(currentRouteOptions) || !currentRouteOptions.length) {
    nextJourneyTimes.hidden = true;
    nextJourneyTimes.innerHTML = '';
    return;
  }

  const targetKey = getRoutePathKey(selectedOption);
  if (!targetKey) {
    nextJourneyTimes.hidden = true;
    nextJourneyTimes.innerHTML = '';
    return;
  }

  const times = currentRouteOptions
    .filter((item) => getRoutePathKey(item) === targetKey)
    .map((item) => Number(item.boardEtaSeconds))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  const uniqTimes = [...new Set(times)].slice(0, 6);

  if (!uniqTimes.length) {
    nextJourneyTimes.hidden = true;
    nextJourneyTimes.innerHTML = '';
    return;
  }

  const chips = uniqTimes
    .map((eta) => `<span class="next-journey-times__chip">${formatClockFromEta(eta)}</span>`)
    .join('');

  const transferLabel = selectedOption.transferCount > 0 && selectedOption.transferRouteId
    ? ` (${selectedOption.routeId} → ${selectedOption.transferRouteId})`
    : ` (linea ${selectedOption.routeId})`;

  nextJourneyTimes.innerHTML = `
    <span class="next-journey-times__label">Prossime partenze${transferLabel}</span>
    ${chips}
  `;
  nextJourneyTimes.hidden = false;
}

function loadSemaforiPreference() {
  try {
    const stored = localStorage.getItem(TRAFFIC_LIGHTS_TOGGLE_KEY);
    semaforiEnabled = stored !== '0';
  } catch {
    semaforiEnabled = true;
  }
}

function saveSemaforiPreference() {
  try {
    localStorage.setItem(TRAFFIC_LIGHTS_TOGGLE_KEY, semaforiEnabled ? '1' : '0');
  } catch {
    /* ignore storage errors */
  }
}

function syncSemaforiToggleUi() {
  if (!trafficLightsToggleBtn) {
    return;
  }

  trafficLightsToggleBtn.classList.toggle('is-off', !semaforiEnabled);
  trafficLightsToggleBtn.setAttribute('aria-pressed', semaforiEnabled ? 'true' : 'false');
  trafficLightsToggleBtn.setAttribute('title', semaforiEnabled ? 'Semafori attivi' : 'Semafori disattivati');
}

function setSemaforiEnabled(nextValue) {
  semaforiEnabled = Boolean(nextValue);
  syncSemaforiToggleUi();
  saveSemaforiPreference();
  if (semaforiEnabled) {
    enableSemaforiLayer();
  } else {
    disableSemaforiLayer();
  }
}

function loadSimulatedPreference() {
  try {
    const stored = localStorage.getItem(SIMULATED_TOGGLE_KEY);
    simulatedEnabled = stored !== '0';
  } catch {
    simulatedEnabled = true;
  }
}

function saveSimulatedPreference() {
  try {
    localStorage.setItem(SIMULATED_TOGGLE_KEY, simulatedEnabled ? '1' : '0');
  } catch {
    /* ignore storage errors */
  }
}

function syncSimulatedToggleUi() {
  if (!simulatedToggleBtn) {
    return;
  }

  simulatedToggleBtn.classList.toggle('is-off', !simulatedEnabled);
  simulatedToggleBtn.setAttribute('aria-pressed', simulatedEnabled ? 'true' : 'false');
  simulatedToggleBtn.setAttribute('title', simulatedEnabled ? 'Bus simulati attivi' : 'Bus simulati nascosti');
}

function setSimulatedEnabled(nextValue) {
  simulatedEnabled = Boolean(nextValue);
  syncSimulatedToggleUi();
  saveSimulatedPreference();
  renderSelectedRouteView();
}

function clearNavigationLayer() {
  if (map && navRouteLayer) {
    map.removeLayer(navRouteLayer);
    navRouteLayer = null;
  }
}

function resetActiveMapSelection() {
  if (!map) {
    return;
  }

  map.closePopup();
  clearNavigationLayer();
  closeBusActionCard();

  if (routeShapeLayer && map.hasLayer(routeShapeLayer)) {
    map.removeLayer(routeShapeLayer);
  }
  routeShapeLayer = null;
  selectedTripContext = null;
  selectedRouteOptionKey = '';
  renderNextJourneyTimes(null);
}

function hasSeenStartupAlert() {
  let seenInSession = false;
  let seenPersisted = false;

  try {
    seenInSession = sessionStorage.getItem(STARTUP_ALERT_SESSION_KEY) === '1';
  } catch {
    seenInSession = false;
  }

  try {
    seenPersisted = localStorage.getItem(STARTUP_ALERT_SEEN_KEY) === '1';
  } catch {
    seenPersisted = false;
  }

  return seenInSession || seenPersisted;
}

function markStartupAlertSeen() {
  try {
    sessionStorage.setItem(STARTUP_ALERT_SESSION_KEY, '1');
  } catch {
  }
  try {
    localStorage.setItem(STARTUP_ALERT_SEEN_KEY, '1');
  } catch {
  }
}

function closeStartupAlertModal() {
  if (!startupAlertModal) {
    return;
  }

  startupAlertModal.classList.remove('is-visible');
  startupAlertModal.hidden = true;
  markStartupAlertSeen();
}

function openStartupAlertModal() {
  if (!startupAlertModal || hasSeenStartupAlert()) {
    return;
  }

  startupAlertModal.hidden = false;
  requestAnimationFrame(() => {
    startupAlertModal.classList.add('is-visible');
  });
}

function isMapInteractiveTarget(event) {
  const target = event?.originalEvent?.target;
  if (!(target instanceof Element)) {
    return false;
  }

  return Boolean(target.closest('.leaflet-marker-pane, .leaflet-popup-pane, .leaflet-control'));
}

function getLineFilteredEntities(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  let filtered = items;
  if (selectedLineFilter !== 'all') {
    filtered = filtered.filter((item) => String(item.routeId || '') === String(selectedLineFilter));
  }

  if (!simulatedEnabled) {
    filtered = filtered.filter((item) => !item.isSimulated);
  }

  if (trackedBusKey) {
    const tracked = items.find((item) => getEntityKey(item) === trackedBusKey);
    if (tracked && !filtered.some((item) => getEntityKey(item) === trackedBusKey)) {
      filtered = [...filtered, tracked];
    }
  }

  return filtered;
}

function renderLineFilterOptions(availableRouteIds) {
  if (!lineFilterSelect) {
    return;
  }

  const previousValue = lineFilterSelect.value || selectedLineFilter || 'all';
  lineFilterSelect.innerHTML = '';

  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = 'Tutte';
  lineFilterSelect.appendChild(allOption);

  for (const routeId of availableRouteIds) {
    const option = document.createElement('option');
    option.value = routeId;
    option.textContent = routeId;
    lineFilterSelect.appendChild(option);
  }

  const shouldUsePrevious = previousValue === 'all' || availableRouteIds.includes(previousValue);
  selectedLineFilter = shouldUsePrevious ? previousValue : 'all';
  lineFilterSelect.value = selectedLineFilter;
}

function applyBasemapMode() {
  if (!map || !darkTileLayer || !satelliteTileLayer) {
    return;
  }

  if (activeBaseLayer && map.hasLayer(activeBaseLayer)) {
    map.removeLayer(activeBaseLayer);
  }

  activeBaseLayer = isSatelliteMode ? satelliteTileLayer : darkTileLayer;
  activeBaseLayer.addTo(map);

  if (basemapToggleBtn) {
    basemapToggleBtn.classList.toggle('is-satellite', isSatelliteMode);
    basemapToggleBtn.title = isSatelliteMode ? 'Passa a mappa dark' : 'Passa a satellite';
    basemapToggleBtn.setAttribute('aria-label', isSatelliteMode ? 'Passa a mappa dark' : 'Passa a satellite');
  }
}

async function reverseGeocodeLatLon(lat, lon) {
  if (reverseGeocodeAbortController) {
    reverseGeocodeAbortController.abort();
  }
  reverseGeocodeAbortController = new AbortController();

  try {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: 'jsonv2',
      zoom: '18',
      addressdetails: '1'
    });

    const response = await fetch(`${NOMINATIM_REVERSE_URL}?${params.toString()}`, {
      cache: 'no-store',
      signal: reverseGeocodeAbortController.signal,
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      return '';
    }

    const payload = await response.json();
    return String(
      payload?.name ||
      payload?.display_name ||
      ''
    ).trim();
  } catch {
    return '';
  } finally {
    reverseGeocodeAbortController = null;
  }
}

async function setDestinationFromMapPoint(lat, lon) {
  destinationPosition = { lat, lon };
  destinationSource = 'map';
  mapPickMode = null;

  hideSearchResults('destination');
  syncDestinationFromMapPoint();

  const reverseLabel = await reverseGeocodeLatLon(lat, lon);
  if (destinationSearchInput) {
    destinationSearchInput.value = reverseLabel || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }

  addRecentDestination(reverseLabel || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon);

  await calculateRouteToSelectedStop();
}

function getEffectiveOriginPosition() {
  if (activeOriginMode === 'manual' && manualPosition) {
    return manualPosition;
  }

  if (activeOriginMode === 'search' && searchOriginPosition) {
    return searchOriginPosition;
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

function renderRouteSteps() {
  // No-op: step-by-step directions removed in Zero-UI
}

function renderBusRouteSteps() {
  // No-op: step-by-step directions removed in Zero-UI
}

function renderRouteOptionCards(options, best, secondaryOptions = []) {
  if (!routeOptionsList) {
    return;
  }

  if (!Array.isArray(options) || !options.length) {
    routeOptionsList.innerHTML = '';
    renderNextJourneyTimes(null);
    return;
  }

  // Server already handles trip-dedup, route-dedup & segment grouping.
  // Just group by routeId + boardStop + destStop for card layout.
  const top = options.slice(0, 24);
  const groups = new Map();
  for (const item of top) {
    const lineLabel = item.transferCount > 0 && item.transferRouteId
      ? `${item.routeId} -> ${item.transferRouteId}`
      : String(item.routeId || '?');
    const groupKey = `${lineLabel}__${item.boardStopId || ''}__${item.destinationStopId || ''}`;
    const values = groups.get(groupKey) || [];
    values.push(item);
    groups.set(groupKey, values);
  }

  const groupCards = [...groups.entries()].map(([groupKey, values]) => {
    values.sort((a, b) => {
      if ((a.totalEffectiveSeconds || a.totalSeconds) !== (b.totalEffectiveSeconds || b.totalSeconds)) {
        return (a.totalEffectiveSeconds || a.totalSeconds) - (b.totalEffectiveSeconds || b.totalSeconds);
      }
      if ((a.totalWalkMeters || a.walkDistanceMeters) !== (b.totalWalkMeters || b.walkDistanceMeters)) {
        return (a.totalWalkMeters || a.walkDistanceMeters) - (b.totalWalkMeters || b.walkDistanceMeters);
      }
      return a.boardEtaSeconds - b.boardEtaSeconds;
    });
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

    // Build route pills (Google Maps style: "01 19 53")
    const allRoutes = [head.routeId];
    if (Array.isArray(head.alternativeRoutes)) {
      for (const alt of head.alternativeRoutes) {
        if (!allRoutes.includes(alt.routeId)) {
          allRoutes.push(alt.routeId);
        }
      }
    }
    const routePills = allRoutes.map(r => `<span class="route-pill">${r}</span>`).join(' ');

    let lineText;
    if (head.transferCount > 0) {
      const lineLabel = `${head.routeId} -> ${head.transferRouteId}`;
      lineText = `Linee ${lineLabel}`;
    } else if (allRoutes.length > 1) {
      lineText = `Linee ${routePills}`;
    } else {
      lineText = `Linea ${routePills}`;
    }

    const transferText = head.transferCount > 0 && head.transferStopName
      ? ` - Cambio: ${head.transferStopName}`
      : '';

    const alternativeStopNames = Array.isArray(head.alternativeBoardingStops)
      ? [...new Set(
          head.alternativeBoardingStops
            .map((s) => String(s?.stopName || '').trim())
            .filter(Boolean)
            .filter((name) => name !== String(head.boardStopName || '').trim())
        )]
      : [];

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
                  <span class="route-option-chip">A piedi ${formatDistanceMeters(item.walkDistanceMeters)}</span>
                  <span class="route-option-chip">Partenza ${formatClockFromEta(item.boardEtaSeconds)}</span>
                  ${item.transferCount > 0 ? `<span class="route-option-chip">Cambio ${formatClockFromEta(item.transferBoardEtaSeconds)}</span>` : ''}
                  <span class="route-option-chip">Arrivo ${formatClockFromEta(item.destinationEtaSeconds)}</span>
                  <span class="route-option-chip">Totale ${formatDurationSeconds(item.totalEffectiveSeconds || item.totalSeconds)}</span>
                </div>
                <p class="route-option-line">Salita: ${item.boardStopName} - Discesa: ${item.destinationStopName}</p>
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
        <p class="route-option-title">${lineText}${head.vehicleId ? ` - Veicolo ${head.vehicleId}` : ''}</p>
        <div class="route-option-meta">
          <span class="route-option-chip">A piedi ${formatDistanceMeters(head.totalWalkMeters || head.walkDistanceMeters)}</span>
          <span class="route-option-chip">Partenza ${formatClockFromEta(head.boardEtaSeconds)}</span>
          ${head.transferCount > 0 ? `<span class="route-option-chip">Cambio ${formatClockFromEta(head.transferBoardEtaSeconds)}</span>` : ''}
          <span class="route-option-chip">Arrivo ${formatClockFromEta(head.destinationEtaSeconds)}</span>
          <span class="route-option-chip">Totale ${formatDurationSeconds(head.totalEffectiveSeconds || head.totalSeconds)}</span>
        </div>
        <p class="route-option-line">A piedi ${formatDistanceMeters(head.walkDistanceMeters)} fino a salita - Salita: ${head.boardStopName}${alternativeStopNames.length ? ` <span class="alt-stops-hint">(anche da ${alternativeStopNames.join(', ')})</span>` : ''}
        </p>
        <p class="route-option-line">Discesa: ${head.destinationStopName}</p>
        <p class="route-option-line">Ultimo tratto a piedi: ${formatDistanceMeters(head.destinationWalkMeters || 0)}</p>
        <p class="route-option-line">Fermate: ${head.stopsToTravel}${transferText}${isBest ? ' - Consigliato' : ''}</p>
        ${othersMarkup}
      </article>
    `;
  });

  const secondaryMarkup = Array.isArray(secondaryOptions) && secondaryOptions.length
    ? `
      <section class="secondary-options">
        <h3 class="secondary-options__title">Opzioni secondarie (meno strada a piedi, con cambio)</h3>
        <div class="secondary-options__grid">
          ${secondaryOptions
            .slice(0, 6)
            .map((item) => {
              const key = getRouteOptionKey(item);
              const isSelected = selectedRouteOptionKey && selectedRouteOptionKey === key;
              return `
                <article class="route-option-card route-option-card--secondary ${isSelected ? 'route-option-card--selected' : ''}" data-route-key="${key}">
                  <p class="route-option-title">Linee ${item.routeId} -> ${item.transferRouteId}</p>
                  <div class="route-option-meta">
                    <span class="route-option-chip">A piedi ${formatDistanceMeters(item.walkDistanceMeters)}</span>
                    <span class="route-option-chip">Partenza ${formatClockFromEta(item.boardEtaSeconds)}</span>
                    <span class="route-option-chip">Cambio ${formatClockFromEta(item.transferBoardEtaSeconds)}</span>
                    <span class="route-option-chip">Arrivo ${formatClockFromEta(item.destinationEtaSeconds)}</span>
                    <span class="route-option-chip">Totale ${formatDurationSeconds(item.totalEffectiveSeconds || item.totalSeconds)}</span>
                  </div>
                  <p class="route-option-line">Salita: ${item.boardStopName}</p>
                  <p class="route-option-line">Discesa: ${item.destinationStopName}</p>
                  <p class="route-option-line">A piedi totale: ${formatDistanceMeters(item.totalWalkMeters || item.walkDistanceMeters)}</p>
                  <p class="route-option-line">Cambio: ${item.transferStopName || 'n/d'}</p>
                </article>
              `;
            })
            .join('')}
        </div>
      </section>
    `
    : '';

  routeOptionsList.innerHTML = `${groupCards.join('')}${secondaryMarkup}`;
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

  const walkPoints = Array.isArray(best.walkPathCoordinates) && best.walkPathCoordinates.length >= 2
    ? best.walkPathCoordinates
    : [
        [origin.lat, origin.lon],
        [board.lat, board.lon]
      ];

  const walkSegment = L.polyline(walkPoints, {
    color: '#2e7d32',
    weight: 4,
    dashArray: '8,6',
    opacity: 0.9
  });

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

// pickBestBusForDestination removed - was dead code, replaced by server-side planner (requestStaticPlan)

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
      maxTransfers: allowTransfers?.checked ? 1 : 0,
      includeSecondaryTransfers: true
    });

    appendRouteDebug(
      `Planner statico: fermate vicine=${plan.nearbyOriginStopsCount}, alternative destinazione=${plan.destinationAlternativesCount}, opzioni=${plan.options?.length || 0}.`
    );

    let options = (plan.options || [])
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

    options = await enrichOptionsWithWalkingRoutes(options, origin);
    options = applyDestinationWalkMetrics(options, destinationPosition);

    // Clean anti-change rule with guardrail:
    // keep only direct rides when the best direct is not an excessive walk.
    const directToExact = options
      .filter((item) => item.transferCount === 0 && item.destinationStopId === stopId)
      .sort((a, b) => (a.totalEffectiveSeconds || a.totalSeconds) - (b.totalEffectiveSeconds || b.totalSeconds));

    if (directToExact.length > 0) {
      const bestDirect = directToExact[0];
      if ((bestDirect.totalWalkMeters || 0) <= DIRECT_ONLY_WALK_CAP_METERS) {
        options = directToExact;
        appendRouteDebug(`Filtro anti-cambi: mantenute dirette (walk totale ${bestDirect.totalWalkMeters}m).`);
      } else {
        appendRouteDebug(`Diretta disponibile ma con cammino alto (${bestDirect.totalWalkMeters}m): abilito confronto con opzioni secondarie.`);
      }
    } else {
      const directOnly = options
        .filter((item) => item.transferCount === 0)
        .sort((a, b) => (a.totalEffectiveSeconds || a.totalSeconds) - (b.totalEffectiveSeconds || b.totalSeconds));
      if (directOnly.length > 0 && (directOnly[0].totalWalkMeters || 0) <= DIRECT_ONLY_WALK_CAP_METERS) {
        options = directOnly;
        appendRouteDebug(`Nessuna diretta esatta: mantengo solo dirette senza cambio (${directOnly.length}).`);
      }
    }

    options.sort((a, b) => {
      if (a.transferCount !== b.transferCount) {
        return a.transferCount - b.transferCount;
      }
      if ((a.totalEffectiveSeconds || a.totalSeconds) !== (b.totalEffectiveSeconds || b.totalSeconds)) {
        return (a.totalEffectiveSeconds || a.totalSeconds) - (b.totalEffectiveSeconds || b.totalSeconds);
      }
      if ((a.totalWalkMeters || a.walkDistanceMeters) !== (b.totalWalkMeters || b.walkDistanceMeters)) {
        return (a.totalWalkMeters || a.walkDistanceMeters) - (b.totalWalkMeters || b.walkDistanceMeters);
      }
      return a.boardEtaSeconds - b.boardEtaSeconds;
    });
    appendRouteDebug(`Percorsi a piedi ricalcolati con routing reale (${options.length} opzioni).`);

    let secondaryOptions = [];
    if (options.length) {
      try {
        const secondaryPlan = await requestStaticPlan({
          origin,
          destinationStopId: stopId,
          destinationPoint: destinationPosition,
          maxWalkMeters: MAX_WALK_METERS_FALLBACK,
          destinationRadiusMeters: DESTINATION_ALTERNATIVE_RADIUS_METERS,
          maxLookAheadSeconds: MAX_FUTURE_LOOKAHEAD_SECONDS,
          allowTransfers: true,
          maxTransfers: 1,
          includeSecondaryTransfers: true
        });

        const secondaryBase = (secondaryPlan.options || [])
          .filter((item) => item.transferCount > 0 && item.destinationStopId === stopId)
          .map((item) => ({
            ...item,
            boardStopLocation: stopLocationById.get(item.boardStopId),
            transferStopLocation: item.transferStopId ? stopLocationById.get(item.transferStopId) : null,
            destinationStopLocation: stopLocationById.get(item.destinationStopId)
          }))
          .filter((item) => item.boardStopLocation && item.destinationStopLocation);

        const secondaryEnriched = applyDestinationWalkMetrics(
          await enrichOptionsWithWalkingRoutes(secondaryBase, origin),
          destinationPosition
        );
        const bestPrimary = options[0];
        const maxSecondaryTotalSeconds = (bestPrimary?.totalEffectiveSeconds || bestPrimary?.totalSeconds || 0) + SECONDARY_MAX_EXTRA_SECONDS;

        secondaryOptions = secondaryEnriched
          .filter((item) => (bestPrimary.totalWalkMeters - item.totalWalkMeters) >= SECONDARY_MIN_WALK_GAIN_METERS)
          .filter((item) => (item.totalEffectiveSeconds || item.totalSeconds) <= maxSecondaryTotalSeconds)
          .sort((a, b) => a.totalWalkMeters - b.totalWalkMeters || (a.totalEffectiveSeconds || a.totalSeconds) - (b.totalEffectiveSeconds || b.totalSeconds))
          .slice(0, 6);

        appendRouteDebug(`Opzioni secondarie calcolate: ${secondaryOptions.length} (meno cammino con cambio).`);
      } catch (error) {
        appendRouteDebug(`Opzioni secondarie non disponibili: ${error.message}`);
      }
    }

    if (!options.length) {
      clearNavigationLayer();
      routeSteps.innerHTML = '';
      renderRouteOptionCards([], null, []);
      currentRouteOptions = [];
      currentSecondaryRouteOptions = [];
      selectedRouteOptionKey = '';
      renderNextJourneyTimes(null);
      setRouteSummary('Nessun bus compatibile trovato ora per questa destinazione. Prova a cambiare fermata o riprovare tra poco.');
      return;
    }

    currentSecondaryRouteOptions = secondaryOptions;
    currentRouteOptions = [...options, ...secondaryOptions];
    const preservedSelection = selectedRouteOptionKey
      ? currentRouteOptions.find((item) => getRouteOptionKey(item) === selectedRouteOptionKey)
      : null;
    const best = preservedSelection || options[0];
    selectedRouteOptionKey = getRouteOptionKey(best);

    await renderBusRouteOnMap(best);
    renderBusRouteSteps(best);
    renderRouteOptionCards(options, best, secondaryOptions);
    setRouteSummary(
      `Percorso migliore: ${best.transferCount > 0 ? `linee ${best.routeId}->${best.transferRouteId}` : `linea ${best.routeId}`} (${best.vehicleId || 'n/d'}) - Partenza ${formatClockFromEta(best.boardEtaSeconds)} - Arrivo ${formatClockFromEta(best.destinationEtaSeconds)} - Totale ${formatDurationSeconds(best.totalEffectiveSeconds || best.totalSeconds)} - Salita a ${best.boardStopName}`
    );
    renderNextJourneyTimes(best);
    // Auto-collapse the search UI so the user can see the route on the map
    setTimeout(() => {
      if (typeof collapseSearchCard === 'function') collapseSearchCard();
    }, 500);
  } catch (error) {
    appendRouteDebug(`Errore globale calcolo percorso: ${error.message}`);
    setRouteSummary(`Errore percorso: ${error.message}`);
    if (routeSteps) routeSteps.innerHTML = '';
    renderRouteOptionCards([], null, []);
    currentRouteOptions = [];
    currentSecondaryRouteOptions = [];
    selectedRouteOptionKey = '';
    renderNextJourneyTimes(null);
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

  if (activeOriginMode !== 'manual' && activeOriginMode !== 'search') {
    activeOriginMode = 'gps';
  }

  updateUserMarker();
  const accuracyText = userPosition.accuracy ? `+-${Math.round(userPosition.accuracy)}m` : 'accuratezza n/d';
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
  if (tripDetailsSummary) tripDetailsSummary.textContent = text;
  if (upcomingStops) upcomingStops.innerHTML = '';
  if (serviceCalendarText) serviceCalendarText.textContent = '-';

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
  return `Service ${serviceSummary.serviceId}: ${days}. Validita ${base.startDate} - ${base.endDate} (${activeText}).`;
}

function renderTripDetails(data) {
  const route = data.routeId || 'n/d';
  const trip = data.tripId || 'n/d';
  const total = data.totalStops || 0;
  if (tripDetailsSummary) tripDetailsSummary.textContent = `Linea ${route} - Trip ${trip} - Fermate totali: ${total}`;

  if (upcomingStops) {
    if (Array.isArray(data.upcomingStops) && data.upcomingStops.length) {
      upcomingStops.innerHTML = data.upcomingStops
        .map((item) => `<li>${item.stopSequence}. ${item.stopName} - prev. ${item.arrivalTime} - stimato ${item.predictedArrivalTime}</li>`)
        .join('');
    } else {
      upcomingStops.innerHTML = '<li>Nessuna fermata in arrivo disponibile</li>';
    }
  }

  if (serviceCalendarText) serviceCalendarText.textContent = formatCalendarSummary(data.serviceSummary);

  if (Array.isArray(data.upcomingStops) && data.upcomingStops.length) {
    const candidateStopId = data.upcomingStops[0].stopId;
    if (!destinationPosition && candidateStopId && stopLocationById.has(candidateStopId)) {
      if (destinationStopSelect) destinationStopSelect.value = candidateStopId;
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

function buildBusSnapshot(item) {
  return {
    key: getEntityKey(item),
    routeId: item.routeId || '',
    vehicleId: item.vehicleId || '',
    stopId: item.stopId || '',
    lat: item.lat,
    lon: item.lon,
    speed: item.speed,
    delay: item.delay,
    positionTimestamp: item.positionTimestamp,
    isSimulated: item.isSimulated === true
  };
}

function updateBusActionCard() {
  if (!busActionCard || !busActionTitle || !busActionMeta) {
    return;
  }

  const snapshot = selectedBusSnapshot;
  if (!snapshot) {
    busActionCard.hidden = true;
    return;
  }

  const lineLabel = snapshot.routeId ? `Linea ${snapshot.routeId}` : 'Linea non disponibile';
  const vehicleLabel = snapshot.vehicleId ? `Veicolo ${snapshot.vehicleId}` : 'Veicolo n/d';
  const stopLabel = snapshot.stopId ? `Fermata ${formatStopName(snapshot.stopId)}` : 'Fermata n/d';
  const speedLabel = snapshot.speed != null ? `Velocita ${formatSpeed(snapshot.speed)}` : 'Velocita n/d';
  const ageLabel = snapshot.positionTimestamp ? formatPositionAge(snapshot.positionTimestamp) : '';
  const ageLine = ageLabel ? `Aggiornato ${ageLabel}` : '';
  const delayLabel = snapshot.delay != null ? `Ritardo ${formatDelay(snapshot.delay)}` : '';
  const trackingActive = trackedBusKey && trackedBusKey === snapshot.key;

  if (busActionTitle) {
    busActionTitle.textContent = lineLabel;
  }

  if (busActionSubtitle) {
    busActionSubtitle.textContent = `${vehicleLabel}${trackingActive ? (followBusMode ? ' · tracking attivo' : ' · tracking in pausa') : ''}`;
  }

  const simulatedNote = snapshot.isSimulated ? 'Posizione stimata (segnale assente).' : '';
  busActionMeta.innerHTML = [
    stopLabel,
    speedLabel,
    delayLabel,
    simulatedNote,
    ageLine
  ].filter(Boolean).join('<br>');

  if (busTrackBtn) {
    if (trackingActive) {
      busTrackBtn.textContent = followBusMode ? 'Smetti di seguire' : 'Riprendi traccia';
    } else {
      busTrackBtn.textContent = 'Tieni traccia';
    }
  }

  busActionCard.hidden = false;
}

function openBusActionCard(item) {
  if (!item) {
    return;
  }

  selectedBusSnapshot = buildBusSnapshot(item);
  updateBusActionCard();
}

function closeBusActionCard() {
  selectedBusSnapshot = null;
  if (busActionCard) {
    busActionCard.hidden = true;
  }
}

function centerMapOnEntity(entity, force = false) {
  if (!map || !entity || entity.lat == null || entity.lon == null || Number.isNaN(entity.lat) || Number.isNaN(entity.lon)) {
    return;
  }

  const center = map.getCenter();
  const distance = haversineMeters(center.lat, center.lng, entity.lat, entity.lon);
  if (force || distance > 35) {
    map.panTo([entity.lat, entity.lon], { animate: true, duration: 0.6 });
  }
}

function applyBusTracking(entities, forceCenter = false) {
  if (!trackedBusKey || !Array.isArray(entities)) {
    return;
  }

  const tracked = entities.find((item) => getEntityKey(item) === trackedBusKey);
  if (!tracked) {
    trackedBusMissingCount += 1;
    if (trackedBusMissingCount >= 3) {
      followBusMode = false;
      trackedBusKey = '';
      updateBusActionCard();
    }
    return;
  }

  trackedBusMissingCount = 0;
  if (selectedBusSnapshot && selectedBusSnapshot.key === trackedBusKey) {
    selectedBusSnapshot = buildBusSnapshot(tracked);
    updateBusActionCard();
  }

  if (followBusMode || forceCenter) {
    centerMapOnEntity(tracked, forceCenter);
  }

  if (streetViewOpen) {
    updateStreetViewForEntity(tracked);
  }
}

async function handleMarkerSelection(item) {
  try {
    openBusActionCard(item);
    if (streetViewOpen) {
      updateStreetViewForEntity(item);
    }
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

    const key = getEntityKey(item);
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
      const icon = createBusIcon(item.routeId, { simulated: item.isSimulated });
      const marker = L.marker([item.lat, item.lon], icon ? { icon } : undefined).addTo(map);
      marker.bindPopup(buildPopup(item));
      marker.on('click', (event) => {
        suppressNextMapClick = true;
        event?.originalEvent?.stopPropagation?.();
        handleMarkerSelection(item);
      });
      markerByTripId.set(key, {
        marker
      });
      const element = marker.getElement();
      if (element) {
        element.classList.toggle('bus-marker--tracked', key === trackedBusKey);
      }
      continue;
    }

    existing.marker.setLatLng([item.lat, item.lon]);
    existing.marker.setPopupContent(buildPopup(item));
    const icon = createBusIcon(item.routeId, { simulated: item.isSimulated });
    if (icon) {
      existing.marker.setIcon(icon);
    }
    existing.marker.off('click');
    existing.marker.on('click', (event) => {
      suppressNextMapClick = true;
      event?.originalEvent?.stopPropagation?.();
      handleMarkerSelection(item);
    });
    const element = existing.marker.getElement();
    if (element) {
      element.classList.toggle('bus-marker--tracked', key === trackedBusKey);
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

    // TripUpdates always provides a routeId - trust it as source of truth
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

// renderRows / renderStats / updateMapTitle - no-ops (UI elements removed)
function renderRows() {}
function renderStats() {}
function updateMapTitle() {}

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
  if (!lineSelect) return;
  lineSelect.innerHTML = '';

  if (!availableRouteIds.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Nessuna linea disponibile';
    lineSelect.appendChild(option);
    lineSelect.disabled = true;
    renderLineFilterOptions([]);
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

  renderLineFilterOptions(availableRouteIds);
}

function renderSelectedRouteView() {
  const filtered = getLineFilteredEntities(lastMergedEntities);
  updateMap(filtered);
  applyBusTracking(lastMergedEntities);
  if (streetViewOpen) {
    const target = getStreetViewTargetEntity();
    if (target) {
      updateStreetViewForEntity(target);
    }
  }
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
    const merged = mergeTripAndPosition(tripEntities, positionsByKey);
    const simulation = applyScheduledSimulation(merged);
    lastMergedEntities = simulation.entities;
    lastSimulatedCount = simulation.simulatedCount;
    lastFeedTimestamp = feedTs;

    const routeIds = [...new Set(lastMergedEntities.map((item) => item.routeId).filter(Boolean))];
    console.log(`[FEED] parsed ${tripEntities.length} tripUpdates, ${positionsByKey.size} vehiclePositions, merged ${lastMergedEntities.length} entities, routeIds: [${routeIds.sort(compareRouteIds).join(', ')}]`);
    if (simulation.simulatedCount > 0) {
      console.warn(`[SIM] ${simulation.simulatedCount} bus simulati attivi (segnale GPS assente)`);
    }
    if (simulation.switchedToLiveCount > 0) {
      console.log(`[SIM] ${simulation.switchedToLiveCount} bus passati da simulato a segnale live`);
    }

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

    if (selectedBusSnapshot?.key) {
      const refreshedSelection = lastMergedEntities.find((item) => getEntityKey(item) === selectedBusSnapshot.key);
      if (refreshedSelection) {
        selectedBusSnapshot = buildBusSnapshot(refreshedSelection);
        updateBusActionCard();
        if (streetViewOpen) {
          updateStreetViewForEntity(refreshedSelection);
        }
      }
    }

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
        renderTripDetailsPlaceholder('La corsa selezionata non e piu presente nel feed live');
      }
    }

    // Feed staleness check
    if (feedTs) {
      const feedAgeSeconds = Math.floor(Date.now() / 1000 - feedTs);
      if (feedAgeSeconds > 120) {
        const mins = Math.floor(feedAgeSeconds / 60);
        showFeedBanner(`Attenzione: feed GTFS-RT non aggiornato da ${mins} minuti - i dati potrebbero non essere attendibili.`, 'warn');
      } else if (feedConsecutiveFailures > 0) {
        showFeedBanner('OK: connessione al feed ripristinata.', 'ok');
        setTimeout(hideFeedBanner, 5000);
      } else {
        hideFeedBanner();
      }
    } else {
      hideFeedBanner();
    }
    feedConsecutiveFailures = 0;

    const simText = lastSimulatedCount > 0 ? ` - ${lastSimulatedCount} bus in simulazione` : '';
    message.textContent = `Dati aggiornati alle ${new Date().toLocaleTimeString('it-IT')}${simText}`;
  } catch (error) {
    feedConsecutiveFailures++;
    const level = feedConsecutiveFailures >= 3 ? 'error' : 'warn';
    const label = feedConsecutiveFailures >= 3
      ? `Errore: feed non disponibile (${feedConsecutiveFailures} tentativi falliti): ${error.message}`
      : `Attenzione: errore temporaneo feed: ${error.message}`;
    showFeedBanner(label, level);

    message.textContent = `Errore durante il recupero feed: ${error.message}`;
    if (lineSelect) {
      lineSelect.innerHTML = '<option value="">Errore feed</option>';
      lineSelect.disabled = true;
    }
    renderTripDetailsPlaceholder('Impossibile caricare i dettagli corsa in questo momento');
    if (destinationStopSelect) {
      destinationStopSelect.innerHTML = '<option value="">Fermate non disponibili</option>';
      destinationStopSelect.disabled = true;
    }
  }
}

function startAutoRefresh() {
  clearInterval(timer);
  timer = setInterval(loadData, REFRESH_MS);
}

// UI State Orchestration - Zero-UI search card collapse/expand

function collapseSearchCard() {
  if (!searchCard) return;
  searchCard.classList.add('is-collapsed');
  if (editRouteBtn) editRouteBtn.hidden = false;
}

function expandSearchCard() {
  if (!searchCard) return;
  searchCard.classList.remove('is-collapsed');
  if (editRouteBtn) editRouteBtn.hidden = true;
}

function showRouteSummary(text) {
  if (routeSummaryWrap) routeSummaryWrap.hidden = false;
  setRouteSummary(text);
}

// After a route is calculated, auto-collapse the card so the user sees the path
function onRouteCalculated(summaryText) {
  showRouteSummary(summaryText);
  // Delay collapse slightly so the user sees the summary appear
  setTimeout(collapseSearchCard, 600);
}

// Swap origin <-> destination
swapBtn?.addEventListener('click', () => {
  const originVal = originSearchInput?.value || '';
  const destVal = destinationSearchInput?.value || '';

  if (originSearchInput) originSearchInput.value = destVal;
  if (destinationSearchInput) destinationSearchInput.value = originVal;

  // Swap positions
  const tempOrigin = searchOriginPosition || manualPosition;
  const tempDest = destinationPosition;

  if (tempDest) {
    searchOriginPosition = { lat: tempDest.lat, lon: tempDest.lon, accuracy: null };
    manualPosition = null;
    activeOriginMode = 'search';
    updateUserMarker();
  }

  if (tempOrigin) {
    destinationPosition = { lat: tempOrigin.lat, lon: tempOrigin.lon };
    destinationSource = 'search';
    syncDestinationFromMapPoint();
  }
});

// Edit route pill
editRouteBtn?.addEventListener('click', () => {
  expandSearchCard();
});

searchCardCollapseBtn?.addEventListener('click', () => {
  collapseSearchCard();
});

// GPS locate
locateBtn?.addEventListener('click', () => {
  searchOriginPosition = null;
  manualPosition = null;
  activeOriginMode = 'gps';
  mapPickMode = null;
  if (originSearchInput) originSearchInput.value = '';
  hideSearchResults('origin');
  startUserLocationWatch();
});

// Route calculation
routeNowBtn?.addEventListener('click', async () => {
  if (routeNowBtn) routeNowBtn.classList.add('is-loading');
  await calculateRouteToSelectedStop();
  if (routeNowBtn) routeNowBtn.classList.remove('is-loading');
});

lineFilterSelect?.addEventListener('change', () => {
  selectedLineFilter = lineFilterSelect.value || 'all';
  renderSelectedRouteView();
});

basemapToggleBtn?.addEventListener('click', () => {
  isSatelliteMode = !isSatelliteMode;
  applyBasemapMode();
});

trafficLightsToggleBtn?.addEventListener('click', () => {
  setSemaforiEnabled(!semaforiEnabled);
});

simulatedToggleBtn?.addEventListener('click', () => {
  setSimulatedEnabled(!simulatedEnabled);
});

streetViewToggleBtn?.addEventListener('click', () => {
  openStreetViewPanel();
});

busTrackBtn?.addEventListener('click', () => {
  if (!selectedBusSnapshot || !selectedBusSnapshot.key) {
    return;
  }

  if (trackedBusKey && trackedBusKey === selectedBusSnapshot.key) {
    if (followBusMode) {
      trackedBusKey = '';
      followBusMode = false;
    } else {
      followBusMode = true;
    }
  } else {
    trackedBusKey = selectedBusSnapshot.key;
    followBusMode = true;
  }

  trackedBusMissingCount = 0;
  updateBusActionCard();
  applyBusTracking(lastMergedEntities, true);
});

busCenterBtn?.addEventListener('click', () => {
  if (selectedBusSnapshot) {
    centerMapOnEntity(selectedBusSnapshot, true);
    return;
  }

  if (trackedBusKey) {
    const tracked = lastMergedEntities.find((item) => getEntityKey(item) === trackedBusKey);
    if (tracked) {
      centerMapOnEntity(tracked, true);
    }
  }
});

busActionCloseBtn?.addEventListener('click', () => {
  closeBusActionCard();
});

streetViewCloseBtn?.addEventListener('click', () => {
  closeStreetViewPanel();
});

startupAlertCloseBtn?.addEventListener('click', () => {
  closeStartupAlertModal();
});

startupAlertModal?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  if (target.matches('[data-close-startup-alert="1"]')) {
    closeStartupAlertModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && startupAlertModal && !startupAlertModal.hidden) {
    closeStartupAlertModal();
  }
});

// Route option card clicks
routeOptionsList?.addEventListener('click', async (event) => {
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
    `Percorso selezionato: ${selected.transferCount > 0 ? `linee ${selected.routeId}->${selected.transferRouteId}` : `linea ${selected.routeId}`} - Partenza ${formatClockFromEta(selected.boardEtaSeconds)} - Arrivo ${formatClockFromEta(selected.destinationEtaSeconds)} - Totale ${formatDurationSeconds(selected.totalSeconds)}.`
  );
  renderNextJourneyTimes(selected);
});

// Destination stop select (hidden but used internally)
destinationStopSelect?.addEventListener('change', () => {
  const selected = destinationStopSelect.value;
  const location = stopLocationById.get(selected);
  if (location) {
    destinationPosition = { lat: location.lat, lon: location.lon };
    destinationSource = 'map';
    syncDestinationFromMapPoint();
  }

  if (routeAutoRefresh?.checked) {
    calculateRouteToSelectedStop();
  }
});

// Geocode search inputs with debounce
originSearchInput?.addEventListener('input', () => {
  scheduleSearch('origin', originSearchInput.value || '');
});

destinationSearchInput?.addEventListener('input', () => {
  scheduleSearch('destination', destinationSearchInput.value || '');
});

originSearchResults?.addEventListener('click', (event) => {
  const button = event.target.closest('.geocode-result-item[data-target="origin"]');
  if (!button) return;
  const index = Number(button.getAttribute('data-index'));
  const items = readRenderedSearchItems('origin');
  applyOriginSearchSelection(items[index]);
});

destinationSearchResults?.addEventListener('click', (event) => {
  const button = event.target.closest('.geocode-result-item[data-target="destination"]');
  if (!button) return;
  const index = Number(button.getAttribute('data-index'));
  const items = readRenderedSearchItems('destination');
  applyDestinationSearchSelection(items[index]);
});

// Close geocode dropdowns on outside click
document.addEventListener('click', (event) => {
  if (!event.target.closest('.input-field-wrap')) {
    hideSearchResults('origin');
    hideSearchResults('destination');
  }
});

recentDestinationsList?.addEventListener('click', (event) => {
  const chip = event.target.closest('.recent-destination-chip');
  if (!chip) {
    return;
  }

  const index = Number(chip.getAttribute('data-index'));
  const items = readRecentDestinations();
  applyRecentDestination(items[index]);
});

clearRecentDestinationsBtn?.addEventListener('click', () => {
  saveRecentDestinations([]);
  renderRecentDestinations();
});

// Mobile Bottom-Sheet Touch Drag

if (sheetHandle && searchCard) {
  let dragStartY = 0;
  let isDragging = false;

  sheetHandle.addEventListener('touchstart', (e) => {
    dragStartY = e.touches[0].clientY;
    isDragging = true;
    searchCard.style.transition = 'none';
  }, { passive: true });

  sheetHandle.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const deltaY = e.touches[0].clientY - dragStartY;
    if (deltaY > 0) {
      // Dragging down - offset the card
      searchCard.style.transform = `translateY(${deltaY}px)`;
    }
  }, { passive: true });

  sheetHandle.addEventListener('touchend', (e) => {
    if (!isDragging) return;
    isDragging = false;
    searchCard.style.transition = '';
    searchCard.style.transform = '';

    const deltaY = (e.changedTouches?.[0]?.clientY || 0) - dragStartY;
    if (deltaY > 80) {
      collapseSearchCard();
    } else if (deltaY < -40) {
      expandSearchCard();
    }
  }, { passive: true });

  // Tap the handle to toggle
  sheetHandle.addEventListener('click', () => {
    if (searchCard.classList.contains('is-collapsed')) {
      expandSearchCard();
    } else {
      collapseSearchCard();
    }
  });
}

// Override: Auto-collapse after route calculation

// Patch setRouteSummary to show summary wrap
const _originalSetRouteSummary = setRouteSummary;
// setRouteSummary is used as-is, but we hook into calculateRouteToSelectedStop's success path
// by patching the point where route is rendered. We do this by intercepting renderBusRouteOnMap calls.

// Patch: after renderBusRouteOnMap, collapse search card
const _originalRenderBusRouteOnMap = renderBusRouteOnMap;
// We can't reassign const, so we wrap via the existing flow.
// Instead, we hook the routeNowBtn click to collapse after completion - already done above.

// Initialization

// Show all buses on map (Zero-UI: no line filtering)
showAllOnMap = true;

loadSemaforiPreference();
syncSemaforiToggleUi();
loadSimulatedPreference();
syncSimulatedToggleUi();
renderRecentDestinations();
initMap();
enableSemaforiLayer();
openStartupAlertModal();
loadData();
startAutoRefresh();
