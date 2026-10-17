# Jujutsu

## Detection stops at the nearest marker

[`findVcsMarkerRoot`](../../apps/server/src/vcs/JjRepo.ts) walks up and stops at the first `.jj` or
`.git`, nearest wins. A `.jj` a few levels up must not hijack a nearer Git checkout.
A missing directory returns no marker root; it cannot climb into an unrelated repository above it. An explicit `.t3code/vcs.json` selection is resolved by [`VcsProjectConfig`](../../apps/server/src/vcs/VcsProjectConfig.ts) before automatic driver detection.

## `git.abandon-unreachable-commits=false` on every command we run

A colocated repository imports Git refs during jj commands. The default unreachable-commit abandonment can rewrite local history after an external Git ref moves. [`JjProcess.ts`](../../apps/server/src/vcs/JjProcess.ts) passes `git.abandon-unreachable-commits=false` on T3 Code's jj commands so a later status read does not abandon that history. This does not change the user's jj configuration.
