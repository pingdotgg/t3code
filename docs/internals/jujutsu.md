# Jujutsu

## Detection stops at the nearest marker

[`findVcsMarkerRoot`](../../apps/server/src/vcs/JjRepo.ts) walks up and stops at the first `.jj` or
`.git`, nearest wins. A `.jj` a few levels up must not hijack a nearer Git checkout.
A missing directory returns no marker root; it cannot climb into an unrelated repository above it.
[`VcsProjectConfig`](../../apps/server/src/vcs/VcsProjectConfig.ts) resolves the repository's
`.t3code/vcs.json` preference before driver detection.

## `git.abandon-unreachable-commits=false` on every command we run

A colocated repository imports Git refs during jj commands. The default unreachable-commit abandonment can rewrite local history after an external Git ref moves. [`JjProcess.ts`](../../apps/server/src/vcs/JjProcess.ts) passes `git.abandon-unreachable-commits=false` on T3 Code's jj commands so a later status read does not abandon that history. This does not change the user's jj configuration.

## Repository-local configuration and machine output

Availability probes are cached per repository, not globally: a broken repository configuration
must not disable Jujutsu in another checkout. Failed probes retain jj's stderr rather than
reporting an installed binary as missing.

Machine templates access keywords through `self` methods so user keyword aliases cannot shadow
them. If configuration changes a template function's output, decoding reports the failing field
path without including the output value.
