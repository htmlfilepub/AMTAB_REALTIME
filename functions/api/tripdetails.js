import {
  buildServiceSummary,
  formatSecondsAsGtfs,
  getYmd,
  loadGtfsData,
  parseGtfsTimeToSeconds
} from './_gtfs.js';

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
    const url = new URL(context.request.url);
    const routeId = url.searchParams.get('routeId') || '';
    const tripId = url.searchParams.get('tripId') || '';
    const currentStopId = url.searchParams.get('currentStopId') || '';
    const serviceDate = url.searchParams.get('serviceDate') || getYmd(new Date());
    const delaySeconds = Number(url.searchParams.get('delay') || 0);

    if (!tripId) {
      return json({ error: 'tripId mancante' }, 400);
    }

    const gtfs = await loadGtfsData();
    const trip = gtfs.tripsByTripId.get(tripId);

    if (!trip) {
      return json({ error: 'Trip non trovato nel GTFS statico', tripId }, 404);
    }

    if (routeId && trip.routeId && routeId !== trip.routeId) {
      return json({ error: 'Trip trovato ma routeId non coerente', tripId, routeId }, 404);
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

    return json({
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
    });
  } catch (error) {
    return json({ error: `Errore server: ${error.message}` }, 500);
  }
}
