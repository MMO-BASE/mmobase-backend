const express = require('express');
const supabase = require('../config/supabase');
const { deleteWalletSnapshotsForUser } = require('../services/walletService');

const router = express.Router();

router.delete('/', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const userResult = await supabase.auth.getUser(token);
    const user = userResult && userResult.data ? userResult.data.user : null;

    if (!user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const charactersResult = await supabase
      .from('eve_characters')
      .select('character_id')
      .eq('user_id', user.id);

    if (charactersResult.error) {
      throw new Error('Failed to read linked characters: ' + charactersResult.error.message);
    }

    const characterIds = (charactersResult.data || [])
      .map(row => row.character_id)
      .filter(Boolean);

    async function runDelete(label, query) {
      const result = await query;

      if (result.error) {
        throw new Error(label + ': ' + result.error.message);
      }
    }

    if (characterIds.length > 0) {
      await runDelete(
        'Failed to delete EVE tokens',
        supabase.from('eve_tokens').delete().in('character_id', characterIds)
      );
    }

    await runDelete(
      'Failed to delete asset snapshots',
      supabase.from('asset_value_snapshots').delete().eq('user_id', user.id)
    );

    await runDelete(
      'Failed to delete EVE characters',
      supabase.from('eve_characters').delete().eq('user_id', user.id)
    );

    await runDelete(
      'Failed to delete profile',
      supabase.from('profiles').delete().eq('id', user.id)
    );

    try {
      deleteWalletSnapshotsForUser(user.id);
    } catch (e) {
      console.error('Failed to clean wallet snapshots during account deletion:', e.message);
    }

    const deleteUserResult = await supabase.auth.admin.deleteUser(user.id);

    if (deleteUserResult.error) {
      throw new Error('Failed to delete auth user: ' + deleteUserResult.error.message);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Delete account failed:', error.message);
    return res.status(500).json({ error: 'Account deletion failed. Please contact support.' });
  }
});

module.exports = router;
