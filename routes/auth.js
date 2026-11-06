const jwt = require('jsonwebtoken');
const config = require('../config/config');

const { resolveJwtSecret } = require('../config/jwtSecret');

const JWT_SECRET = resolveJwtSecret();

// JWT middleware to verify token
const authenticateJWT = (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const apiKey = req.headers['x-api-key'];

  if (apiKey && apiKey === process.env.API_KEY) {
    req.user = { apiKey: true };
    return next();
  }

  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired token' });
  }
};

const isAuthenticated = (req, res, next) => {
  const token = req.cookies.jwt || req.headers.authorization?.split(' ')[1];
  const apiKey = req.headers['x-api-key'];

  if (apiKey && apiKey === process.env.API_KEY) {
    req.user = { apiKey: true };
    return next();
  }

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.clearCookie('jwt');
    return res.redirect('/login');
  }
};

module.exports = { authenticateJWT, isAuthenticated };