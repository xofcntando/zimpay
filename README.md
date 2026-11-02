# ZimPay (sandbox)

Wallet-to-wallet money transfer app for Zimbabwe: USD and ZiG wallets, send by mobile number, add money, withdraw,
ID verification queue, admin console, double-entry ledger. Node 20+, Express, Postgres.

**Status: SANDBOX ONLY.** No real money moves. Operating this with real funds in Zimbabwe requires an RBZ payment
service provider licence, or running on top of a licensed partner who holds the funds and the licence.
The app refuses to start with a live provider unless `LICENSED_PARTNER_CONFIRMED=yes`.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render dashboard > New > Blueprint > select the repo. `render.yaml` creates the web service + Postgres.
3. Set `BASE_URL` (your onrender.com URL) and `ADMIN_PHONE` (your number). Register with that number to become admin.

## Run locally
    npm install && DATABASE_URL=postgres://... npm start
    npm test        # spins up an embedded Postgres, no setup needed

## How money is modelled
Amounts are integer cents. Every movement is a transaction with ledger entries that sum to zero.
`external` = money held at the bank/provider (negative when users hold balances), `fees`, `payout_hold`.
User wallets cannot go below zero (DB constraint). Admin page shows a live reconciliation check.
Top-ups and transfers are idempotent (form key), per-user operations are serialised (no double-spend races).

## Before going live (not built yet)
- Licensed partner agreement + their API in `src/providers/` (Paynow adapter does EcoCash cash-in only, untested live;
  Paynow has no payout API, so withdrawals sit in the admin queue).
- Real KYC (ID photo + selfie, sanctions/PEP screening) and AML monitoring/reporting to FIU as your partner requires.
- 2FA/OTP by SMS on login and on sends, PIN for transfers, account lockout, password reset.
- Move limits and fees into the DB/admin UI; statement exports; backups on a paid Postgres plan.
- Terms, privacy policy (Zimbabwe Cyber and Data Protection Act), complaints process.
- Independent security review.
