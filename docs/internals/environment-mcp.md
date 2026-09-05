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

`t3_environment_preferences_update` accepts a separate literal patch schema and
constructs an existing `ServerSettingsPatch` field by field. The mutation runs
under `ThreadDispatchLockV2` for the calling thread. It reloads the caller under
that same lock, requires `full-access` plus `default`, and holds the lock through
`ServerSettingsService.updateSettings`. Ordinary V2 policy writers use the same
lock, so a concurrent downgrade is observed before persistence. The settings
service remains responsible for normalization, durable storage, and existing
cross-client notifications.

The mutation exposes preset background profiles, not arbitrary timing
overrides. Empty source-control instructions are an intentional clear; omitted
fields remain unchanged. Its result is projected from the settings returned
after persistence rather than from the request.
