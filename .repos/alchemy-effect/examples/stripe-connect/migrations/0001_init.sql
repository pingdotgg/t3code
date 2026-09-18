CREATE TABLE merchants (
  id text PRIMARY KEY,
  email text NOT NULL,
  -- Stripe flips these on account.updated once hosted onboarding is done.
  details_submitted integer NOT NULL DEFAULT 0,
  charges_enabled integer NOT NULL DEFAULT 0,
  payouts_enabled integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);
