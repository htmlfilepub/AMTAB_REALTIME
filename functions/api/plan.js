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

export async function onRequestGet(context) {
  try {
    const requestUrl = new URL(context.request.url);

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
    const DEDUP_BUCKET_SECONDS = 180; // 3-minute window
    for (const option of candidates) {
      const roundedDepartureBucket = Math.floor((option.boardEtaSeconds || 0) / DEDUP_BUCKET_SECONDS);
      const roundedTransferBucket = Math.floor((option.transferBoardEtaSeconds || 0) / DEDUP_BUCKET_SECONDS);
      const roundedArrivalBucket = Math.floor((option.destinationEtaSeconds || 0) / DEDUP_BUCKET_SECONDS);
      const roundedTotalBucket = Math.floor((option.totalSeconds || 0) / DEDUP_BUCKET_SECONDS);
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
