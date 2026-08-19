# v1 stops on provider quota, not a user-set budget

Codex Goals have a user-set token cap and a separate usage-limited state. A cap needs Thread-scoped usage accounting and extra UI. Retrying quota errors does not: an Active Goal would spin on 429s.

We decided v1 has no user-set token budget. If a Turn fails because the provider account is usage-limited or rate-limited, the Goal enters Usage-limited and auto-continue stops. Resume tries again. Blocked remains “the work is stuck,” not “the account is exhausted.”
