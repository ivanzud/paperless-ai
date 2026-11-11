'use strict';

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const { isAuthenticated } = require('./auth');

// Everything that is mounted in front of the main router, and therefore in
// front of its login check, is registered here so that it is easy to see (and
// to test) what a visitor without a login can reach: the style sheets, scripts
// and favicon the login page needs, and nothing else.

// Cross-origin access is off unless the operator names the origins that may
// call the API from a browser. Answering every origin, together with the
// private-network preflight header, allowed any web page open in a browser on
// the same network to read whatever this service handed out without a login.
function buildCorsOptions(env = process.env) {
  const origins = String(env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return {
    origin: origins.length > 0 ? origins : false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
    credentials: false
  };
}

function sendOpenApiSpec(res, swaggerSpec) {
  const openApiPath = path.join(process.cwd(), 'OPENAPI', 'openapi.json');
  res.setHeader('Content-Type', 'application/json');

  // Try to serve the static file first
  fs.readFile(openApiPath)
    .then(data => {
      res.send(JSON.parse(data));
    })
    .catch(err => {
      console.warn('Error reading OpenAPI file, generating dynamically:', err.message);
      // Fallback to generating the spec if file can't be read
      res.send(swaggerSpec);
    });
}

function registerStaticAndDocs(app, { publicDir, swaggerSpec }) {
  // The login check below reads the session cookie.
  app.use(cookieParser());

  // Document thumbnails were once cached in public/images. They live in the
  // data directory now, but a directory left over from an older version must
  // not be handed out by the static middleware.
  app.use('/images', isAuthenticated);
  app.use(express.static(publicDir));

  // The API description lists every route and schema of the service and is
  // of no use without a login.
  app.get('/api-docs/openapi.json', isAuthenticated, (req, res) => sendOpenApiSpec(res, swaggerSpec));

  // Old endpoint, kept for backward compatibility
  app.get('/api-docs.json', isAuthenticated, (req, res) => sendOpenApiSpec(res, swaggerSpec));

  // Swagger documentation route (mounted after JSON endpoints)
  app.use('/api-docs', isAuthenticated, swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: {
      url: '/api-docs/openapi.json'
    }
  }));
}

module.exports = { buildCorsOptions, registerStaticAndDocs };
