require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: 'https://mmobase.co.uk', credentials: true }));
app.use(cookieParser());
app.use(express.json());

// Basic abuse protection / rate limiting
// Helps reduce API spam, accidental loops, and expensive repeated requests.
app.set('trust proxy', 1);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many API requests. Please wait a moment and try again.' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication requests. Please wait a moment and try again.' }
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sensitive requests. Please wait before trying again.' }
});

app.use('/api/account', sensitiveLimiter);
app.use('/auth/eve', authLimiter);
app.use('/callback', authLimiter);
app.use('/api/', apiLimiter);
app.use('/auth/', authLimiter);


const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const EVE_AUTH_URL = 'https://login.eveonline.com/v2/oauth/authorize';
const EVE_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const EVE_VERIFY_URL = 'https://login.eveonline.com/oauth/verify';

const SCOPES = 'esi-skills.read_skills.v1 esi-skills.read_skillqueue.v1 esi-wallet.read_character_wallet.v1 esi-assets.read_assets.v1 esi-markets.read_character_orders.v1 esi-characters.read_standings.v1 esi-location.read_location.v1 esi-location.read_ship_type.v1 esi-clones.read_clones.v1 esi-universe.read_structures.v1 esi-wallet.read_corporation_wallets.v1 esi-characters.read_corporation_roles.v1 esi-fleets.read_fleet.v1 esi-fleets.write_fleet.v1';

