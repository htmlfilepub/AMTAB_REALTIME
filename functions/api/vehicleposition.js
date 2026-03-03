export async function onRequestGet() {
  const upstreamUrl = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition';

  const upstream = await fetch(upstreamUrl, {
    headers: {
      Accept: 'application/xml,text/xml,*/*'
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false
    }
  });

  if (!upstream.ok) {
    return new Response(`Errore feed remoto: ${upstream.status}`, {
      status: upstream.status
    });
  }

  const xml = await upstream.text();
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}