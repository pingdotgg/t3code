# FORK-CHANGES.md — upstream divergence ledger

This fork (`atlasinc-global/vector-workspace`) rebases on `pingdotgg/t3code` forever
(RULE #1 in `AGENTS.md`). Every change to an **upstream-owned file** is recorded here so
rebases stay cheap. All Atlas customization that lives in NEW `atlas-*` files/dirs/packages
does **not** need an entry — this ledger is only for edits to files that also exist
upstream.

Each entry: **file · why · how to re-apply after rebase.**

| File | Why | How to re-apply after an upstream rebase |
| --- | --- | --- |
| `AGENTS.md` (and its `CLAUDE.md` symlink) | Replaced T3's agent guide with the Atlas Vector fork guide (Rule #1, two-backend architecture, FastAPI feature map). One intentional upstream-doc divergence. | Persistent divergence — on conflict keep the Atlas version; fold any genuinely useful new upstream guidance into the "Upstream T3 essentials" section at the bottom. |
