import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 3000;
const FEED_URL = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/TripUpdates';
const VEHICLE_FEED_URL = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition';

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

    await serveStatic(res, requestUrl.pathname);
  } catch (error) {
    send(res, 500, `Errore server: ${error.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`MUVT AMTAB live: http://localhost:${PORT}`);
});