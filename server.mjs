import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const PORT = process.env.PORT || 3000;
const FEED_URL = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/TripUpdates';
const VEHICLE_FEED_URL = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition';
const GTFS_STATIC_URL = 'https://www.amtabservizio.it/gtfs/google_transit.zip';
const STOPS_CACHE_MS = 30 * 60 * 1000;
const PLANNER_WALK_SPEED_MPS = 1.35;
const PLANNER_MAX_RESULTS = 20;

const gtfsCache = {
  expiresAt: 0,
  data: null
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    return { headers: [], rows: [] };
  }

  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const values = parseCsvLine(line);
    const row = {};

    for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
      row[headers[headerIndex]] = (values[headerIndex] || '').trim();
    }

    rows.push(row);
  }

  return { headers, rows };
}

function getZipEntryText(zip, fileName) {
  const direct = zip.getEntry(fileName);
  if (direct) {
    return zip.readAsText(direct);
  }

  const nested = zip.getEntries().find((entry) => entry.entryName.toLowerCase().endsWith(`/${fileName.toLowerCase()}`));
  if (!nested) {
    return '';
  }

  return zip.readAsText(nested);
}

function parseGtfsTimeToSeconds(time) {
  if (!time) {
    return NaN;
  }

  const parts = time.split(':').map((item) => Number(item));
  if (parts.length !== 3 || parts.some((item) => Number.isNaN(item))) {
    return NaN;
  }

  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatSecondsAsGtfs(seconds) {
  if (Number.isNaN(seconds)) {
    return 'n/d';
  }

  const safe = Math.max(0, Math.round(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getWeekdayName(dateValue = new Date()) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[dateValue.getDay()];
}

function getYmd(dateValue = new Date()) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function buildServiceSummary(serviceCalendar, calendarDates, serviceId, serviceDateYmd) {
  if (!serviceId) {
    return {
      serviceId: '',
      baseCalendar: null,
      dateExceptions: [],
      activeOnDate: null
    };
  }

  const baseCalendar = serviceCalendar.get(serviceId) || null;
  const exceptions = calendarDates.get(serviceId) || [];

  let activeOnDate = null;
  if (serviceDateYmd) {
    const exception = exceptions.find((item) => item.date === serviceDateYmd);
    if (exception) {
      activeOnDate = exception.exceptionType === '1';
    } else if (baseCalendar) {
      const serviceDateObj = new Date(
        Number(serviceDateYmd.slice(0, 4)),
        Number(serviceDateYmd.slice(4, 6)) - 1,
        Number(serviceDateYmd.slice(6, 8))
      );
      const dayName = getWeekdayName(serviceDateObj);
      const inRange = serviceDateYmd >= baseCalendar.startDate && serviceDateYmd <= baseCalendar.endDate;
      activeOnDate = inRange && baseCalendar.days[dayName] === true;
    }
  }

  return {
    serviceId,
    baseCalendar,
    dateExceptions: exceptions,
    activeOnDate
  };
}

function isServiceActiveOnDate(serviceCalendar, calendarDates, serviceId, serviceDateYmd) {
  if (!serviceId || !serviceDateYmd) {
    return true;
  }

  const exceptions = calendarDates.get(serviceId) || [];
  const exception = exceptions.find((item) => item.date === serviceDateYmd);
  if (exception) {
    return exception.exceptionType === '1';
  }

  const base = serviceCalendar.get(serviceId);
  if (!base) {
    return true;
  }

  if (serviceDateYmd < base.startDate || serviceDateYmd > base.endDate) {
    return false;
  }

  const serviceDateObj = new Date(
    Number(serviceDateYmd.slice(0, 4)),
    Number(serviceDateYmd.slice(4, 6)) - 1,
    Number(serviceDateYmd.slice(6, 8))
  );

  const dayName = getWeekdayName(serviceDateObj);
  return base.days[dayName] === true;
}

function toFutureDeltaFromGtfsSeconds(targetSeconds, nowSeconds, maxLookAheadSeconds) {
  if (Number.isNaN(targetSeconds)) {
    return NaN;
  }

  const delta = targetSeconds - nowSeconds;
  if (delta < -1800) {
    return NaN;
  }

  const nonNegative = Math.max(0, delta);
  if (nonNegative > maxLookAheadSeconds) {
    return NaN;
  }

  return nonNegative;
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

async function loadGtfsData() {
  const now = Date.now();
  if (gtfsCache.data && gtfsCache.expiresAt > now) {
    return gtfsCache.data;
  }

  const upstream = await fetch(GTFS_STATIC_URL, {
    headers: {
      Accept: 'application/zip,*/*'
    }
  });

  if (!upstream.ok) {
    throw new Error(`Errore GTFS statico: ${upstream.status}`);
  }

  const zipBuffer = Buffer.from(await upstream.arrayBuffer());
  const zip = new AdmZip(zipBuffer);

  const stopsRows = parseCsv(getZipEntryText(zip, 'stops.txt')).rows;
  const tripsRows = parseCsv(getZipEntryText(zip, 'trips.txt')).rows;
  const stopTimesRows = parseCsv(getZipEntryText(zip, 'stop_times.txt')).rows;
  const shapesRows = parseCsv(getZipEntryText(zip, 'shapes.txt')).rows;
  const calendarRows = parseCsv(getZipEntryText(zip, 'calendar.txt')).rows;
  const calendarDatesRows = parseCsv(getZipEntryText(zip, 'calendar_dates.txt')).rows;

  const stopsById = {};
  const stopLocationsById = {};
  for (const row of stopsRows) {
    if (!row.stop_id || !row.stop_name) {
      continue;
    }
    stopsById[row.stop_id] = row.stop_name;

    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      stopLocationsById[row.stop_id] = { lat, lon };
    }
  }

  const tripsByTripId = new Map();
  for (const row of tripsRows) {
    if (!row.trip_id) {
      continue;
    }

    tripsByTripId.set(row.trip_id, {
      tripId: row.trip_id,
      routeId: row.route_id || '',
      serviceId: row.service_id || '',
      shapeId: row.shape_id || '',
      tripHeadsign: row.trip_headsign || ''
    });
  }

  const stopTimesByTripId = new Map();
  const stopTimesByStopId = new Map();
  for (const row of stopTimesRows) {
    if (!row.trip_id) {
      continue;
    }

    const values = stopTimesByTripId.get(row.trip_id) || [];
    values.push({
      tripId: row.trip_id,
      stopId: row.stop_id || '',
      stopSequence: Number(row.stop_sequence),
      arrivalTime: row.arrival_time || '',
      departureTime: row.departure_time || ''
    });
    stopTimesByTripId.set(row.trip_id, values);

    if (row.stop_id) {
      const stopValues = stopTimesByStopId.get(row.stop_id) || [];
      stopValues.push({
        tripId: row.trip_id,
        stopSequence: Number(row.stop_sequence),
        arrivalTime: row.arrival_time || '',
        departureTime: row.departure_time || ''
      });
      stopTimesByStopId.set(row.stop_id, stopValues);
    }
  }

  for (const values of stopTimesByTripId.values()) {
    values.sort((left, right) => {
      const a = Number.isNaN(left.stopSequence) ? 0 : left.stopSequence;
      const b = Number.isNaN(right.stopSequence) ? 0 : right.stopSequence;
      return a - b;
    });
  }

  const shapesByShapeId = new Map();
  for (const row of shapesRows) {
    if (!row.shape_id) {
      continue;
    }

    const values = shapesByShapeId.get(row.shape_id) || [];
    values.push({
      lat: Number(row.shape_pt_lat),
      lon: Number(row.shape_pt_lon),
      sequence: Number(row.shape_pt_sequence)
    });
    shapesByShapeId.set(row.shape_id, values);
  }

  for (const values of shapesByShapeId.values()) {
    values.sort((left, right) => {
      const a = Number.isNaN(left.sequence) ? 0 : left.sequence;
      const b = Number.isNaN(right.sequence) ? 0 : right.sequence;
      return a - b;
    });
  }

  const calendarByServiceId = new Map();
  for (const row of calendarRows) {
    if (!row.service_id) {
      continue;
    }

    calendarByServiceId.set(row.service_id, {
      startDate: row.start_date || '',
      endDate: row.end_date || '',
      days: {
        monday: row.monday === '1',
        tuesday: row.tuesday === '1',
        wednesday: row.wednesday === '1',
        thursday: row.thursday === '1',
        friday: row.friday === '1',
        saturday: row.saturday === '1',
        sunday: row.sunday === '1'
      }
    });
  }

  const calendarDatesByServiceId = new Map();
  for (const row of calendarDatesRows) {
    if (!row.service_id || !row.date || !row.exception_type) {
      continue;
    }

    const values = calendarDatesByServiceId.get(row.service_id) || [];
    values.push({
      date: row.date,
      exceptionType: row.exception_type
    });
    calendarDatesByServiceId.set(row.service_id, values);
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    stopsById,
    stopLocationsById,
    tripsByTripId,
    stopTimesByTripId,
    stopTimesByStopId,
    shapesByShapeId,
    calendarByServiceId,
    calendarDatesByServiceId
  };

  gtfsCache.data = payload;
  gtfsCache.expiresAt = now + STOPS_CACHE_MS;
  return payload;
}

async function serveStatic(res, routePath) {
  const safePath = routePath === '/' ? '/index.html' : routePath;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, 'Forbidden');
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, mimeTypes[ext] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (requestUrl.pathname === '/api/tripupdates') {
      const upstream = await fetch(FEED_URL, {
        headers: {
          Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8'
        }
      });

      if (!upstream.ok) {
        send(res, upstream.status, `Errore feed remoto: ${upstream.status}`);
        return;
      }

      const xml = await upstream.text();
      send(res, 200, xml, 'application/xml; charset=utf-8');
      return;
    }

    if (requestUrl.pathname === '/api/vehicleposition') {
      const upstream = await fetch(VEHICLE_FEED_URL, {
        headers: {
          Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8'
        }
      });

      if (!upstream.ok) {
        send(res, upstream.status, `Errore feed remoto: ${upstream.status}`);
        return;
      }

      const xml = await upstream.text();
      send(res, 200, xml, 'application/xml; charset=utf-8');
      return;
    }

    if (requestUrl.pathname === '/api/stops') {
      const gtfs = await loadGtfsData();
      const data = {
        updatedAt: gtfs.updatedAt,
        count: Object.keys(gtfs.stopsById).length,
        stops: gtfs.stopsById,
        stopLocations: gtfs.stopLocationsById
      };
      send(res, 200, JSON.stringify(data), 'application/json; charset=utf-8');
      return;
    }

    if (requestUrl.pathname === '/api/tripdetails') {
      const routeId = requestUrl.searchParams.get('routeId') || '';
      const tripId = requestUrl.searchParams.get('tripId') || '';
      const currentStopId = requestUrl.searchParams.get('currentStopId') || '';
      const serviceDate = requestUrl.searchParams.get('serviceDate') || getYmd(new Date());
      const delaySeconds = Number(requestUrl.searchParams.get('delay') || 0);

      if (!tripId) {
        send(res, 400, JSON.stringify({ error: 'tripId mancante' }), 'application/json; charset=utf-8');
        return;
      }

      const gtfs = await loadGtfsData();
      const trip = gtfs.tripsByTripId.get(tripId);

      if (!trip) {
        send(res, 404, JSON.stringify({ error: 'Trip non trovato nel GTFS statico', tripId }), 'application/json; charset=utf-8');
        return;
      }

      if (routeId && trip.routeId && routeId !== trip.routeId) {
        send(res, 404, JSON.stringify({ error: 'Trip trovato ma routeId non coerente', tripId, routeId }), 'application/json; charset=utf-8');
        return;
      }

      const stopTimes = gtfs.stopTimesByTripId.get(tripId) || [];
      const stopTimeline = stopTimes.map((item) => {
        const arrivalSeconds = parseGtfsTimeToSeconds(item.arrivalTime);
        const predictedArrivalSeconds = Number.isNaN(arrivalSeconds) ? NaN : arrivalSeconds + delaySeconds;

        return {
          stopId: item.stopId,
          stopName: gtfs.stopsById[item.stopId] || item.stopId || '',
          stopSequence: item.stopSequence,
          arrivalTime: item.arrivalTime,
          departureTime: item.departureTime,
          predictedArrivalTime: formatSecondsAsGtfs(predictedArrivalSeconds)
        };
      });

      const shapePoints = (gtfs.shapesByShapeId.get(trip.shapeId) || []).map((item) => [item.lat, item.lon]);

      let currentIndex = -1;
      if (currentStopId) {
        currentIndex = stopTimeline.findIndex((item) => item.stopId === currentStopId);
      }

      if (currentIndex < 0 && stopTimeline.length) {
        const now = new Date();
        const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        const firstFuture = stopTimeline.findIndex((item) => {
          const arr = parseGtfsTimeToSeconds(item.arrivalTime);
          return !Number.isNaN(arr) && arr >= nowSeconds;
        });
        currentIndex = firstFuture >= 0 ? firstFuture : 0;
      }

      const upcomingStops = currentIndex >= 0 ? stopTimeline.slice(currentIndex, currentIndex + 8) : stopTimeline.slice(0, 8);
      const serviceSummary = buildServiceSummary(
        gtfs.calendarByServiceId,
        gtfs.calendarDatesByServiceId,
        trip.serviceId,
        serviceDate
      );

      const response = {
        routeId: trip.routeId,
        tripId,
        shapeId: trip.shapeId,
        serviceId: trip.serviceId,
        tripHeadsign: trip.tripHeadsign,
        currentStopId,
        delaySeconds,
        totalStops: stopTimeline.length,
        currentStopIndex: currentIndex,
        serviceSummary,
        upcomingStops,
        stopTimeline,
        shapePoints
      };

      send(res, 200, JSON.stringify(response), 'application/json; charset=utf-8');
      return;
    }

    if (requestUrl.pathname === '/api/plan') {
      const originLat = Number(requestUrl.searchParams.get('originLat'));
      const originLon = Number(requestUrl.searchParams.get('originLon'));
      const destinationStopId = requestUrl.searchParams.get('destinationStopId') || '';
      const destinationLat = Number(requestUrl.searchParams.get('destinationLat'));
      const destinationLon = Number(requestUrl.searchParams.get('destinationLon'));
      const maxWalkMeters = Number(requestUrl.searchParams.get('maxWalkMeters') || 500);
      const destinationRadiusMeters = Number(requestUrl.searchParams.get('destinationRadiusMeters') || 900);
      const maxLookAheadSeconds = Number(requestUrl.searchParams.get('maxLookAheadSeconds') || 5400);
      const allowTransfers = (requestUrl.searchParams.get('allowTransfers') || '0') === '1';
      const maxTransfers = Math.max(0, Math.min(1, Number(requestUrl.searchParams.get('maxTransfers') || 0)));
      const serviceDateYmd = requestUrl.searchParams.get('serviceDate') || getYmd(new Date());

      if (Number.isNaN(originLat) || Number.isNaN(originLon) || !destinationStopId) {
        send(
          res,
          400,
          JSON.stringify({ error: 'Parametri obbligatori mancanti: originLat, originLon, destinationStopId' }),
          'application/json; charset=utf-8'
        );
        return;
      }

      const gtfs = await loadGtfsData();
      const destinationLocation = gtfs.stopLocationsById[destinationStopId];
            const destinationTargetLocation =
              !Number.isNaN(destinationLat) && !Number.isNaN(destinationLon)
                ? { lat: destinationLat, lon: destinationLon }
                : destinationLocation;

      if (!destinationLocation) {
        send(res, 404, JSON.stringify({ error: 'Fermata destinazione senza coordinate', destinationStopId }), 'application/json; charset=utf-8');
        return;
      }

      const now = new Date();
      const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const minTransferSeconds = 90;

      const destinationAlternatives = Object.entries(gtfs.stopLocationsById)
        .filter(([stopId, location]) => {
          if (stopId === destinationStopId) {
            return true;
          }
          const distance = haversineMeters(destinationLocation.lat, destinationLocation.lon, location.lat, location.lon);
          return distance <= destinationRadiusMeters;
        })
        .map(([stopId]) => stopId);

      const destinationSet = new Set(destinationAlternatives);

      const nearbyOriginStops = Object.entries(gtfs.stopLocationsById)
        .map(([stopId, location]) => ({
          stopId,
          location,
          walkDistanceMeters: haversineMeters(originLat, originLon, location.lat, location.lon)
        }))
        .filter((item) => item.walkDistanceMeters <= maxWalkMeters)
        .sort((a, b) => a.walkDistanceMeters - b.walkDistanceMeters);

      const candidates = [];
      const transferCandidates = [];

      const makeDirectCandidate = (originStop, trip, board, destination, boardIndex, destinationIndex) => {
        const boardSeconds = parseGtfsTimeToSeconds(board.departureTime || board.arrivalTime);
        const destinationSeconds = parseGtfsTimeToSeconds(destination.arrivalTime || destination.departureTime);

        const boardEtaSeconds = toFutureDeltaFromGtfsSeconds(boardSeconds, nowSeconds, maxLookAheadSeconds);
        if (Number.isNaN(boardEtaSeconds)) {
          return null;
        }

        let rideSeconds = destinationSeconds - boardSeconds;
        if (Number.isNaN(rideSeconds) || rideSeconds < 0) {
          rideSeconds = (destinationIndex - boardIndex) * 120;
        }

        const walkSeconds = originStop.walkDistanceMeters / PLANNER_WALK_SPEED_MPS;
        if (boardEtaSeconds + 45 < walkSeconds) {
          return null;
        }

        const waitSeconds = Math.max(0, boardEtaSeconds - walkSeconds);
        const totalSeconds = walkSeconds + waitSeconds + rideSeconds;
        const destinationEtaSeconds = boardEtaSeconds + Math.max(0, rideSeconds);

        return {
          routeId: trip.routeId,
          tripId: trip.tripId,
          serviceId: trip.serviceId,
          tripHeadsign: trip.tripHeadsign,
          transferCount: 0,
          transferRouteId: '',
          transferStopId: '',
          transferStopName: '',
          boardStopId: originStop.stopId,
          boardStopName: gtfs.stopsById[originStop.stopId] || originStop.stopId,
          destinationStopId: destination.stopId,
          destinationStopName: gtfs.stopsById[destination.stopId] || destination.stopId,
          walkDistanceMeters: Math.round(originStop.walkDistanceMeters),
          walkSeconds: Math.round(walkSeconds),
          boardEtaSeconds,
          transferBoardEtaSeconds: null,
          destinationEtaSeconds,
          waitSeconds: Math.round(waitSeconds),
          rideSeconds: Math.round(rideSeconds),
          totalSeconds: Math.round(totalSeconds),
          stopsToTravel: Math.max(1, destinationIndex - boardIndex)
        };
      };

      const selectBestDestinationIndex = (timeline, startIndex) => {
        const destinationCandidates = [];

        for (let index = startIndex + 1; index < timeline.length; index += 1) {
          const stopId = timeline[index]?.stopId;
          if (!stopId || !destinationSet.has(stopId)) {
            continue;
          }

          const stopLoc = gtfs.stopLocationsById[stopId];
          const distanceToTarget = stopLoc
            ? haversineMeters(destinationTargetLocation.lat, destinationTargetLocation.lon, stopLoc.lat, stopLoc.lon)
            : Number.MAX_SAFE_INTEGER;

          destinationCandidates.push({
            index,
            stopId,
            exactMatch: stopId === destinationStopId,
            distanceToTarget
          });
        }

        if (!destinationCandidates.length) {
          return -1;
        }

        destinationCandidates.sort((a, b) => {
          if (a.exactMatch !== b.exactMatch) {
            return a.exactMatch ? -1 : 1;
          }
          if (a.distanceToTarget !== b.distanceToTarget) {
            return a.distanceToTarget - b.distanceToTarget;
          }
          return a.index - b.index;
        });

        return destinationCandidates[0].index;
      };

      for (const originStop of nearbyOriginStops) {
        const servicesFromStop = gtfs.stopTimesByStopId.get(originStop.stopId) || [];
        for (const service of servicesFromStop) {
          const trip = gtfs.tripsByTripId.get(service.tripId);
          if (!trip) {
            continue;
          }

          if (!isServiceActiveOnDate(gtfs.calendarByServiceId, gtfs.calendarDatesByServiceId, trip.serviceId, serviceDateYmd)) {
            continue;
          }

          const timeline = gtfs.stopTimesByTripId.get(service.tripId) || [];
          if (!timeline.length) {
            continue;
          }

          const boardIndex = timeline.findIndex(
            (item) => item.stopId === originStop.stopId && item.stopSequence === service.stopSequence
          );
          if (boardIndex < 0) {
            continue;
          }

          const destinationIndex = selectBestDestinationIndex(timeline, boardIndex);
          if (destinationIndex < 0) {
            continue;
          }

          const board = timeline[boardIndex];
          const destination = timeline[destinationIndex];
          const directCandidate = makeDirectCandidate(originStop, trip, board, destination, boardIndex, destinationIndex);
          if (directCandidate) {
            candidates.push(directCandidate);
          }

          if (!allowTransfers || maxTransfers < 1) {
            continue;
          }

          const boardSeconds = parseGtfsTimeToSeconds(board.departureTime || board.arrivalTime);
          const boardEtaSeconds = toFutureDeltaFromGtfsSeconds(boardSeconds, nowSeconds, maxLookAheadSeconds);
          if (Number.isNaN(boardEtaSeconds)) {
            continue;
          }

          const walkSeconds = originStop.walkDistanceMeters / PLANNER_WALK_SPEED_MPS;
          if (boardEtaSeconds + 45 < walkSeconds) {
            continue;
          }

          const waitFirstSeconds = Math.max(0, boardEtaSeconds - walkSeconds);
          const transferSearchMaxIndex = Math.min(timeline.length, boardIndex + 20);

          for (let transferIndex = boardIndex + 1; transferIndex < transferSearchMaxIndex; transferIndex += 1) {
            const transferStop = timeline[transferIndex];
            const transferStopId = transferStop.stopId;
            if (!transferStopId || destinationSet.has(transferStopId)) {
              continue;
            }

            const transferArrivalSeconds = parseGtfsTimeToSeconds(transferStop.arrivalTime || transferStop.departureTime);
            if (Number.isNaN(transferArrivalSeconds)) {
              continue;
            }

            let firstRideSeconds = transferArrivalSeconds - boardSeconds;
            if (Number.isNaN(firstRideSeconds) || firstRideSeconds < 0) {
              firstRideSeconds = Math.max(120, (transferIndex - boardIndex) * 120);
            }

            const arrivalTransferEtaSeconds = boardEtaSeconds + firstRideSeconds;
            if (arrivalTransferEtaSeconds > maxLookAheadSeconds) {
              continue;
            }

            const servicesAtTransfer = gtfs.stopTimesByStopId.get(transferStopId) || [];
            for (const transferService of servicesAtTransfer) {
              if (transferService.tripId === trip.tripId) {
                continue;
              }

              const transferTrip = gtfs.tripsByTripId.get(transferService.tripId);
              if (!transferTrip) {
                continue;
              }

              if (transferTrip.routeId === trip.routeId) {
                continue;
              }

              if (!isServiceActiveOnDate(gtfs.calendarByServiceId, gtfs.calendarDatesByServiceId, transferTrip.serviceId, serviceDateYmd)) {
                continue;
              }

              const transferTimeline = gtfs.stopTimesByTripId.get(transferService.tripId) || [];
              if (!transferTimeline.length) {
                continue;
              }

              const transferBoardIndex = transferTimeline.findIndex(
                (item) => item.stopId === transferStopId && item.stopSequence === transferService.stopSequence
              );
              if (transferBoardIndex < 0) {
                continue;
              }

              const transferDestinationIndex = selectBestDestinationIndex(transferTimeline, transferBoardIndex);
              if (transferDestinationIndex < 0) {
                continue;
              }

              const transferBoard = transferTimeline[transferBoardIndex];
              const transferDestination = transferTimeline[transferDestinationIndex];

              const transferBoardSeconds = parseGtfsTimeToSeconds(transferBoard.departureTime || transferBoard.arrivalTime);
              const transferBoardEtaSeconds = toFutureDeltaFromGtfsSeconds(
                transferBoardSeconds,
                nowSeconds,
                maxLookAheadSeconds
              );

              if (Number.isNaN(transferBoardEtaSeconds)) {
                continue;
              }

              if (transferBoardEtaSeconds < arrivalTransferEtaSeconds + minTransferSeconds) {
                continue;
              }

              const transferDestinationSeconds = parseGtfsTimeToSeconds(
                transferDestination.arrivalTime || transferDestination.departureTime
              );

              let secondRideSeconds = transferDestinationSeconds - transferBoardSeconds;
              if (Number.isNaN(secondRideSeconds) || secondRideSeconds < 0) {
                secondRideSeconds = Math.max(120, (transferDestinationIndex - transferBoardIndex) * 120);
              }

              const transferWaitSeconds = Math.max(0, transferBoardEtaSeconds - arrivalTransferEtaSeconds);
              const totalWaitSeconds = waitFirstSeconds + transferWaitSeconds;
              const totalRideSeconds = firstRideSeconds + secondRideSeconds;
              const totalSeconds = walkSeconds + totalWaitSeconds + totalRideSeconds;
              const destinationEtaSeconds = transferBoardEtaSeconds + Math.max(0, secondRideSeconds);

              transferCandidates.push({
                routeId: trip.routeId,
                tripId: `${trip.tripId}|${transferTrip.tripId}`,
                serviceId: trip.serviceId,
                tripHeadsign: trip.tripHeadsign,
                transferCount: 1,
                transferRouteId: transferTrip.routeId,
                transferStopId,
                transferStopName: gtfs.stopsById[transferStopId] || transferStopId,
                boardStopId: originStop.stopId,
                boardStopName: gtfs.stopsById[originStop.stopId] || originStop.stopId,
                destinationStopId: transferDestination.stopId,
                destinationStopName: gtfs.stopsById[transferDestination.stopId] || transferDestination.stopId,
                walkDistanceMeters: Math.round(originStop.walkDistanceMeters),
                walkSeconds: Math.round(walkSeconds),
                boardEtaSeconds,
                transferBoardEtaSeconds,
                destinationEtaSeconds,
                waitSeconds: Math.round(totalWaitSeconds),
                rideSeconds: Math.round(totalRideSeconds),
                totalSeconds: Math.round(totalSeconds),
                stopsToTravel: Math.max(2, (transferIndex - boardIndex) + (transferDestinationIndex - transferBoardIndex))
              });

              if (transferCandidates.length >= PLANNER_MAX_RESULTS * 8) {
                break;
              }
            }

            if (transferCandidates.length >= PLANNER_MAX_RESULTS * 8) {
              break;
            }
          }

          if (transferCandidates.length >= PLANNER_MAX_RESULTS * 8) {
            break;
          }
        }

        if (transferCandidates.length >= PLANNER_MAX_RESULTS * 8) {
          break;
        }
      }

      if (allowTransfers && maxTransfers > 0 && transferCandidates.length) {
        candidates.push(...transferCandidates);
      }

      candidates.sort((a, b) => {
        if (a.transferCount !== b.transferCount) {
          return a.transferCount - b.transferCount;
        }
        if (a.totalSeconds !== b.totalSeconds) {
          return a.totalSeconds - b.totalSeconds;
        }
        if (a.walkDistanceMeters !== b.walkDistanceMeters) {
          return a.walkDistanceMeters - b.walkDistanceMeters;
        }
        if (a.boardEtaSeconds !== b.boardEtaSeconds) {
          return a.boardEtaSeconds - b.boardEtaSeconds;
        }
        return a.stopsToTravel - b.stopsToTravel;
      });

      const deduped = [];
      const seen = new Set();
      for (const option of candidates) {
        const roundedDepartureBucket = Math.round((option.boardEtaSeconds || 0) / 60);
        const roundedTransferBucket = Math.round((option.transferBoardEtaSeconds || 0) / 60);
        const roundedArrivalBucket = Math.round((option.destinationEtaSeconds || 0) / 60);
        const roundedTotalBucket = Math.round((option.totalSeconds || 0) / 60);
        const key = [
          option.routeId,
          option.transferRouteId || '',
          option.boardStopId,
          option.destinationStopId,
          roundedDepartureBucket,
          roundedTransferBucket,
          roundedArrivalBucket,
          roundedTotalBucket
        ].join('__');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        deduped.push(option);
        if (deduped.length >= PLANNER_MAX_RESULTS) {
          break;
        }
      }

      const payload = {
        origin: { lat: originLat, lon: originLon },
        destinationStopId,
        destinationAlternativesCount: destinationAlternatives.length,
        nearbyOriginStopsCount: nearbyOriginStops.length,
        maxWalkMeters,
        maxLookAheadSeconds,
        allowTransfers,
        maxTransfers,
        options: deduped
      };

      send(res, 200, JSON.stringify(payload), 'application/json; charset=utf-8');
      return;
    }

    await serveStatic(res, requestUrl.pathname);
  } catch (error) {
    send(res, 500, `Errore server: ${error.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`MUVT AMTAB live: http://localhost:${PORT}`);
});