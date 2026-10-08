# Model manifest

The [bundled manifest](../../apps/server/src/provider/model-manifest.json) allows
offline startup; fetching it from `main` lets model metadata change between
releases. Failed fetches or invalid data preserve the last usable manifest.
Remote data must pass both catalog-reference validation and the owning provider's
adapter validation before replacing the cache.

A newer bundle outranks the cached remote manifest by `updatedAt`, so a release can
correct model data before the next successful fetch. Bump `updatedAt` whenever the
file changes. Fetch time cannot establish which copy contains the newer edit.

Generic catalog data describes presentation and capabilities. Each provider owns
its adapter schema and dispatch mappings. Claude uses the manifest for its entire
built-in catalog. Adding a model with an existing capability profile is a JSON
edit; a new profile is needed only for a new capability combination. Codex still
gets its model list from its app server.

A model that needs a newer provider CLI should still be announced as soon as it
ships. Claude entries set `adapter.claudeCode.minVersion`; Codex entries set
`adapter.codex.minVersion`, since Codex's own `model/list` cannot name models
released after the installed build. Snapshots report those models in
`updateRequiredModels`, and the picker tells the user which update unlocks them.

`currentModels.claudeAgent` is the current-model classification overlay for
releases that predate catalog discovery; it does not add models to their catalogs.
Catalog-aware releases use `providers.claudeAgent.models[].status` instead.
Codex uses `currentModels.codex` as a legacy-classification overlay for discovered
models.

Model data is schema-validated configuration. Tests should cover resolver, cache,
and adapter semantics with synthetic model names, so adding a model never requires
tests that repeat the configuration.
