# MMOBase Backend

Backend API for MMOBase, handling EVE Online authentication, account services, character data syncing, wallet and asset processing, and server-side dashboard data.

## Live status

The current backend powers:

* https://mmobase.co.uk
* https://v2.mmobase.co.uk

The backend runs as a Node.js/Express service behind nginx and is managed with PM2.

## Main responsibilities

The backend handles:

* EVE Online OAuth / SSO flow
* EVE character linking and re-linking
* Supabase-backed user and character data
* Authenticated API routes
* Character ownership checks
* Wallet balance summaries
* Wallet journal fetching
* Asset fetching and valuation
* Asset location name resolution
* Daily asset and wallet snapshot jobs
* Token refresh handling
* Expired/revoked token detection
* Account deletion support
* Rate limiting and basic API abuse protection

## Project structure

```txt
config/
  eve.js
  supabase.js

jobs/
  dailySnapshots.js

middleware/
  auth.js
  rateLimiters.js

routes/
  accountRoutes.js
  authRoutes.js
  characterRoutes.js
  characterDataRoutes.js

services/
  assetService.js
  characterAffiliationService.js
  eveTokenService.js
  oauthStateService.js
  tokenStatusService.js
  walletService.js

server.js
```

## Environment variables

The backend requires environment variables for Supabase, EVE Online SSO, and runtime configuration.

Typical required keys:

```txt
EVE_CLIENT_ID
EVE_CLIENT_SECRET
EVE_CALLBACK_URL
SUPABASE_URL
SUPABASE_SERVICE_KEY
PORT
FRONTEND_BASE_URL
```

Do not commit real `.env` files or secret values.

## Running locally

Install dependencies:

```bash
npm install
```

Run the server:

```bash
node server.js
```

For production, the app is intended to run behind nginx and PM2.

## Security notes

* Secrets are stored in `.env` and are not committed.
* Supabase backend access uses a server-side secret key only.
* EVE client credentials are backend-only.
* API routes use authentication and ownership checks.
* Rate limiting is applied to API and sensitive routes.
* Dependency audit issues should be reviewed before running automated fixes.
* Detailed asset valuation debug logs are gated behind an environment flag.

## Deployment notes

The current production deployment uses:

* Node.js
* Express
* Supabase
* EVE Online ESI/SSO
* PM2
* nginx

Live and staging use separate ports and callback URLs.

## License

See `LICENSE`.
