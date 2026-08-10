# T3 baseline and Auldric extension policy

This path replaces the legacy compatibility ledger. T3 is not a vendor reference for this
repository; it is the authority for Dev and shared platform infrastructure.

Issue #2 owns the current pinned T3 ref, canonical remotes, ancestry checks, update procedure,
shared-core drift guard, and any reviewed temporary seam. Do not duplicate a pin here.

## Policy

- Adopt each selected T3 baseline as the complete platform baseline.
- Keep downstream work additive and isolated to approved Marketing modules or bounded distribution
  configuration.
- Never resolve a T3 conflict by keeping legacy Auldric platform behaviour.
- Do not selectively port provider, session, auth, transport, Connect, remote, Git, terminal,
  preview, CI, release, shell, or generic collaboration implementations.
- Propose a required generic seam upstream and park downstream work until it is supported.
- Preserve T3 internal package, protocol, storage, compatibility, and Dev identities; issue #3 owns
  the separate outward identity matrix.

The read-only legacy checkpoint remains donor evidence only. Issue #14 records whether a specific
Marketing requirement is rebuilt, split, replaced by T3, retired, historical, or upstream-dependent.
