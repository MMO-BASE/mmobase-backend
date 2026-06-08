const EVE_AUTH_URL = 'https://login.eveonline.com/v2/oauth/authorize';
const EVE_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const EVE_VERIFY_URL = 'https://login.eveonline.com/oauth/verify';

const SCOPES = 'esi-skills.read_skills.v1 esi-skills.read_skillqueue.v1 esi-wallet.read_character_wallet.v1 esi-assets.read_assets.v1 esi-markets.read_character_orders.v1 esi-location.read_location.v1 esi-location.read_ship_type.v1 esi-universe.read_structures.v1 esi-fleets.read_fleet.v1';

module.exports = {
  EVE_AUTH_URL,
  EVE_TOKEN_URL,
  EVE_VERIFY_URL,
  SCOPES
};