const AFFILIATION_REFRESH_HOURS = 6;

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
  if (!state || typeof state !== 'string') return null;

  const data = oauthStateStore.get(state);
  oauthStateStore.delete(state);

  if (!data) return null;

  if (Date.now() - data.createdAt > OAUTH_STATE_TTL_MS) {
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


const ASSET_PRICE_STATION_ID = 60003760; // Jita 4-4
const ASSET_PRICE_REGION_ID = 10000002; // The Forge
const assetTypeCache = {};
const assetGroupCache = {};

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function numberOrZero(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readFuzzworkMarket(d) {
  d = d || {};
  const sell = d.sell || {};
  const buy = d.buy || {};

  return {
    sellMin: numberOrZero(sell.min),
    sellMax: numberOrZero(sell.max),
    sellMedian: numberOrZero(sell.median),
    sellPercentile: numberOrZero(sell.percentile),
    sellWeighted: numberOrZero(sell.weightedAverage),
    sellAvg: numberOrZero(sell.avg),
    buyMax: numberOrZero(buy.max),
    buyMedian: numberOrZero(buy.median),
    buyPercentile: numberOrZero(buy.percentile),
    buyWeighted: numberOrZero(buy.weightedAverage),
    buyAvg: numberOrZero(buy.avg)
  };
}

function firstPositive(values) {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function chooseSellSideValue(market) {
  // Fuzzwork sell.percentile is usually safer than median for sparse/manipulated markets.
  return firstPositive([
    market.sellPercentile,
    market.sellWeighted,
    market.sellMedian,
    market.sellAvg,
    market.sellMin
  ]);
}

function chooseBuySideValue(market) {
  return firstPositive([
    market.buyMax,
    market.buyPercentile,
    market.buyWeighted,
    market.buyMedian,
    market.buyAvg
  ]);
}

async function fetchESIMarketPriceMap() {
  const result = {};

  try {
    const resp = await axios.get(
      'https://esi.evetech.net/latest/markets/prices/?datasource=tranquility',
      { timeout: 20000 }
    );

    for (const row of resp.data || []) {
      result[row.type_id] = {
        adjusted_price: numberOrZero(row.adjusted_price),
        average_price: numberOrZero(row.average_price)
      };
    }
  } catch (e) {
    console.error('Failed to fetch ESI market price map:', e.message);
  }

  return result;
}

function chooseFinalAssetPrice(typeId, stationMarket, regionMarket, esiPrice) {
  const stationSell = chooseSellSideValue(stationMarket);
  const regionSell = chooseSellSideValue(regionMarket);
  const stationBuy = chooseBuySideValue(stationMarket);
  const regionBuy = chooseBuySideValue(regionMarket);
  const buyBest = Math.max(stationBuy, regionBuy);

  const esiAverage = esiPrice ? numberOrZero(esiPrice.average_price) : 0;
  const esiAdjusted = esiPrice ? numberOrZero(esiPrice.adjusted_price) : 0;
  const esiBest = Math.max(esiAverage, esiAdjusted);

  let price = 0;
  let source = 'none';

  if (stationSell > 0) {
    price = stationSell;
    source = 'jita_sell';
  }

  if (regionSell > 0 && (price <= 0 || price < regionSell * 0.25)) {
    price = regionSell;
    source = 'forge_region_sell_fallback';
  }

  if (price <= 0 && buyBest > 0) {
    price = buyBest;
    source = 'buy_fallback';
  }

  if (price <= 0 && esiBest > 0) {
    price = esiBest;
    source = 'esi_fallback';
  }

  const highReference = Math.max(regionSell, buyBest, esiBest);
  if (highReference > 0 && price > 0 && price < highReference * 0.25) {
    console.log('Corrected underpriced asset type ' + typeId + ': chosen=' + price + ', reference=' + highReference + ', source=' + source);
    price = highReference;
    source = 'underprice_correction';
  }

  const saneReferences = [buyBest, esiBest].filter(v => v > 0);
  const conservativeReference = saneReferences.length ? Math.max.apply(null, saneReferences) : 0;

  // If a sparse sell listing is over 5x the buy/ESI reference, treat it as inflated.
  // This is intended for items like vanity clothing / very thinly traded goods.
  if (price > 0 && conservativeReference > 0 && price > conservativeReference * 5) {
    const corrected = Math.max(conservativeReference, buyBest * 1.15, esiBest);
    console.log('Corrected inflated asset type ' + typeId + ': chosen=' + price + ', corrected=' + corrected + ', buyBest=' + buyBest + ', esiBest=' + esiBest + ', source=' + source);
    price = corrected;
    source = 'inflation_correction';
  }

  return {
    price: Number.isFinite(price) ? price : 0,
    source,
    stationSell,
    regionSell,
    stationBuy,
    regionBuy,
    esiAverage,
    esiAdjusted
  };
}

async function fetchFuzzworkPrices(typeIds) {
  const prices = {};
  const priceDetails = {};
  const unique = Array.from(new Set((typeIds || []).filter(Boolean)));
  const chunks = chunkArray(unique, 120);
  const esiPriceMap = await fetchESIMarketPriceMap();

  for (const chunk of chunks) {
    try {
      const stationUrl = 'https://market.fuzzwork.co.uk/aggregates/?station=' + ASSET_PRICE_STATION_ID + '&types=' + chunk.join(',');
      const regionUrl = 'https://market.fuzzwork.co.uk/aggregates/?region=' + ASSET_PRICE_REGION_ID + '&types=' + chunk.join(',');

      const [stationResp, regionResp] = await Promise.all([
        axios.get(stationUrl, { timeout: 20000 }),
        axios.get(regionUrl, { timeout: 20000 })
      ]);

      const stationData = stationResp.data || {};
      const regionData = regionResp.data || {};

      for (const typeId of chunk) {
        const stationMarket = readFuzzworkMarket(stationData[typeId]);
        const regionMarket = readFuzzworkMarket(regionData[typeId]);
        const chosen = chooseFinalAssetPrice(typeId, stationMarket, regionMarket, esiPriceMap[typeId]);

        prices[typeId] = chosen.price;
        priceDetails[typeId] = chosen;

        if (chosen.source === 'forge_region_sell_fallback') {
          console.log('Using region price fallback for type ' + typeId + ': stationSell=' + chosen.stationSell + ', regionSell=' + chosen.regionSell);
        }
      }
    } catch (e) {
      console.error('Failed to fetch Fuzzwork price chunk:', e.message);

      for (const typeId of chunk) {
        const esiPrice = esiPriceMap[typeId] || {};
        const fallback = Math.max(numberOrZero(esiPrice.average_price), numberOrZero(esiPrice.adjusted_price));
        prices[typeId] = fallback;
        priceDetails[typeId] = {
          price: fallback,
          source: 'esi_chunk_fallback',
          stationSell: 0,
          regionSell: 0,
          stationBuy: 0,
          regionBuy: 0,
          esiAverage: numberOrZero(esiPrice.average_price),
          esiAdjusted: numberOrZero(esiPrice.adjusted_price)
        };
      }
    }
  }

  fetchFuzzworkPrices.lastDetails = priceDetails;
  return prices;
}

async function getTypeInfo(typeId) {
  if (assetTypeCache[typeId]) return assetTypeCache[typeId];

  try {
    const resp = await axios.get('https://esi.evetech.net/latest/universe/types/' + typeId + '/?datasource=tranquility', { timeout: 10000 });
    assetTypeCache[typeId] = resp.data;
    return resp.data;
  } catch (e) {
    assetTypeCache[typeId] = null;
    return null;
  }
}

async function getGroupInfo(groupId) {
  if (assetGroupCache[groupId]) return assetGroupCache[groupId];

  try {
    const resp = await axios.get('https://esi.evetech.net/latest/universe/groups/' + groupId + '/?datasource=tranquility', { timeout: 10000 });
    assetGroupCache[groupId] = resp.data;
    return resp.data;
  } catch (e) {
    assetGroupCache[groupId] = null;
    return null;
  }
}

async function saveDailyAssetSnapshot(snapshot) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  try {
    const existing = await supabase
      .from('asset_value_snapshots')
      .select('id')
      .eq('character_id', snapshot.character_id)
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString())
      .order('created_at', { ascending: false })
      .limit(1);

    const existingRow = existing.data && existing.data[0];

    if (existingRow) {
      await supabase
        .from('asset_value_snapshots')
        .update({
          total_value: snapshot.total_value,
          item_count: snapshot.item_count,
          unique_items: snapshot.unique_items,
          ships: snapshot.ships,
          stations: snapshot.stations,
          created_at: new Date().toISOString()
        })
        .eq('id', existingRow.id);
    } else {
      await supabase
        .from('asset_value_snapshots')
        .insert(snapshot);
    }
  } catch (e) {
    console.error('Failed to save daily asset snapshot:', e.message);
  }
}

async function fetchAllCharacterAssets(characterId, headers) {
  let allAssets = [];
  let page = 1;
  let totalPages = 1;

  do {
    const resp = await axios.get(
      'https://esi.evetech.net/latest/characters/' + characterId + '/assets/?datasource=tranquility&page=' + page,
      { headers }
    );

    const pageAssets = Array.isArray(resp.data) ? resp.data : [];
    allAssets = allAssets.concat(pageAssets);

    const pagesHeader = resp.headers && (resp.headers['x-pages'] || resp.headers['X-Pages']);
    totalPages = pagesHeader ? parseInt(pagesHeader, 10) : 1;
    if (!Number.isFinite(totalPages) || totalPages < 1) totalPages = 1;

    page += 1;
  } while (page <= totalPages);

  console.log('Fetched ' + allAssets.length + ' assets across ' + totalPages + ' page(s) for character ' + characterId);
  return allAssets;
}


async function resolveAssetLocationNames(locationIds, accessToken) {
  const result = {};
  const ids = Array.from(new Set((locationIds || []).filter(Boolean)));
  const numericIds = ids.map(id => Number(id)).filter(id => Number.isFinite(id));

  // First try universe/names in bulk.
  for (const chunk of chunkArray(numericIds, 900)) {
    try {
      const resp = await axios.post(
        'https://esi.evetech.net/latest/universe/names/?datasource=tranquility',
        chunk,
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );

      (resp.data || []).forEach(item => {
        if (item && item.id && item.name) result[String(item.id)] = item.name;
      });
    } catch (e) {
      console.error('Failed to resolve asset location names chunk:', e.message);
    }
  }

  // NPC stations often need the station endpoint, especially when /universe/names does not return a friendly name.
  for (const id of numericIds) {
    if (result[String(id)] && !String(result[String(id)]).startsWith('Location ')) continue;

    try {
      const resp = await axios.get(
        'https://esi.evetech.net/latest/universe/stations/' + id + '/?datasource=tranquility',
        { timeout: 10000 }
      );

      if (resp.data && resp.data.name) {
        result[String(id)] = resp.data.name;
        continue;
      }
    } catch (e) {
      // Not an NPC station or not public; try structure endpoint below.
    }

    // Upwell / player structures require auth and access.
    if (accessToken) {
      try {
        const resp = await axios.get(
          'https://esi.evetech.net/latest/universe/structures/' + id + '/?datasource=tranquility',
          { headers: { Authorization: 'Bearer ' + accessToken }, timeout: 10000 }
        );

        if (resp.data && resp.data.name) result[String(id)] = resp.data.name;
      } catch (e) {
        // Leave fallback if private/no access.
      }
    }
  }

  console.log('Resolved asset location names: ' + JSON.stringify(result));
  return result;
}



async function calculateAssetSummary(userId, characterId, assets, currentShip, accessToken) {
  assets = assets || [];

  // ESI can report the currently active ship separately from the assets list.
  // If it is missing from assets, add the hull so active ship value is included.
  if (currentShip && currentShip.ship_type_id) {
    const shipItemId = currentShip.ship_item_id || currentShip.item_id || null;
    const alreadyIncluded = shipItemId
      ? assets.some(a => String(a.item_id) === String(shipItemId))
      : assets.some(a => a.type_id === currentShip.ship_type_id && a.location_flag === 'Pilot');

    if (!alreadyIncluded) {
      assets = assets.concat([{
        item_id: shipItemId || ('active-ship-' + currentShip.ship_type_id),
        type_id: currentShip.ship_type_id,
        quantity: 1,
        location_id: shipItemId || 0,
        location_type: 'active_ship',
        location_flag: 'Pilot'
      }]);
      console.log('Added active ship hull to asset valuation for character ' + characterId + ': type_id=' + currentShip.ship_type_id);
    }
  }

  const typeIds = Array.from(new Set(assets.map(a => a.type_id).filter(Boolean)));
  const prices = await fetchFuzzworkPrices(typeIds);
  const priceDetails = fetchFuzzworkPrices.lastDetails || {};

  let totalValue = 0;
  let itemCount = 0;
  const uniqueTypes = new Set();
  const topLevelLocations = new Set();
  const shipTypeIds = new Set();
  const blueprintTypeIds = new Set();

  // Lookup type/group info so ship count is based on EVE category 6: Ships.
  // Also detect blueprints. Blueprint copies and originals can be difficult to value accurately
  // without the dedicated blueprints endpoint, so MMOBASE treats all blueprints as 0 ISK for now.
  for (const typeId of typeIds) {
    const typeInfo = await getTypeInfo(typeId);
    if (!typeInfo || !typeInfo.group_id) continue;

    const groupInfo = await getGroupInfo(typeInfo.group_id);
    if (groupInfo && groupInfo.category_id === 6) shipTypeIds.add(typeId);

    const typeName = typeInfo && typeInfo.name ? String(typeInfo.name) : '';
    if ((groupInfo && groupInfo.category_id === 9) || /Blueprint$/i.test(typeName)) {
      blueprintTypeIds.add(typeId);
    }
  }

  let shipCount = 0;

  for (const asset of assets) {
    const qty = parseInt(asset.quantity || 1, 10);
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;

    itemCount += safeQty;
    if (asset.type_id) uniqueTypes.add(asset.type_id);

    // ESI nested assets usually have location_type "item"; do not count those as stations/locations.
    if (asset.location_id && asset.location_type !== 'item') topLevelLocations.add(asset.location_id);

    if (asset.type_id && shipTypeIds.has(asset.type_id)) shipCount += safeQty;

    const isBlueprint = blueprintTypeIds.has(asset.type_id) || asset.is_blueprint_copy === true;
    const price = isBlueprint ? 0 : (prices[asset.type_id] || 0);
    totalValue += price * safeQty;
  }

  const pricedAssets = [];
  let unpricedAssetCount = 0;
  for (const asset of assets) {
    const qty = parseInt(asset.quantity || 1, 10);
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const isBlueprint = blueprintTypeIds.has(asset.type_id) || asset.is_blueprint_copy === true;
    const price = isBlueprint ? 0 : (prices[asset.type_id] || 0);
    const value = price * safeQty;
    if (price > 0 && value > 0) {
      pricedAssets.push({ type_id: asset.type_id, quantity: safeQty, price: price, value: value, price_source: priceDetails[asset.type_id] ? priceDetails[asset.type_id].source : 'unknown' });
    } else {
      unpricedAssetCount += 1;
    }
  }
  pricedAssets.sort((a, b) => b.value - a.value);

  const assetByItemId = {};
  for (const asset of assets) {
    if (asset.item_id !== undefined && asset.item_id !== null) {
      assetByItemId[String(asset.item_id)] = asset;
    }
  }

  function getRootLocationId(asset) {
    let current = asset;
    let guard = 0;

    while (current && current.location_type === 'item' && current.location_id && guard < 20) {
      const parent = assetByItemId[String(current.location_id)];
      if (!parent) break;
      current = parent;
      guard += 1;
    }

    if (current && current.location_id !== undefined && current.location_id !== null) return String(current.location_id);
    if (asset.location_id !== undefined && asset.location_id !== null) return String(asset.location_id);
    return 'unknown';
  }

  const locationValueMap = {};
  for (const asset of assets) {
    const qty = parseInt(asset.quantity || 1, 10);
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const isBlueprint = blueprintTypeIds.has(asset.type_id) || asset.is_blueprint_copy === true;
    const price = isBlueprint ? 0 : (prices[asset.type_id] || 0);
    const value = price * safeQty;

    // Keep blueprints visible in location contents, but force their value to 0 ISK.
    // Non-blueprint items with no price are still skipped.
    if (!isBlueprint && (!price || value <= 0)) continue;

    const locKey = getRootLocationId(asset);

    if (!locationValueMap[locKey]) {
      locationValueMap[locKey] = {
        location_id: locKey,
        name: locKey === 'unknown' ? 'Unknown Location' : ('Location ' + locKey),
        value: 0,
        item_count: 0,
        items: []
      };
    }

    locationValueMap[locKey].value += value;
    locationValueMap[locKey].item_count += safeQty;
    locationValueMap[locKey].items.push({
      type_id: asset.type_id,
      quantity: safeQty,
      price: price,
      value: value,
      price_source: isBlueprint ? 'blueprint_zero' : (priceDetails[asset.type_id] ? priceDetails[asset.type_id].source : 'unknown'),
      location_flag: asset.location_flag || ''
    });
  }

  const locationIdsForNames = Object.keys(locationValueMap).filter(id => id !== 'unknown');
  const locationNames = await resolveAssetLocationNames(locationIdsForNames, accessToken);

  const assetLocations = Object.values(locationValueMap)
    .map(loc => ({
      location_id: loc.location_id,
      name: locationNames[String(loc.location_id)] || (loc.location_id === 'unknown' ? 'Unknown Location' : 'Do not have access to this station anymore'),
      value: loc.value,
      item_count: loc.item_count,
      items: loc.items.sort((a, b) => b.value - a.value)
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 20);

  const displayTypeIds = Array.from(new Set(assetLocations.flatMap(loc => loc.items.map(item => item.type_id))));
  const displayTypeNames = {};
  for (const typeId of displayTypeIds) {
    try {
      const info = await getTypeInfo(typeId);
      displayTypeNames[typeId] = info && info.name ? info.name : ('Type ID ' + typeId);
    } catch (e) {
      displayTypeNames[typeId] = 'Type ID ' + typeId;
    }
  }

  for (const loc of assetLocations) {
    loc.items = loc.items.map(item => ({
      type_id: item.type_id,
      name: displayTypeNames[item.type_id] || ('Type ID ' + item.type_id),
      quantity: item.quantity,
      price: item.price,
      value: item.value,
      price_source: item.price_source,
      location_flag: item.location_flag
    }));
  }

  console.log('Asset locations returned to frontend: ' + JSON.stringify(assetLocations.map(loc => ({ name: loc.name, value: loc.value, item_count: loc.item_count })).slice(0, 10)));

  const priceSourceCounts = {};
  for (const asset of pricedAssets) {
    const source = asset.price_source || 'unknown';
    priceSourceCounts[source] = (priceSourceCounts[source] || 0) + 1;
  }
  console.log('Asset pricing source counts: ' + JSON.stringify(priceSourceCounts));
  console.log('Blueprint asset types ignored for valuation: ' + JSON.stringify(Array.from(blueprintTypeIds)));

  console.log('Asset valuation summary for character ' + characterId + ': total=' + totalValue.toFixed(0) + ', records=' + assets.length + ', priced=' + pricedAssets.length + ', unpriced=' + unpricedAssetCount + ', ships=' + shipCount + ', stations=' + topLevelLocations.size + '. Asset total is assets only; wallet ISK is not included.');
  console.log('Top valued asset type IDs: ' + JSON.stringify(pricedAssets.slice(0, 10)));

  const topNamedAssets = pricedAssets.slice(0, 15);
  for (const item of topNamedAssets) {
    try {
      const info = await getTypeInfo(item.type_id);
      item.name = info && info.name ? info.name : ('Type ID ' + item.type_id);
      item.group_id = info && info.group_id ? info.group_id : null;
    } catch (e) {
      item.name = 'Type ID ' + item.type_id;
    }
  }
  console.log('Top valued assets with names: ' + JSON.stringify(topNamedAssets));


  const unpricedTypes = {};
  for (const asset of assets) {
    const qty = parseInt(asset.quantity || 1, 10);
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const isBlueprint = blueprintTypeIds.has(asset.type_id) || asset.is_blueprint_copy === true;
    const price = isBlueprint ? 0 : (prices[asset.type_id] || 0);
    if (!price || price <= 0) {
      if (!unpricedTypes[asset.type_id]) unpricedTypes[asset.type_id] = { type_id: asset.type_id, quantity: 0, records: 0 };
      unpricedTypes[asset.type_id].quantity += safeQty;
      unpricedTypes[asset.type_id].records += 1;
    }
  }

  const unpricedList = Object.values(unpricedTypes).sort((a, b) => b.quantity - a.quantity).slice(0, 25);
  for (const item of unpricedList) {
    try {
      const info = await getTypeInfo(item.type_id);
      item.name = info && info.name ? info.name : ('Type ID ' + item.type_id);
      item.group_id = info && info.group_id ? info.group_id : null;
    } catch (e) {
      item.name = 'Type ID ' + item.type_id;
    }
  }
  console.log('Unpriced asset type IDs: ' + JSON.stringify(unpricedList));


  const nowIso = new Date().toISOString();

  await saveDailyAssetSnapshot({
    user_id: userId,
    character_id: characterId,
    total_value: totalValue,
    item_count: itemCount,
    unique_items: uniqueTypes.size,
    ships: shipCount,
    stations: topLevelLocations.size,
    created_at: nowIso
  });

  async function getChange(days) {
    try {
      const target = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const result = await supabase
        .from('asset_value_snapshots')
        .select('total_value, created_at')
        .eq('character_id', characterId)
        .lte('created_at', target)
        .order('created_at', { ascending: false })
        .limit(1);

      const row = result.data && result.data[0];
      if (!row || row.total_value === null || row.total_value === undefined) return null;
      return totalValue - Number(row.total_value);
    } catch (e) {
      console.error('Failed to calculate ' + days + 'd asset change:', e.message);
      return null;
    }
  }

  async function getHistory(days) {
    try {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const result = await supabase
        .from('asset_value_snapshots')
        .select('total_value, created_at')
        .eq('character_id', characterId)
        .gte('created_at', since)
        .order('created_at', { ascending: true });

      return result.data || [];
    } catch (e) {
      console.error('Failed to fetch asset history:', e.message);
      return [];
    }
  }

  let firstSnapshotAgeDays = 0;
  try {
    const firstResult = await supabase
      .from('asset_value_snapshots')
      .select('created_at')
      .eq('character_id', characterId)
      .order('created_at', { ascending: true })
      .limit(1);

    const firstRow = firstResult.data && firstResult.data[0];
    if (firstRow && firstRow.created_at) {
      firstSnapshotAgeDays = Math.floor((Date.now() - new Date(firstRow.created_at).getTime()) / (24 * 60 * 60 * 1000));
    }
  } catch (e) {
    console.error('Failed to read first asset snapshot:', e.message);
  }

  return {
    total_asset_value: totalValue,
    stations: topLevelLocations.size,
    item_count: itemCount,
    unique_items: uniqueTypes.size,
    ships: shipCount,
    change_7d: await getChange(7),
    change_14d: await getChange(14),
    change_30d: await getChange(30),
    days_until_7d_change: Math.max(0, 7 - firstSnapshotAgeDays),
    days_until_14d_change: Math.max(0, 14 - firstSnapshotAgeDays),
    days_until_30d_change: Math.max(0, 30 - firstSnapshotAgeDays),
    history: await getHistory(180),
    asset_locations: assetLocations
  };
}


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
      console.error('Scheduled snapshot token refresh failed for character ' + characterId + ':', e.response ? e.response.data : e.message);
      return null;
    }
  }

  return accessToken;
}

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



