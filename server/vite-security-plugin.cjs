/**
 * Vite build and dev security plugin.
 * Plugs the authenticated image delivery and session management
 * into both Vite dev server and Vite preview server.
 */
function pinkverseSecurityPlugin() {
  return {
    name: 'vite-security-plugin',
    apply: 'serve',
    configureServer(server) {
      const { releaseMiddleware } = require('./security/releaseMiddleware.cjs');
      const { securityMiddleware } = require('./middleware.cjs');
      server.middlewares.use(releaseMiddleware);
      server.middlewares.use(securityMiddleware);
    },
    configurePreviewServer(server) {
      const { releaseMiddleware } = require('./security/releaseMiddleware.cjs');
      const { securityMiddleware } = require('./middleware.cjs');
      server.middlewares.use(releaseMiddleware);
      server.middlewares.use(securityMiddleware);
    },
  };
}

module.exports = {
  pinkverseSecurityPlugin,
};
