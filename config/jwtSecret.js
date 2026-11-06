const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Resolve the key that signs login cookies. Falling back to a fixed default let
// anyone forge a session whenever JWT_SECRET was unset, so a missing secret is
// now generated once and kept next to the .env in the data directory.
function resolveJwtSecret(dataDir = path.join(decodeURIComponent(process.cwd()), 'data')) {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  const secretPath = path.join(dataDir, '.jwt_secret');
  let secret = '';
  try {
    secret = fs.readFileSync(secretPath, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (!secret) {
    secret = crypto.randomBytes(64).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  }

  // Setup saves process.env.JWT_SECRET into .env; keep it the key in use.
  process.env.JWT_SECRET = secret;
  return secret;
}

module.exports = { resolveJwtSecret };
