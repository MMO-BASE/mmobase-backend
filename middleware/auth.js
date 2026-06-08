const supabase = require('../config/supabase');

async function getAuthenticatedUser(req, res) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }

  const token = authHeader.replace('Bearer ', '');
  const userResult = await supabase.auth.getUser(token);
  const user = userResult && userResult.data ? userResult.data.user : null;

  if (!user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }

  return user;
}

async function getOwnedCharacter(userId, characterId) {
  const charResult = await supabase
    .from('eve_characters')
    .select('id, user_id, character_id, character_name, corporation_id, corporation_name, alliance_id, alliance_name, is_primary, portrait_url, affiliation_checked_at')
    .eq('character_id', characterId)
    .eq('user_id', userId)
    .single();

  return charResult.data || null;
}

module.exports = {
  getAuthenticatedUser,
  getOwnedCharacter
};
