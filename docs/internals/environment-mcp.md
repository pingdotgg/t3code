# Environment MCP boundary

The environment MCP family exposes the running `ServerEnvironment`, cached
`ProviderRegistry`, and `ServerSettingsService` through explicit contracts. It
does not instantiate another environment service and has no environment target
selector: the MCP credential's environment must match the running descriptor.

`t3_environment_read` is a closed-world, read-only tool. Its provider page is
sorted by opaque provider instance ID and contains normalized status,
capability, authentication, version, and model-count fields only. Raw provider
messages, model inventories, account data, settings records, paths, environment
variables, and self-update or relay administration are outside the contract.
Service failures are returned distinctly from a healthy empty provider list.

Display text is bounded by Unicode code points before result encoding. The wire
schema deliberately does not use `Schema.isMaxLength` for those fields because
that validator counts UTF-16 code units and would reject an in-bound astral
character value. Each text window carries the original character count, limit,
and truncation state.

The preference projection is a literal allowlist. It must be extended field by
field; never spread a server settings or provider configuration object into an
MCP result. Environment reads use cached provider state and do not call provider
refresh or the usage service.
