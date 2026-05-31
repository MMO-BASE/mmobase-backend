const axios = require('axios');
const supabase = require('../config/supabase');
const { getFreshAccessTokenForCharacter } = require('../services/eveTokenService');
const { fetchAllCharacterAssets, calculateAssetSummary } = require('../services/assetService');
const { calculateWalletSummary } = require('../services/walletService');

async function snapshotAssetsForCharacter(character) {
  try {
    const accessToken = await getFreshAccessTokenForCharacter(character.character_id);
    if (!accessToken) return;

    const assetRows = await fetchAllCharacterAssets(
      character.character_id,
      { Authorization: 'Bearer ' + accessToken }
    );

    let currentShip = null;

    try {
      const shipResp = await axios.get(
        'https://esi.evetech.net/latest/characters/' + character.character_id + '/ship/?datasource=tranquility',
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );

      currentShip = shipResp.data;
    } catch (e) { }

    await calculateAssetSummary(character.user_id, character.character_id, assetRows || [], currentShip, accessToken);
    console.log('Saved daily asset snapshot for ' + (character.character_name || character.character_id));
  } catch (e) {
    console.error('Failed daily asset snapshot for character ' + character.character_id + ':', e.response ? e.response.data : e.message);
  }
}

async function snapshotWalletForCharacter(character) {
  try {
    const accessToken = await getFreshAccessTokenForCharacter(character.character_id);
    if (!accessToken) return;

    const resp = await axios.get(
      'https://esi.evetech.net/latest/characters/' + character.character_id + '/wallet/?datasource=tranquility',
      { headers: { Authorization: 'Bearer ' + accessToken }, timeout: 15000 }
    );

    await calculateWalletSummary(character.user_id, character.character_id, resp.data);
    console.log('Saved daily wallet snapshot for ' + (character.character_name || character.character_id));
  } catch (e) {
    console.error('Failed daily wallet snapshot for character ' + character.character_id + ':', e.response ? e.response.data : e.message);
  }
}

async function runDailyAssetSnapshots() {
  console.log('Starting daily asset snapshots...');

  try {
    const charsResult = await supabase
      .from('eve_characters')
      .select('user_id, character_id, character_name')
      .order('character_id', { ascending: true });

    const characters = charsResult.data || [];

    for (const character of characters) {
      await snapshotAssetsForCharacter(character);
      await snapshotWalletForCharacter(character);

      // Be gentle with ESI/Fuzzwork rate limits.
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    console.log('Daily asset snapshots complete. Characters processed: ' + characters.length);
  } catch (e) {
    console.error('Daily asset snapshot job failed:', e.message);
  }
}

function scheduleDailyAssetSnapshots() {
  const now = new Date();
  const next = new Date();

  next.setUTCHours(3, 15, 0, 0); // 03:15 UTC daily
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);

  const delay = next.getTime() - now.getTime();
  console.log('Next daily asset snapshot scheduled for ' + next.toISOString());

  setTimeout(function() {
    runDailyAssetSnapshots();
    setInterval(runDailyAssetSnapshots, 24 * 60 * 60 * 1000);
  }, delay);
}

module.exports = {
  snapshotAssetsForCharacter,
  snapshotWalletForCharacter,
  runDailyAssetSnapshots,
  scheduleDailyAssetSnapshots
};