app.get('/auth/eve', (req, res) => {
  const mmobaseToken = req.query.token;
  if (!mmobaseToken || typeof mmobaseToken !== 'string') return res.status(400).send('Missing MMOBASE auth token');

  const from = req.query.from === 'settings' ? 'settings' : 'dashboard';

  const state = createOAuthState({
    token: mmobaseToken,
    from: from
  });

  const authUrl = EVE_AUTH_URL + '?response_type=code&redirect_uri=' + encodeURIComponent(process.env.EVE_CALLBACK_URL) + '&client_id=' + process.env.EVE_CLIENT_ID + '&scope=' + encodeURIComponent(SCOPES) + '&state=' + encodeURIComponent(state);
  res.set('Cache-Control', 'no-store');
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.redirect('https://mmobase.co.uk/dashboard?error=missing_code');
  try {
    const stateData = consumeOAuthState(String(state));
    if (!stateData || !stateData.token) return res.redirect('https://mmobase.co.uk/dashboard?error=invalid_state');

    const mmobaseToken = stateData.token;
    const userData = await supabase.auth.getUser(mmobaseToken);
    const user = userData && userData.data ? userData.data.user : null;
    if (!user) return res.redirect('https://mmobase.co.uk/dashboard?error=invalid_session');

    const tokenResponse = await axios.post(EVE_TOKEN_URL, new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: process.env.EVE_CLIENT_ID,
      client_secret: process.env.EVE_CLIENT_SECRET
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const access_token = tokenResponse.data.access_token;
    const refresh_token = tokenResponse.data.refresh_token;
    const expires_in = tokenResponse.data.expires_in;

    const verifyResponse = await axios.get(EVE_VERIFY_URL, { headers: { Authorization: 'Bearer ' + access_token } });
    const characterId = verifyResponse.data.CharacterID;
    const characterName = verifyResponse.data.CharacterName;

    const charInfoResponse = await axios.get('https://esi.evetech.net/latest/characters/' + characterId + '/?datasource=tranquility');
    const corpId = charInfoResponse.data.corporation_id;

    let corpName = '';
    let allianceId = null;
    let allianceName = '';

    try {
      const corpResponse = await axios.get('https://esi.evetech.net/latest/corporations/' + corpId + '/?datasource=tranquility');
      corpName = corpResponse.data.name;
      allianceId = corpResponse.data.alliance_id || null;
      if (allianceId) {
        const allianceResponse = await axios.get('https://esi.evetech.net/latest/alliances/' + allianceId + '/?datasource=tranquility');
        allianceName = allianceResponse.data.name;
      }
    } catch (e) { }

    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
    const portraitUrl = 'https://images.evetech.net/characters/' + characterId + '/portrait?size=256';

    const existingCharResult = await supabase
      .from('eve_characters')
      .select('id, user_id')
      .eq('character_id', characterId)
      .single();

    const existingChar = existingCharResult.data;

    if (existingChar && existingChar.user_id !== user.id) {
      return res.redirect('https://mmobase.co.uk/dashboard?error=character_already_linked');
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

    var redirectPage = stateData.from === "settings" ? "/settings" : "/dashboard";
    res.redirect('https://mmobase.co.uk' + redirectPage + '?eve_linked=success&character=' + encodeURIComponent(characterName));

  } catch (error) {
    console.error('EVE SSO Error:', error.response ? { status: error.response.status, url: error.config ? error.config.url : 'unknown', data: error.response.data } : error.message);
    res.redirect('https://mmobase.co.uk/dashboard?error=sso_failed');
  }
});



const WALLET_SNAPSHOT_FILE = path.join(__dirname, 'wallet_balance_snapshots.json');

function walletSnapshotKey(userId, characterId) {
  return String(userId) + ':' + String(characterId);
}

function walletDateKey(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function readWalletSnapshotStore() {
  try {
    if (!fs.existsSync(WALLET_SNAPSHOT_FILE)) return {};
    const raw = fs.readFileSync(WALLET_SNAPSHOT_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('Failed to read wallet snapshot store:', e.message);
    return {};
  }
}

function writeWalletSnapshotStore(store) {
  try {
    fs.writeFileSync(WALLET_SNAPSHOT_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Failed to write wallet snapshot store:', e.message);
  }
}

async function saveDailyWalletSnapshot(userId, characterId, walletBalance) {
  const balance = Number(walletBalance || 0);
  const nowIso = new Date().toISOString();
  const todayKey = walletDateKey(nowIso);
  const key = walletSnapshotKey(userId, characterId);
  const store = readWalletSnapshotStore();

  if (!Array.isArray(store[key])) store[key] = [];

  const existing = store[key].find(row => walletDateKey(row.created_at) === todayKey);
  if (existing) {
    existing.balance = balance;
    existing.created_at = nowIso;
  } else {
    store[key].push({
      balance: balance,
      created_at: nowIso
    });
  }

  store[key] = store[key]
    .filter(row => row && row.created_at && row.balance !== null && row.balance !== undefined)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .slice(-365);

  writeWalletSnapshotStore(store);
}

function getWalletSnapshotHistory(userId, characterId, days) {
  const key = walletSnapshotKey(userId, characterId);
  const store = readWalletSnapshotStore();
  const rows = Array.isArray(store[key]) ? store[key] : [];
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  return rows
    .filter(row => row && row.created_at && new Date(row.created_at).getTime() >= since)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function getWalletSnapshotChange(userId, characterId, currentBalance, days) {
  const key = walletSnapshotKey(userId, characterId);
  const store = readWalletSnapshotStore();
  const rows = Array.isArray(store[key]) ? store[key] : [];
  const target = Date.now() - days * 24 * 60 * 60 * 1000;

  const candidates = rows
    .filter(row => row && row.created_at && new Date(row.created_at).getTime() <= target)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const row = candidates[0];
  if (!row || row.balance === null || row.balance === undefined) return null;

  return Number(currentBalance || 0) - Number(row.balance || 0);
}

function getFirstWalletSnapshotAgeDays(userId, characterId) {
  const key = walletSnapshotKey(userId, characterId);
  const store = readWalletSnapshotStore();
  const rows = Array.isArray(store[key]) ? store[key] : [];

  const sorted = rows
    .filter(row => row && row.created_at)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (!sorted.length) return 0;

  return Math.floor((Date.now() - new Date(sorted[0].created_at).getTime()) / (24 * 60 * 60 * 1000));
}

async function calculateWalletSummary(userId, characterId, walletBalance) {
  const balance = Number(walletBalance || 0);

  await saveDailyWalletSnapshot(userId, characterId, balance);

  const firstAgeDays = getFirstWalletSnapshotAgeDays(userId, characterId);

  return {
    current_balance: balance,
    change_30d: getWalletSnapshotChange(userId, characterId, balance, 30),
    days_until_30d_change: Math.max(0, 30 - firstAgeDays),
    history: getWalletSnapshotHistory(userId, characterId, 180)
  };
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


async function fetchCharacterWalletJournal(characterId, headers) {
  const allRows = [];
  let page = 1;
  let totalPages = 1;

  do {
    const resp = await axios.get(
      'https://esi.evetech.net/latest/characters/' + characterId + '/wallet/journal/?datasource=tranquility&page=' + page,
      { headers, timeout: 15000 }
    );

    const rows = Array.isArray(resp.data) ? resp.data : [];
    allRows.push(...rows);

    totalPages = parseInt(resp.headers && resp.headers['x-pages'] ? resp.headers['x-pages'] : '1', 10);
    if (!Number.isFinite(totalPages) || totalPages < 1) totalPages = 1;

    page += 1;
  } while (page <= totalPages && page <= 10);

  console.log('Fetched ' + allRows.length + ' wallet journal rows across ' + Math.min(totalPages, 10) + ' page(s) for character ' + characterId);
  return allRows;
}



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

app.get('/api/characters', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return;

  const charsResult = await supabase
    .from('eve_characters')
    .select('*')
    .eq('user_id', user.id)
    .order('is_primary', { ascending: false });

  res.json({ characters: charsResult.data || [] });
});

app.get('/api/character/:characterId/data', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) return;

  const characterId = Number(req.params.characterId);

  if (!Number.isInteger(characterId) || characterId <= 0) {
    return res.status(400).json({ error: 'Invalid character ID' });
  }

  let character = await getOwnedCharacter(user.id, characterId);
  if (!character) return res.status(403).json({ error: 'You do not have access to this character' });

  character = await refreshCharacterAffiliationIfStale(character);

  const tokenResult = await supabase
    .from('eve_tokens')
    .select('*')
    .eq('character_id', characterId)
    .single();

  const tokenData = tokenResult.data;
  if (!tokenData) return res.status(400).json({ error: 'No tokens found' });

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
      return res.status(401).json({ error: 'Token refresh failed. Please re-link character.' });
    }
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


app.delete('/api/account', async (req, res) => {
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
      if (typeof WALLET_SNAPSHOT_FILE !== 'undefined' && fs.existsSync(WALLET_SNAPSHOT_FILE)) {
        const raw = fs.readFileSync(WALLET_SNAPSHOT_FILE, 'utf8');
        const store = raw ? JSON.parse(raw) : {};
        const prefix = String(user.id) + ':';

        Object.keys(store).forEach(key => {
          if (key.startsWith(prefix)) delete store[key];
        });

        fs.writeFileSync(WALLET_SNAPSHOT_FILE, JSON.stringify(store, null, 2));
      }
    } catch (walletError) {
      console.error('Failed to clean wallet snapshot file:', walletError.message);
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


app.listen(process.env.PORT, () => {
  console.log('MMOBASE backend running on port ' + process.env.PORT + ' | build polish-v54-auth-safe-loading-reset-20260519_2359');
  scheduleDailyAssetSnapshots();
});
