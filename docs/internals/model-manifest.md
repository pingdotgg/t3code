# Model manifest

`apps/server/src/provider/model-manifest.json` is bundled for offline startup and fetched from
`main` at runtime. A remote fetch replaces the in-memory and on-disk cache only after generic
catalog references and provider-owned adapter data validate. A failed or invalid fetch keeps the
last successful remote manifest. The bundle is used when no valid remote cache exists, or when
the bundle's `updatedAt` is later than the cached manifest's, so a release that edits the manifest
takes effect before the next successful fetch. Bump `updatedAt` whenever you edit the file.

The top-level provider catalog is generic: models contain presentation metadata, aliases, status,
an optional badge, and a reusable capability profile. The profile and model `adapter` fields are
opaque until the owning provider validates them with its own allowlisted schema.

Claude Code uses the manifest as its complete built-in model catalog. To add a Claude model that
uses an existing profile, add one object to `providers.claudeAgent.models`. Do not add a test or
change application code. Add or change a profile in the same JSON file only when the model exposes
a capability combination that does not already exist.

`currentModels.claudeAgent` is retained as a frozen compatibility field for releases that predate
catalog discovery. New Claude models do not need to be added there. Codex still discovers models
from its app server and uses `currentModels.codex` only as a legacy-classification overlay.

Claude model entries support:

- `aliases`, `status`, `badge`, and `profile` for client presentation and selection.
- `adapter.claudeCode.minVersion` and `maxVersionExclusive` for installed-runtime compatibility.
- Profile-level effort mappings, model suffixes, and context-window metadata for dispatch.

## Test policy

Changing model data does not require tests. Do not add or update tests for a model slug, display
name, alias, legacy status, version boundary, badge, or profile assignment. The bundled manifest is
configuration and is validated by its schema when imported.

Add tests only when implementation behavior changes:

- Fetching, caching, fallback, or schema-version handling changes in the manifest service.
- Provider-neutral profile resolution gains new semantics.
- A provider adapter gains a new compatibility or dispatch mapping type.

Resolver tests must use synthetic providers and model names so normal JSON edits never create test
churn.
