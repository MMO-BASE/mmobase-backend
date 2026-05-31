const axios = require('axios');
const supabase = require('../config/supabase');

const AFFILIATION_REFRESH_HOURS = 6;

async function refreshCharacterAffiliationIfStale(character) {
  if (!character) return character;

  const lastChecked = character.affiliation_checked_at ? new Date(character.affiliation_checked_at) : null;
  const isFresh = lastChecked && !Number.isNaN(lastChecked.getTime()) &&
    (Date.now() - lastChecked.getTime()) < AFFILIATION_REFRESH_HOURS * 60 * 60 * 1000;

  if (isFresh) return character;

  try {
    const charInfoResponse = await axios.get('https://esi.evetech.net/latest/characters/' + character.character_id + '/?datasource=tranquility');
    const charInfo = charInfoResponse.data;
    const corpId = charInfo.corporation_id;

    let corpName = '';
    let allianceId = charInfo.alliance_id || null;
    let allianceName = '';

    try {
      const corpResponse = await axios.get('https://esi.evetech.net/latest/corporations/' + corpId + '/?datasource=tranquility');
      corpName = corpResponse.data.name || '';
    } catch (e) { }

    if (allianceId) {
      try {
        const allianceResponse = await axios.get('https://esi.evetech.net/latest/alliances/' + allianceId + '/?datasource=tranquility');
        allianceName = allianceResponse.data.name || '';
      } catch (e) { }
    }

    const updatePayload = {
      corporation_id: corpId,
      corporation_name: corpName,
      alliance_id: allianceId,
      alliance_name: allianceName,
      affiliation_checked_at: new Date().toISOString()
    };

    const updateResult = await supabase
      .from('eve_characters')
      .update(updatePayload)
      .eq('character_id', character.character_id)
      .select('*')
      .single();

    if (updateResult.data) return updateResult.data;

    return Object.assign({}, character, updatePayload);
  } catch (e) {
    console.error('Failed to refresh character affiliation:', e.response ? e.response.data : e.message);
    return character;
  }
}

module.exports = {
  refreshCharacterAffiliationIfStale
};
