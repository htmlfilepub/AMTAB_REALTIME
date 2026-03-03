import JSZip from 'jszip';

const GTFS_STATIC_URL = 'https://www.amtabservizio.it/gtfs/google_transit.zip';
const STOPS_CACHE_MS = 30 * 60 * 1000;

const gtfsCache = {
  expiresAt: 0,
  data: null
};

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

async function getZipEntryText(zip, fileName) {
  const direct = zip.file(fileName);
  if (direct) {
    return direct.async('string');
  }

  const nestedName = Object.keys(zip.files).find((entryName) => entryName.toLowerCase().endsWith(`/${fileName.toLowerCase()}`));
  if (!nestedName) {
    return '';
  }

  return zip.file(nestedName).async('string');
}

export function parseGtfsTimeToSeconds(time) {
  if (!time) {
    return NaN;
  }

  const parts = time.split(':').map((item) => Number(item));
  if (parts.length !== 3 || parts.some((item) => Number.isNaN(item))) {
    return NaN;
  }

  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function formatSecondsAsGtfs(seconds) {
  if (Number.isNaN(seconds)) {
    return 'n/d';
  }

  const safe = Math.max(0, Math.round(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function getWeekdayName(dateValue = new Date()) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return days[dateValue.getDay()];
}

export function getYmd(dateValue = new Date()) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
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

export function toFutureDeltaFromGtfsSeconds(targetSeconds, nowSeconds, maxLookAheadSeconds) {
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

export function isServiceActiveOnDate(serviceCalendar, calendarDates, serviceId, serviceDateYmd) {
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

export function buildServiceSummary(serviceCalendar, calendarDates, serviceId, serviceDateYmd) {
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

export async function loadGtfsData() {
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

  const zipBuffer = await upstream.arrayBuffer();
  const zip = await JSZip.loadAsync(zipBuffer);

  const stopsRows = parseCsv(await getZipEntryText(zip, 'stops.txt')).rows;
  const tripsRows = parseCsv(await getZipEntryText(zip, 'trips.txt')).rows;
  const stopTimesRows = parseCsv(await getZipEntryText(zip, 'stop_times.txt')).rows;
  const shapesRows = parseCsv(await getZipEntryText(zip, 'shapes.txt')).rows;
  const calendarRows = parseCsv(await getZipEntryText(zip, 'calendar.txt')).rows;
  const calendarDatesRows = parseCsv(await getZipEntryText(zip, 'calendar_dates.txt')).rows;

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
