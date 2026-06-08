const express = require('express');
const supabase = require('../config/supabase');
const { getAuthenticatedUser } = require('../middleware/auth');
const { getTokenStatusMap } = require('../services/tokenStatusService');

const router = express.Router();

router.get('/', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return;

  const charsResult = await supabase
    .from('eve_characters')
    .select('*')
    .eq('user_id', user.id)
    .order('is_primary', { ascending: false });

  const characters = charsResult.data || [];
  const tokenStatusMap = getTokenStatusMap();

  const characterIds = characters.map(c => c.character_id).filter(Boolean);
  let tokenRows = [];

  if (characterIds.length > 0) {
    const tokenResult = await supabase
      .from('eve_tokens')
      .select('character_id, refresh_token, expires_at')
      .in('character_id', characterIds);

    tokenRows = tokenResult.data || [];
  }

  const tokensByCharacterId = {};

  for (const token of tokenRows) {
    tokensByCharacterId[String(token.character_id)] = token;
  }

  const decoratedCharacters = characters.map(character => {
    const key = String(character.character_id);
    const token = tokensByCharacterId[key];
    const savedStatus = tokenStatusMap[key];

    const needsRelink = Boolean(
      savedStatus && savedStatus.needs_relink === true
    ) || !token || !token.refresh_token;

    return {
      ...character,
      needs_relink: needsRelink,
      token_status: needsRelink ? 'needs_relink' : 'ok',
      token_status_reason: savedStatus ? savedStatus.reason : null
    };
  });

  res.json({ characters: decoratedCharacters });
});

router.delete('/:characterId', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return;

  const characterId = String(req.params.characterId || '').trim();

  if (!characterId) {
    return res.status(400).json({ error: 'Missing character id' });
  }

  const charResult = await supabase
    .from('eve_characters')
    .select('id, character_id, character_name, user_id')
    .eq('character_id', characterId)
    .eq('user_id', user.id)
    .single();

  if (charResult.error || !charResult.data) {
    return res.status(404).json({ error: 'Character not found for this account' });
  }

  const tokenDelete = await supabase
    .from('eve_tokens')
    .delete()
    .eq('character_id', characterId);

  if (tokenDelete.error) {
    console.error('Failed to delete EVE token:', tokenDelete.error);
    return res.status(500).json({ error: 'Failed to remove EVE token' });
  }

  const characterDelete = await supabase
    .from('eve_characters')
    .delete()
    .eq('character_id', characterId)
    .eq('user_id', user.id);

  if (characterDelete.error) {
    console.error('Failed to delete EVE character:', characterDelete.error);
    return res.status(500).json({ error: 'Failed to remove EVE character' });
  }

  res.json({ ok: true, character_id: characterId });
});

module.exports = router;
