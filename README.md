# ZimPay (sandbox)

(c) 2026 Ntandomods. Released under the [MIT License](LICENSE).
The MIT license covers the code only. It is not a payment or money-transfer licence: anyone running this with real funds must hold the required Reserve Bank of Zimbabwe authorisation or operate through a licensed partner.

Wallet-to-wallet money transfer app for Zimbabwe: USD and ZiG wallets, send by mobile number, add money, withdraw,
ID verification queue, admin console, double-entry ledger. Node 20+, Express, MongoDB (Atlas).

**Status: SANDBOX ONLY.** No real money moves. Operating this with real funds in Zimbabwe requires an RBZ payment
service provider licence, or running on top of a licensed partner who holds the funds and the licence.
The app refuses to start with a live provider unless `LICENSED_PARTNER_CONFIRMED=yes`.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Create a free MongoDB Atlas cluster, add a database user, allow network access (0.0.0.0/0 on Render free), copy the connection string.
3. Render dashboard > New > Blueprint > select the repo. Set `MONGODB_URI` to the Atlas string.
4. Set `BASE_URL` (your onrender.com URL) and `ADMIN_PHONE` (your number). Register with that number to become admin.

## Run locally
    npm install && MONGODB_URI=mongodb+srv://... npm start
    npm test        # spins up an in-memory MongoDB replica set, no setup needed

## Payment modes
- `mock` (default): sandbox, instant fake payments.
- `manual`: customers send EcoCash to `MERCHANT_ECOCASH_NUMBER` and submit the reference; an admin confirms in `/admin`. No third-party API. Each reference can be used once. Withdrawals are also paid by hand.
- `paynow`: EcoCash push prompt via Paynow (cash-in only; test it in Paynow test mode first).
The two live modes require `LICENSED_PARTNER_CONFIRMED=yes`.

## How money is modelled
Amounts are integer cents. Every movement is a transaction with ledger entries that sum to zero.
`external` = money held at the bank/provider (negative when users hold balances), `fees`, `payout_hold`.
Posting uses MongoDB multi-document transactions (needs a replica set, which Atlas always is). A wallet debit only matches if the balance covers it, so wallets cannot go below zero. Concurrent writes for the same user conflict and retry. Admin page shows a live reconciliation check.
Top-ups and transfers are idempotent (form key), per-user operations are serialised (no double-spend races).

## Before going live (not built yet)
- Licensed partner agreement + their API in `src/providers/` (Paynow adapter does EcoCash cash-in only, untested live;
  Paynow has no payout API, so withdrawals sit in the admin queue).
- Real KYC (ID photo + selfie, sanctions/PEP screening) and AML monitoring/reporting to FIU as your partner requires.
- 2FA/OTP by SMS on login and on sends, PIN for transfers, account lockout, password reset.
- Move limits and fees into the DB/admin UI; statement exports; a paid Atlas tier with backups (M0 free has none).
- Terms, privacy policy (Zimbabwe Cyber and Data Protection Act), complaints process.
- Independent security review.
