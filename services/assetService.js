const axios = require('axios');
const supabase = require('../config/supabase');

const ASSET_DEBUG_LOGS = process.env.ASSET_DEBUG_LOGS === 'true';

function assetDebugLog() {
  if (ASSET_DEBUG_LOGS) {
    console.log.apply(console, arguments);
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
    assetDebugLog('Corrected underpriced asset type ' + typeId + ': chosen=' + price + ', reference=' + highReference + ', source=' + source);
    price = highReference;
    source = 'underprice_correction';
  }

  const saneReferences = [buyBest, esiBest].filter(v => v > 0);
  const conservativeReference = saneReferences.length ? Math.max.apply(null, saneReferences) : 0;

  // If a sparse sell listing is over 5x the buy/ESI reference, treat it as inflated.
  // This is intended for items like vanity clothing / very thinly traded goods.
  if (price > 0 && conservativeReference > 0 && price > conservativeReference * 5) {
    const corrected = Math.max(conservativeReference, buyBest * 1.15, esiBest);
    assetDebugLog('Corrected inflated asset type ' + typeId + ': chosen=' + price + ', corrected=' + corrected + ', buyBest=' + buyBest + ', esiBest=' + esiBest + ', source=' + source);
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
  const numericIds = ids
    .map(id => Number(id))
    .filter(id => Number.isFinite(id) && id > 0);

  // First try universe/names in bulk for normal public location IDs only.
  // Very large player-structure/item-style IDs can cause ESI /universe/names to return 400,
  // so those are resolved later through the authenticated structures endpoint instead.
  const namesLookupIds = numericIds.filter(id => id < 1000000000000);

  for (const chunk of chunkArray(namesLookupIds, 900)) {
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

  assetDebugLog('Resolved asset location names: ' + JSON.stringify(result));
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

  assetDebugLog('Asset locations returned to frontend: ' + JSON.stringify(assetLocations.map(loc => ({ name: loc.name, value: loc.value, item_count: loc.item_count })).slice(0, 10)));

  const priceSourceCounts = {};
  for (const asset of pricedAssets) {
    const source = asset.price_source || 'unknown';
    priceSourceCounts[source] = (priceSourceCounts[source] || 0) + 1;
  }
  assetDebugLog('Asset pricing source counts: ' + JSON.stringify(priceSourceCounts));
  assetDebugLog('Blueprint asset types ignored for valuation: ' + JSON.stringify(Array.from(blueprintTypeIds)));

  assetDebugLog('Asset valuation summary for character ' + characterId + ': total=' + totalValue.toFixed(0) + ', records=' + assets.length + ', priced=' + pricedAssets.length + ', unpriced=' + unpricedAssetCount + ', ships=' + shipCount + ', stations=' + topLevelLocations.size + '. Asset total is assets only; wallet ISK is not included.');
  assetDebugLog('Top valued asset type IDs: ' + JSON.stringify(pricedAssets.slice(0, 10)));

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
  assetDebugLog('Top valued assets with names: ' + JSON.stringify(topNamedAssets));


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
  assetDebugLog('Unpriced asset type IDs: ' + JSON.stringify(unpricedList));


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

module.exports = {
  fetchAllCharacterAssets,
  calculateAssetSummary,
  saveDailyAssetSnapshot,
  getTypeInfo,
  getGroupInfo,
  fetchFuzzworkPrices,
  resolveAssetLocationNames
};
