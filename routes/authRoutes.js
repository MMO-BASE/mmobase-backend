const express = require('express');
const axios = require('axios');
const supabase = require('../config/supabase');
const {
  EVE_AUTH_URL,
  EVE_TOKEN_URL,
  EVE_VERIFY_URL,
  SCOPES
} = require('../config/eve');
const {
  createOAuthState,
  consumeOAuthState
} = require('../services/oauthStateService');
const { clearCharacterNeedsRelink } = require('../services/tokenStatusService');

const router = express.Router();

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://mmobase.co.uk';

router.get('/auth/eve', (req, res) => {
  const mmobaseToken = req.query.token;

  if (!mmobaseToken) {
    return res.redirect(FRONTEND_BASE_URL + '/dashboard?error=invalid_session');
  }

  const from = req.query.from === 'settings' ? 'settings' : 'dashboard';

  const state = createOAuthState({
    token: mmobaseToken,
    from: from
  });

  const authUrl = EVE_AUTH_URL +
    '?response_type=code' +
    '&redirect_uri=' + encodeURIComponent(process.env.EVE_CALLBACK_URL) +
    '&client_id=' + encodeURIComponent(process.env.EVE_CLIENT_ID) +
    '&scope=' + encodeURIComponent(SCOPES) +
    '&state=' + encodeURIComponent(state);

  res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect(FRONTEND_BASE_URL + '/dashboard?error=missing_code');
  }

  try {
    const stateData = consumeOAuthState(String(state || ''));

    if (!stateData || !stateData.token) {
      return res.redirect(FRONTEND_BASE_URL + '/dashboard?error=invalid_state');
    }

    const mmobaseToken = stateData.token;
    const userData = await supabase.auth.getUser(mmobaseToken);
    const user = userData && userData.data ? userData.data.user : null;

    if (!user) {
      return res.redirect(FRONTEND_BASE_URL + '/dashboard?error=invalid_session');
    }

    const tokenResponse = await axios.post(EVE_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: process.env.EVE_CLIENT_ID,
      client_secret: process.env.EVE_CLIENT_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const access_token = tokenResponse.data.access_token;
    const refresh_token = tokenResponse.data.refresh_token;
    const expires_in = tokenResponse.data.expires_in;

    const verifyResponse = await axios.get(EVE_VERIFY_URL, {
      headers: { Authorization: 'Bearer ' + access_token }
    });

    const characterId = verifyResponse.data.CharacterID;
    const characterName = verifyResponse.data.CharacterName;

    const charInfoResponse = await axios.get(
      'https://esi.evetech.net/latest/characters/' + characterId + '/?datasource=tranquility'
    );

    const corpId = charInfoResponse.data.corporation_id;

    let corpName = '';
    let allianceId = null;
    let allianceName = '';

    try {
      const corpResponse = await axios.get(
        'https://esi.evetech.net/latest/corporations/' + corpId + '/?datasource=tranquility'
      );

      corpName = corpResponse.data.name;
      allianceId = corpResponse.data.alliance_id || null;

      if (allianceId) {
        const allianceResponse = await axios.get(
          'https://esi.evetech.net/latest/alliances/' + allianceId + '/?datasource=tranquility'
        );
        allianceName = allianceResponse.data.name;
      }
    } catch (e) {}

    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
    const portraitUrl = 'https://images.evetech.net/characters/' + characterId + '/portrait?size=256';

    const existingCharResult = await supabase
      .from('eve_characters')
      .select('id, user_id')
      .eq('character_id', characterId)
      .single();

    const existingChar = existingCharResult.data;

    if (existingChar && existingChar.user_id !== user.id) {
      const alreadyLinkedRedirect = stateData.from === 'settings'
        ? '/settings?tab=linked&error=character_already_linked'
        : '/dashboard?error=character_already_linked';

      return res.redirect(FRONTEND_BASE_URL + alreadyLinkedRedirect);
    }

    if (existingChar) {
      await supabase
        .from('eve_characters')
        .update({
          character_name: characterName,
          corporation_id: corpId,
          corporation_name: corpName,
          alliance_id: allianceId,
          alliance_name: allianceName,
          portrait_url: portraitUrl
        })
        .eq('character_id', characterId);

      await supabase
        .from('eve_tokens')
        .update({
          access_token: access_token,
          refresh_token: refresh_token,
          expires_at: expiresAt,
          scopes: SCOPES,
          updated_at: new Date().toISOString()
        })
        .eq('character_id', characterId);
    } else {
      const existingCharsResult = await supabase
        .from('eve_characters')
        .select('id')
        .eq('user_id', user.id);

      const existingChars = existingCharsResult.data;
      const isPrimary = !existingChars || existingChars.length === 0;

      await supabase
        .from('eve_characters')
        .insert({
          user_id: user.id,
          character_id: characterId,
          character_name: characterName,
          corporation_id: corpId,
          corporation_name: corpName,
          alliance_id: allianceId,
          alliance_name: allianceName,
          is_primary: isPrimary,
          portrait_url: portraitUrl
        });

      await supabase
        .from('eve_tokens')
        .insert({
          character_id: characterId,
          access_token: access_token,
          refresh_token: refresh_token,
          token_type: 'Bearer',
          expires_at: expiresAt,
          scopes: SCOPES
        });
    }

    clearCharacterNeedsRelink(characterId);

    const redirectPage = stateData.from === 'settings' ? '/settings' : '/dashboard';
    const redirectQuery = stateData.from === 'settings'
      ? '?tab=linked&eve_linked=success&character='
      : '?eve_linked=success&character=';

    res.redirect(
      FRONTEND_BASE_URL + redirectPage +
      redirectQuery + encodeURIComponent(characterName)
    );
  } catch (error) {
    console.error(
      'EVE SSO Error:',
      error.response
        ? {
            status: error.response.status,
            url: error.config ? error.config.url : 'unknown',
            data: error.response.data
          }
        : error.message
    );

    res.redirect(FRONTEND_BASE_URL + '/dashboard?error=sso_failed');
  }
});

module.exports = router;
