const crypto = require('crypto');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStateStore = new Map();

function createOAuthState(data) {
  const state = crypto.randomBytes(32).toString('hex');

  oauthStateStore.set(state, {
    ...data,
    createdAt: Date.now()
  });

  return state;
}

function consumeOAuthState(state) {
  if (!state || !oauthStateStore.has(state)) return null;

  const data = oauthStateStore.get(state);
  oauthStateStore.delete(state);

  if (!data || Date.now() - data.createdAt > OAUTH_STATE_TTL_MS) {
    return null;
  }

  return data;
}

function cleanupExpiredOAuthStates() {
  const now = Date.now();

  for (const [state, data] of oauthStateStore.entries()) {
    if (!data || now - data.createdAt > OAUTH_STATE_TTL_MS) {
      oauthStateStore.delete(state);
    }
  }
}

setInterval(cleanupExpiredOAuthStates, OAUTH_STATE_TTL_MS);

module.exports = {
  createOAuthState,
  consumeOAuthState
};
