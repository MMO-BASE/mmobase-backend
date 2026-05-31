const fs = require('fs');
const path = require('path');

const TOKEN_STATUS_FILE = path.join(__dirname, '..', 'eve_token_status.json');

function readTokenStatusStore() {
  try {
    if (!fs.existsSync(TOKEN_STATUS_FILE)) return {};
    const raw = fs.readFileSync(TOKEN_STATUS_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('Failed to read EVE token status store:', e.message);
    return {};
  }
}

function writeTokenStatusStore(store) {
  try {
    fs.writeFileSync(TOKEN_STATUS_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Failed to write EVE token status store:', e.message);
  }
}

function isEveInvalidGrantError(error) {
  const data = error && error.response ? error.response.data : null;
  return Boolean(
    data &&
    data.error === 'invalid_grant'
  );
}

function markCharacterNeedsRelink(characterId, reason) {
  const store = readTokenStatusStore();
  const key = String(characterId);

  const alreadyMarked = store[key] && store[key].needs_relink === true;

  store[key] = {
    character_id: Number(characterId),
    needs_relink: true,
    token_status: 'needs_relink',
    reason: reason || 'invalid_grant',
    updated_at: new Date().toISOString()
  };

  writeTokenStatusStore(store);

  return !alreadyMarked;
}

function clearCharacterNeedsRelink(characterId) {
  const store = readTokenStatusStore();
  const key = String(characterId);

  if (store[key]) {
    delete store[key];
    writeTokenStatusStore(store);
    return true;
  }

  return false;
}

function getTokenStatusMap() {
  return readTokenStatusStore();
}

module.exports = {
  isEveInvalidGrantError,
  markCharacterNeedsRelink,
  clearCharacterNeedsRelink,
  getTokenStatusMap
};
