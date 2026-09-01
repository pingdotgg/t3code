# Model manifest

`apps/server/src/provider/model-manifest.json` is bundled for offline startup and fetched from
`main` at runtime. A successful remote fetch is cached on disk. Invalid provider-specific data
falls back to the bundled provider catalog.

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
