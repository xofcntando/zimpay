CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  kyc_status    TEXT NOT NULL DEFAULT 'none' CHECK (kyc_status IN ('none','pending','verified','rejected')),
  national_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- kind: user wallet | external (money held at bank/provider, goes negative) | fees | payout_hold
CREATE TABLE IF NOT EXISTS accounts (
  id       SERIAL PRIMARY KEY,
  user_id  INT REFERENCES users(id),
  kind     TEXT NOT NULL CHECK (kind IN ('user','external','fees','payout_hold')),
  currency TEXT NOT NULL CHECK (currency IN ('USD','ZWG')),
  balance  BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT user_no_overdraft CHECK (kind <> 'user' OR balance >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_user_cur ON accounts(user_id, currency) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_sys_cur  ON accounts(kind, currency)   WHERE user_id IS NULL;

CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            TEXT NOT NULL CHECK (type IN ('transfer','cashin','cashout')),
  status          TEXT NOT NULL CHECK (status IN ('pending','completed','failed','rejected')),
  currency        TEXT NOT NULL,
  amount          BIGINT NOT NULL CHECK (amount > 0),   -- minor units (cents)
  fee             BIGINT NOT NULL DEFAULT 0 CHECK (fee >= 0),
  initiator_id    INT NOT NULL REFERENCES users(id),
  counterparty_id INT REFERENCES users(id),
  msisdn          TEXT,            -- mobile wallet number for cash-in/out
  note            TEXT,
  provider        TEXT,
  provider_ref    TEXT,
  poll_url        TEXT,
  idem_key        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tx_idem ON transactions(initiator_id, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tx_init ON transactions(initiator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tx_cp   ON transactions(counterparty_id, created_at DESC);

-- double entry: entries of one transaction always sum to zero
CREATE TABLE IF NOT EXISTS entries (
  id             BIGSERIAL PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  account_id     INT NOT NULL REFERENCES accounts(id),
  amount         BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entries_tx ON entries(transaction_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   INT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO accounts(kind,currency) SELECT k,c FROM (VALUES ('external'),('fees'),('payout_hold')) a(k)
  CROSS JOIN (VALUES ('USD'),('ZWG')) b(c) ON CONFLICT DO NOTHING;
