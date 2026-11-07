const http = require('http');
const path = require('path');
const fs = require('fs');
const { releaseMiddleware } = require('./security/releaseMiddleware.cjs');
const { isReleased, validateProductionReleaseConfig } = require('./security/releasePolicy.cjs');
const { validateProductionPasscode } = require('./security/passcodeManager.cjs');
const { validateProductionSessionSecret } = require('./security/sessionManager.cjs');
const { securityMiddleware } = require('./middleware.cjs');

// Fail-closed startup check in production
try {
  validateProductionReleaseConfig();
  validateProductionPasscode();
  validateProductionSessionSecret();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIST_DIR = path.join(__dirname, '..', 'dist');
const PROTECTED_DIST_DIR = path.join(__dirname, '..', 'storage', 'private_bundle');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // 1. Pass through time-locked release gate first
  releaseMiddleware(req, res, () => {
    // 2. Pass through photo security middleware
    securityMiddleware(req, res, () => {
      // 3. Static file delivery (Dual bundle: Public countdown before release, protected experience after release)
      const testClock = (process.env.NODE_ENV === 'test')
        ? (req.headers['x-test-clock'] || req.__testClock || null)
        : null;
      const released = isReleased(testClock);
      const activeDistDir = (released && fs.existsSync(PROTECTED_DIST_DIR))
        ? PROTECTED_DIST_DIR
        : PUBLIC_DIST_DIR;

      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let pathname = decodeURIComponent(urlObj.pathname);

      // Determine optimal Cache-Control:
      // - HTML entry documents MUST NEVER be cached to ensure instantaneous transition at release instant
      // - Protected content & post-release assets are strictly private, no-store
      // - Public hashed assets can use standard caching
      const isHtmlDoc = pathname.endsWith('.html') || pathname === '/' || pathname === '';
      let cacheControl = 'public, max-age=3600';
      if (isHtmlDoc || released) {
        cacheControl = 'private, no-store, max-age=0, must-revalidate';
      }

      // Normalize path to prevent directory traversal
      const safePath = path.normalize(path.join(activeDistDir, pathname));
      if (!safePath.startsWith(activeDistDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      let filePath = safePath;
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': cacheControl,
          'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      // SPA fallback to index.html in active dist directory
      const indexPath = path.join(activeDistDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': cacheControl,
          'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(indexPath).pipe(res);
        return;
      }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
});
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Application listening on http://localhost:${PORT}`);
  });
}

module.exports = { server };
