import {
  getYmd,
  haversineMeters,
  isServiceActiveOnDate,
  loadGtfsData,
  parseGtfsTimeToSeconds,
  toFutureDeltaFromGtfsSeconds
} from './_gtfs.js';

const PLANNER_WALK_SPEED_MPS = 1.35;
const PLANNER_MAX_RESULTS = 20;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function makeDirectCandidate({ originStop, trip, board, destination, boardIndex, destinationIndex, nowSeconds, maxLookAheadSeconds }) {
  const boardSeconds = parseGtfsTimeToSeconds(board.departureTime || board.arrivalTime);
  const destinationSeconds = parseGtfsTimeToSeconds(destination.arrivalTime || destination.departureTime);

  const boardEtaSeconds = toFutureDeltaFromGtfsSeconds(boardSeconds, nowSeconds, maxLookAheadSeconds);
  if (Number.isNaN(boardEtaSeconds)) {
    return null;
  }

  let rideSeconds = destinationSeconds - boardSeconds;
  if (Number.isNaN(rideSeconds) || rideSeconds < 0) {
    rideSeconds = 0;
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
    transferCount: 0,
    transferRouteId: '',
    transferStopId: '',
    transferStopName: '',
    transferStopLocation: null,
    transferBoardEtaSeconds: null,
    destinationStopId: destination.stopId,
    destinationStopName: destination.stopName,
    destinationStopLocation: destination.stopLocation,
    boardStopId: board.stopId,
    boardStopName: board.stopName,
    boardStopLocation: board.stopLocation,
    boardEtaSeconds,
    destinationEtaSeconds,
    walkDistanceMeters: originStop.walkDistanceMeters,
    walkSeconds,
    waitSeconds,
    rideSeconds,
    totalSeconds,
    stopsToTravel: Math.max(0, destinationIndex - boardIndex),
    vehicleId: '',
    _sortBoard: boardEtaSeconds
  };
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const originLat = Number(url.searchParams.get('originLat'));
    const originLon = Number(url.searchParams.get('originLon'));
    const destinationStopId = url.searchParams.get('destinationStopId') || '';
    const destinationLat = Number(url.searchParams.get('destinationLat'));
    const destinationLon = Number(url.searchParams.get('destinationLon'));
    const maxWalkMeters = Number(url.searchParams.get('maxWalkMeters') || 500);
    const destinationRadiusMeters = Number(url.searchParams.get('destinationRadiusMeters') || 900);
    const maxLookAheadSeconds = Number(url.searchParams.get('maxLookAheadSeconds') || 5400);
    const allowTransfers = (url.searchParams.get('allowTransfers') || '0') === '1';
    const maxTransfers = Math.max(0, Math.min(1, Number(url.searchParams.get('maxTransfers') || 0)));
    const serviceDateYmd = url.searchParams.get('serviceDate') || getYmd(new Date());

    if (Number.isNaN(originLat) || Number.isNaN(originLon) || !destinationStopId) {
      return json({ error: 'Parametri obbligatori mancanti: originLat, originLon, destinationStopId' }, 400);
    }

    const gtfs = await loadGtfsData();
    const destinationLocation = gtfs.stopLocationsById[destinationStopId];
    const destinationTargetLocation =
      !Number.isNaN(destinationLat) && !Number.isNaN(destinationLon)
        ? { lat: destinationLat, lon: destinationLon }
        : destinationLocation;

    if (!destinationLocation) {
      return json({ error: 'Fermata destinazione senza coordinate', destinationStopId }, 404);
    }

    const now = new Date();
    const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

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

    const selectBestDestinationIndex = (timeline, startIndex) => {
      let exactIndex = -1;
      let bestNear = { index: -1, distance: Number.MAX_SAFE_INTEGER };

      for (let index = startIndex + 1; index < timeline.length; index += 1) {
        const row = timeline[index];
        if (!destinationSet.has(row.stopId)) {
          continue;
        }

        if (row.stopId === destinationStopId && exactIndex < 0) {
          exactIndex = index;
          break;
        }

        const location = gtfs.stopLocationsById[row.stopId];
        if (location && destinationTargetLocation) {
          const distance = haversineMeters(location.lat, location.lon, destinationTargetLocation.lat, destinationTargetLocation.lon);
          if (distance < bestNear.distance) {
            bestNear = { index, distance };
          }
        } else if (bestNear.index < 0) {
          bestNear = { index, distance: bestNear.distance };
        }
      }

      if (exactIndex >= 0) {
        return exactIndex;
      }

      return bestNear.index;
    };

    for (const originStop of nearbyOriginStops) {
      const departingTrips = gtfs.stopTimesByStopId.get(originStop.stopId) || [];

      for (const departure of departingTrips) {
        const trip = gtfs.tripsByTripId.get(departure.tripId);
        if (!trip) {
          continue;
        }

        if (!isServiceActiveOnDate(gtfs.calendarByServiceId, gtfs.calendarDatesByServiceId, trip.serviceId, serviceDateYmd)) {
          continue;
        }

        const timeline = gtfs.stopTimesByTripId.get(departure.tripId) || [];
        const boardIndex = timeline.findIndex((item) => item.stopId === originStop.stopId && item.stopSequence === departure.stopSequence);
        if (boardIndex < 0) {
          continue;
        }

        const destinationIndex = selectBestDestinationIndex(timeline, boardIndex);
        if (destinationIndex < 0) {
          continue;
        }

        const board = timeline[boardIndex];
        const destination = timeline[destinationIndex];
        const boardLocation = gtfs.stopLocationsById[board.stopId] || originStop.location;
        const destinationStopLocation = gtfs.stopLocationsById[destination.stopId] || destinationLocation;

        const candidate = makeDirectCandidate({
          originStop,
          trip,
          board: {
            ...board,
            stopName: gtfs.stopsById[board.stopId] || board.stopId,
            stopLocation: boardLocation
          },
          destination: {
            ...destination,
            stopName: gtfs.stopsById[destination.stopId] || destination.stopId,
            stopLocation: destinationStopLocation
          },
          boardIndex,
          destinationIndex,
          nowSeconds,
          maxLookAheadSeconds
        });

        if (candidate) {
          candidates.push(candidate);
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.transferCount !== b.transferCount) {
        return a.transferCount - b.transferCount;
      }
      if (a.totalSeconds !== b.totalSeconds) {
        return a.totalSeconds - b.totalSeconds;
      }
      if (a._sortBoard !== b._sortBoard) {
        return a._sortBoard - b._sortBoard;
      }
      return (a.routeId || '').localeCompare(b.routeId || '', 'it-IT');
    });

    const deduped = [];
    const seen = new Set();
    for (const option of candidates) {
      const dedupKey = [
        option.routeId,
        option.boardStopId,
        option.destinationStopId,
        Math.round((option.boardEtaSeconds || 0) / 120)
      ].join('|');

      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      deduped.push(option);

      if (deduped.length >= PLANNER_MAX_RESULTS) {
        break;
      }
    }

    return json({
      origin: { lat: originLat, lon: originLon },
      destinationStopId,
      destinationAlternativesCount: destinationAlternatives.length,
      nearbyOriginStopsCount: nearbyOriginStops.length,
      maxWalkMeters,
      maxLookAheadSeconds,
      allowTransfers,
      maxTransfers,
      options: deduped
    });
  } catch (error) {
    return json({ error: `Errore server: ${error.message}` }, 500);
  }
}
