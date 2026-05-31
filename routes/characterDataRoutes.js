const express = require('express');
const axios = require('axios');
const { getAuthenticatedUser, getOwnedCharacter } = require('../middleware/auth');
const { calculateWalletSummary, fetchCharacterWalletJournal } = require('../services/walletService');
const { fetchAllCharacterAssets, calculateAssetSummary } = require('../services/assetService');
const { getFreshAccessTokenForCharacter } = require('../services/eveTokenService');
const { refreshCharacterAffiliationIfStale } = require('../services/characterAffiliationService');

const router = express.Router();

router.get('/:characterId/data', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return;

  const characterId = Number(req.params.characterId);

  if (!Number.isInteger(characterId) || characterId <= 0) {
    return res.status(400).json({ error: 'Invalid character ID' });
  }

  let character = await getOwnedCharacter(user.id, characterId);
  if (!character) return res.status(403).json({ error: 'You do not have access to this character' });

  character = await refreshCharacterAffiliationIfStale(character);

  const accessToken = await getFreshAccessTokenForCharacter(characterId);

  if (!accessToken) {
    return res.status(401).json({
      error: 'Character needs re-link. Please reconnect this EVE character.',
      needs_relink: true,
      token_status: 'needs_relink'
    });
  }

  const headers = { Authorization: 'Bearer ' + accessToken };

  try {
    const [skills, skillqueue, wallet, assets, orders, location, ship, charInfo, fleetInfo, attributes, walletJournal, walletTransactions] = await Promise.allSettled([
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/skills/?datasource=tranquility', { headers }),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/skillqueue/?datasource=tranquility', { headers }),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/wallet/?datasource=tranquility', { headers }),
      fetchAllCharacterAssets(characterId, headers),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/orders/?datasource=tranquility', { headers }),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/location/?datasource=tranquility', { headers }),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/ship/?datasource=tranquility', { headers }),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/?datasource=tranquility'),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/fleet/?datasource=tranquility', { headers }),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/attributes/?datasource=tranquility', { headers }),
      fetchCharacterWalletJournal(characterId, headers),
      axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/wallet/transactions/?datasource=tranquility', { headers })
    ]);

    var secStatus = null;
    if (charInfo.status === 'fulfilled') {
      secStatus = charInfo.value.data.security_status;
    }

    // Get ship group name
    var shipGroupName = null;
    if (ship.status === 'fulfilled') {
      try {
        var shipTypeId = ship.value.data.ship_type_id;
        var typeInfo = await axios.get('https://esi.evetech.net/latest/universe/types/' + shipTypeId + '/?datasource=tranquility');
        var groupId = typeInfo.data.group_id;
        var groupInfo = await axios.get('https://esi.evetech.net/latest/universe/groups/' + groupId + '/?datasource=tranquility');
        shipGroupName = groupInfo.data.name;
      } catch (e) { }
    }

    // Get fleet members if in a fleet
    var fleetMembers = null;
    if (fleetInfo.status === 'fulfilled') {
      try {
        var fleetId = fleetInfo.value.data.fleet_id;
        var membersResp = await axios.get('https://esi.evetech.net/latest/fleets/' + fleetId + '/members/?datasource=tranquility', { headers });
        fleetMembers = membersResp.data;
      } catch (e) { }
    }


    // Group skills by group name (e.g. Spaceship Command, Gunnery)
    var skillGroups = null;
    if (skills.status === 'fulfilled') {
      try {
        var skillList = skills.value.data.skills || [];
        var typeToGroup = {};
        var groupNames = {};
        var grouped = {};

        // First pass: collect all unique skill type IDs
        var uniqueTypeIds = [];
        for (var i = 0; i < skillList.length; i++) {
          if (skillList[i].skillpoints_in_skill > 0 && uniqueTypeIds.indexOf(skillList[i].skill_id) === -1) {
            uniqueTypeIds.push(skillList[i].skill_id);
          }
        }

        // Batch lookup types to get group IDs (10 at a time to avoid rate limits)
        var uniqueGroupIds = [];
        for (var i = 0; i < uniqueTypeIds.length; i++) {
          try {
            var typeResp = await axios.get('https://esi.evetech.net/latest/universe/types/' + uniqueTypeIds[i] + '/?datasource=tranquility');
            var gId = typeResp.data.group_id;
            typeToGroup[uniqueTypeIds[i]] = gId;
            if (uniqueGroupIds.indexOf(gId) === -1) uniqueGroupIds.push(gId);
          } catch (e) { typeToGroup[uniqueTypeIds[i]] = 0; }
        }

        // Lookup group names (much fewer calls - usually ~20 groups)
        for (var j = 0; j < uniqueGroupIds.length; j++) {
          try {
            var groupResp = await axios.get('https://esi.evetech.net/latest/universe/groups/' + uniqueGroupIds[j] + '/?datasource=tranquility');
            groupNames[uniqueGroupIds[j]] = groupResp.data.name;
          } catch (e) { groupNames[uniqueGroupIds[j]] = 'Other'; }
        }

        // Second pass: sum SP by group
        for (var k = 0; k < skillList.length; k++) {
          var sk = skillList[k];
          if (sk.skillpoints_in_skill === 0) continue;
          var grpId = typeToGroup[sk.skill_id] || 0;
          var grpName = groupNames[grpId] || 'Other';
          if (!grouped[grpName]) grouped[grpName] = 0;
          grouped[grpName] += sk.skillpoints_in_skill;
        }

        skillGroups = grouped;
      } catch (e) { }
    }

    var assetSummary = null;
    var assetRows = assets.status === 'fulfilled'
      ? (Array.isArray(assets.value) ? assets.value : (assets.value.data || []))
      : [];

    if (assets.status === 'fulfilled') {
      try {
        assetSummary = await calculateAssetSummary(user.id, characterId, assetRows, ship.status === 'fulfilled' ? ship.value.data : null, accessToken);
      } catch (e) {
        console.error('Failed to calculate asset summary:', e.message);
      }
    }

    var walletSummary = null;
    if (wallet.status === 'fulfilled') {
      try {
        walletSummary = await calculateWalletSummary(user.id, characterId, wallet.value.data);
      } catch (e) {
        console.error('Failed to calculate wallet summary:', e.message);
      }
    }

    res.json({
      character: character,
      security_status: secStatus,
      ship_group: shipGroupName,
      fleet: fleetMembers,
      fleet_id: fleetInfo.status === 'fulfilled' ? fleetInfo.value.data.fleet_id : null,
      skills: skills.status === 'fulfilled' ? skills.value.data : null,
      skillqueue: skillqueue.status === 'fulfilled' ? skillqueue.value.data : null,
      wallet: wallet.status === 'fulfilled' ? wallet.value.data : null,
      wallet_summary: walletSummary,
      assets: assets.status === 'fulfilled' ? assetRows : null,
      asset_summary: assetSummary,
      orders: orders.status === 'fulfilled' ? orders.value.data : null,
      location: location.status === 'fulfilled' ? location.value.data : null,
      ship: ship.status === 'fulfilled' ? ship.value.data : null,
      attributes: attributes.status === 'fulfilled' ? attributes.value.data : null,
      skill_groups: skillGroups,
      wallet_journal: walletJournal.status === 'fulfilled' ? (Array.isArray(walletJournal.value) ? walletJournal.value : walletJournal.value.data) : null,
      wallet_transactions: walletTransactions.status === 'fulfilled' ? walletTransactions.value.data : null
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch ESI data' });
  }
});

module.exports = router;
