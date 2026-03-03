function buildEmptyStopsPayload() {
  return {
    updatedAt: new Date().toISOString(),
    count: 0,
    stops: {},
    stopLocations: {}
  };
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const staticStopsUrl = new URL('/stops-data.json', url.origin).toString();

  try {
    const upstream = await fetch(staticStopsUrl, {
      cf: {
        cacheTtl: 300,
        cacheEverything: true
      }
    });

    if (!upstream.ok) {
      return new Response(JSON.stringify(buildEmptyStopsPayload()), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }

    const raw = await upstream.text();

    try {
      const parsed = JSON.parse(raw);
      return new Response(JSON.stringify(parsed), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    } catch {
      return new Response(JSON.stringify(buildEmptyStopsPayload()), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }
  } catch {
    return new Response(JSON.stringify(buildEmptyStopsPayload()), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    });
  }
}
