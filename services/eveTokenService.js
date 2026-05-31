const axios = require('axios');
const supabase = require('../config/supabase');
const { EVE_TOKEN_URL } = require('../config/eve');
const {
  isEveInvalidGrantError,
  markCharacterNeedsRelink
} = require('./tokenStatusService');

async function getFreshAccessTokenForCharacter(characterId) {
  const tokenResult = await supabase
    .from('eve_tokens')
    .select('*')
    .eq('character_id', characterId)
    .single();

  const tokenData = tokenResult.data;
  if (!tokenData) return null;

  let accessToken = tokenData.access_token;

  if (new Date(tokenData.expires_at) < new Date()) {
    try {
      const refreshResponse = await axios.post(EVE_TOKEN_URL, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refresh_token,
        client_id: process.env.EVE_CLIENT_ID,
        client_secret: process.env.EVE_CLIENT_SECRET
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

      accessToken = refreshResponse.data.access_token;
      const newExpiresAt = new Date(Date.now() + refreshResponse.data.expires_in * 1000).toISOString();

      await supabase
        .from('eve_tokens')
        .update({
          access_token: accessToken,
          refresh_token: refreshResponse.data.refresh_token,
          expires_at: newExpiresAt,
          updated_at: new Date().toISOString()
        })
        .eq('character_id', characterId);
    } catch (e) {
      if (isEveInvalidGrantError(e)) {
        const firstMark = markCharacterNeedsRelink(characterId, 'invalid_grant');

        if (firstMark) {
          console.log('EVE refresh token expired/revoked for character ' + characterId + '. Marked as needing re-link.');
        }

        return null;
      }

      console.error('EVE token refresh failed for character ' + characterId + ':', e.response ? e.response.data : e.message);
      return null;
    }
  }

  return accessToken;
}

module.exports = {
  getFreshAccessTokenForCharacter
};
