# Subscription allowance release evidence

> For maintainers. This is an evidence checklist, not a release declaration.

The Subscription view is release-ready only when each evidence class is complete. Keep the
receipts privacy-sanitized and record the exact client, server, provider, environment, and commit
used for each live or integrated pass. Do not treat an implementation commit, a worker report, or
green automated tests as proof of a live provider, remote, or release outcome.

## Evidence states

Record these states separately in the release record:

| State         | Meaning                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Implemented   | The scoped code and documentation exist locally.                                                       |
| Tested        | Focused tests, targeted formatting/linting, and scoped typechecks passed.                              |
| Live-verified | A real configured provider/environment returned the required sanitized evidence.                       |
| Documented    | User and maintainer behavior, privacy, compatibility, and rollout boundaries are written down.         |
| Release-ready | Every required provider, client, connection, regression, privacy, and evidence gate below is complete. |

## Production residue

- [ ] The shipped source contains no fixture allowance values, alternate prototype variants, URL
      variant selector, or prototype switcher.
- [ ] The production Usage path opens on Subscription and still reaches unchanged Historical
      behavior through the segmented control.
- [ ] No release note or user-facing document calls the owner-selected Claude rollout Anthropic
      approval or a compliance determination.

## Automated validation

- [ ] Contract tests cover native Codex and Claude snapshots, sparse updates, nullable values,
      freshness, provenance, privacy-safe identity, and compatibility.
- [ ] Provider reader tests cover Codex mapping and Claude initialization-before-usage, zero user
      messages, no model turn, bounded cleanup, native field preservation, unavailable responses,
      and experimental-method compatibility.
- [ ] Server lifecycle tests cover snapshot-first demand, single-flight/manual refresh, five-minute
      refresh bounds, sparse folding, stale transitions, generation safety, reconnect, demand
      teardown, and cleanup.
- [ ] Shared projection and web/mobile presentation tests cover multiple sources, exact identity
      grouping, whole-source selection, provider placeholders, observation age, derived source
      currentness, refreshing/loading states, accessibility, and unchanged Historical controls.
- [ ] Focused tests, targeted formatting/linting, and scoped typechecks pass for every changed
      package. Repository-wide checks are CI-owned unless separately requested.

## Provider evidence

Store snapshots outside the repository or in an approved sanitized evidence location. Redact
credentials, raw payloads, unmasked emails, configuration paths, transcripts, session IDs, and
local behavior data. Keep only provider-reported fields needed to prove the UI.

### Codex positive path

- [ ] An enabled configured Codex instance returned a complete snapshot through the production
      provider reader.
- [ ] The record shows the provider-native window scope, used/remaining meaning, reset time, and
      credits or spending controls only where Codex supplied them.
- [ ] The captured instance/environment label is privacy-safe and the receipt identifies the exact
      build and server without exposing secrets.

### Claude positive path

- [ ] An enabled configured Claude instance with an active subscription returned
      `rate_limits_available: true` through the configured Agent SDK path.
- [ ] The sanitized receipt proves initialization, the usage control request, zero user messages,
      no model turn, cleanup, and provider-native window/extra-usage fields.
- [ ] The receipt does not infer a plan, account state, scope, or approval from fields Claude did
      not report.

### Claude unavailable path

- [ ] An authenticated response with unavailable limits renders the exact placeholder:
      `Claude did not report subscription usage limits.`
- [ ] The evidence does not claim why limits were absent.

## Integrated acceptance

### Web and desktop

- [ ] One integrated pass covers Subscription/Historical switching, both providers, manual refresh,
      loading/refreshing/unavailable states, observation-age updates, non-current source selection,
      multiple instances/environments, accessibility, unchanged Historical content, and desktop parity.
- [ ] Remote disconnect/reconnect and newer-client/older-server compatibility are observed.
- [ ] Before/after images are captured; capture a short recording when refresh or live-update timing
      is material.

### Mobile

- [ ] One integrated pass covers the equivalent provider/state/refresh/remote/accessibility
      behavior in a supported simulator or device, including compact layout and unchanged
      Historical content.

## Release boundary

Do not declare the feature released until all boxes above are checked and the release record names
which state is supported by each receipt. This checklist does not authorize pushing, merging,
deploying, changing issue state, or closing the parent or child issue. The public Claude rollout is
an owner decision about the configured runtime path; it must never be described as Anthropic
approval or a compliance determination.
