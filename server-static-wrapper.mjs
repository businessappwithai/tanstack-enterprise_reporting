import { serve } from 'bun';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';

const STATIC_DIR = resolve(process.cwd(), 'dist/client');
const PORT = process.env.PORT || 3000;

console.log(`[wrapper] Working directory: ${process.cwd()}`);
console.log(`[wrapper] Static dir: ${STATIC_DIR}`);

// Map of common MIME types
const MIME_TYPES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  // WebAssembly.compileStreaming / instantiateStreaming refuse anything else, so DuckDB WASM
  // (the Datasets page) never started when this fell through to application/octet-stream.
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain',
};

// Import the main server
const mainServer = (await import('./dist/server/server.js')).default;

// Create a wrapper server that handles static files
const server = serve({
  port: PORT,
  fetch: async (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle static assets (/assets/* -> dist/client/assets/*)
    if (pathname.startsWith('/assets/')) {
      // Remove leading slash to construct proper file path
      const relPath = pathname.substring(1); // /assets/file.js -> assets/file.js
      const filePath = resolve(STATIC_DIR, relPath); // /app/dist/client + assets/file.js -> /app/dist/client/assets/file.js

      console.log(`[static] Request: ${pathname}`);
      console.log(`[static] Rel path: ${relPath}`);
      console.log(`[static] Full path: ${filePath}`);
      console.log(`[static] Exists: ${existsSync(filePath)}`);

      // Security: ensure the file is within STATIC_DIR
      if (!filePath.startsWith(STATIC_DIR)) {
        console.log(`[static] Security check failed: ${filePath} not in ${STATIC_DIR}`);
        return new Response('Forbidden', { status: 403 });
      }

      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath);
          const ext = extname(filePath);
          const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

          return new Response(content, {
            status: 200,
            headers: {
              'Content-Type': mimeType,
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        } catch (error) {
          console.error(`[static] Error reading file ${filePath}:`, error);
          return new Response('Internal Server Error', { status: 500 });
        }
      }

      return new Response('Not Found', { status: 404 });
    }

    // Handle favicon and other public assets from /public
    if (pathname === '/favicon.ico' || pathname === '/icon.svg' || pathname.startsWith('/vs/')) {
      const publicPath = resolve(process.cwd(), 'public', pathname.replace(/^\//, ''));

      if (!publicPath.startsWith(resolve(process.cwd(), 'public'))) {
        return new Response('Forbidden', { status: 403 });
      }

      if (existsSync(publicPath)) {
        try {
          const content = readFileSync(publicPath);
          const ext = extname(publicPath);
          const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

          return new Response(content, {
            status: 200,
            headers: {
              'Content-Type': mimeType,
            },
          });
        } catch (error) {
          console.error(`[static] Error reading public file ${publicPath}:`, error);
          return new Response('Internal Server Error', { status: 500 });
        }
      }
    }

    // Default to the main server for all other routes
    return mainServer.fetch(request);
  },
});

console.log(`[server] Wrapper started on http://0.0.0.0:${PORT}`);
console.log(`[server] Static assets served from ${STATIC_DIR}/`);
console.log(`[server] Public files served from ${resolve(process.cwd(), 'public')}/`);
