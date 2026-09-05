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
