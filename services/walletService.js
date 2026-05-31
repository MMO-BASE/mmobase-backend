const axios = require('axios');
const fs = require('fs');
const path = require('path');

const WALLET_SNAPSHOT_FILE = path.join(__dirname, '..', 'wallet_balance_snapshots.json');

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


function deleteWalletSnapshotsForUser(userId) {
  const store = readWalletSnapshotStore();
  const prefix = String(userId) + ':';
  let changed = false;

  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) {
      delete store[key];
      changed = true;
    }
  }

  if (changed) {
    writeWalletSnapshotStore(store);
  }

  return changed;
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

module.exports = {
  calculateWalletSummary,
  fetchCharacterWalletJournal,
  saveDailyWalletSnapshot,
  getWalletSnapshotHistory,
  getWalletSnapshotChange,
  getFirstWalletSnapshotAgeDays,
  deleteWalletSnapshotsForUser
};
