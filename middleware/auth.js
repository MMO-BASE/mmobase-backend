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
    .select('*')
    .eq('character_id', characterId)
    .eq('user_id', userId)
    .single();

  return charResult.data || null;
}

module.exports = {
  getAuthenticatedUser,
  getOwnedCharacter
};
