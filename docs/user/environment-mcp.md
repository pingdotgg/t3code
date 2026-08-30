# Environment MCP tools

Agents can inspect the T3 Code environment that issued their MCP credential with
`t3_environment_read`. The tool reports the current environment identity,
platform, server version, supported T3 features, provider availability and
authentication status, and a small set of server-owned preferences.

Provider results are ordered by their opaque instance ID and paged. The read
uses the provider registry's existing cached state; it does not install,
refresh, authenticate, or reconfigure a provider. Provider model inventories,
credentials, configuration, environment variables, filesystem paths, raw
diagnostics, and account identities are not returned.

Human-readable labels and versions are capped at 256 Unicode characters. Source
control writing instructions are capped at 4,000 Unicode characters. Each such
value reports its original character count, the applied limit, and whether it
was truncated. Opaque environment and provider IDs are never shortened.

The preference snapshot is server-owned and applies across web, desktop, and
mobile clients connected to this environment. Client-local appearance and
desktop preferences are not available through this tool. Reading the
environment does not scan usage transcripts or trigger provider maintenance.

`t3_environment_preferences_update` can change only these server-owned fields:

- the default environment mode for new threads;
- whether new worktrees start from the configured origin;
- provider update checks;
- one of the balanced, performance, or battery-saver background-activity
  presets;
- source control writing mode, custom instructions, and change-request template
  behavior.

Omitted fields are retained. An explicit empty custom-instructions string clears
that value. The tool applies background activity through the existing nested
profile normalization and returns the actual allowlisted settings after they
are persisted. Existing settings notifications update connected web, desktop,
and mobile clients.

Environment-wide changes are available only while the calling thread remains
in full-access runtime mode with default interaction mode. Plan,
approval-required, and other restrictive callers cannot change these settings.
The tool cannot change provider configuration or credentials, filesystem paths,
observability, browser access, themes, pairing, tunnels, admin controls, or
client-local preferences.
