# Managed settings

Organizations can enforce T3 Code settings on the machines they manage. A managed value overrides
the user's own value and any project override, and Settings shows that control as locked with
"Managed by your organization."

## Where to deploy a policy

T3 Code reads policy from these places, with later entries taking precedence:

| Platform | Source                                                            |
| -------- | ----------------------------------------------------------------- |
| macOS    | `/Library/Application Support/T3Code/managed-settings.json`       |
| macOS    | A configuration profile for the `com.t3tools.t3code` domain (MDM) |
| Linux    | `/etc/t3code/managed-settings.json`                               |

Write the files as root so users cannot edit them. On macOS, MDM tools such as Jamf, Kandji, or
Intune install profiles to `/Library/Managed Preferences/com.t3tools.t3code.plist`. When both a
file and a profile are present, the profile wins key by key.

Windows is not supported yet.

## Writing a policy

A policy uses the same keys as the server's `settings.json`. Include only the keys you want to
enforce:

```json
{
  "enableAgentBrowserAccess": false,
  "providerInstances": {
    "claudeAgent": { "driver": "claudeAgent", "enabled": false },
    "codex": { "driver": "codex", "config": { "binaryPath": "/opt/corp/bin/codex" } }
  },
  "observability": {
    "otlpTracesUrl": "https://otel.example.com/v1/traces",
    "otlpMetricsUrl": ""
  }
}
```

Nested objects merge key by key. Arrays and plain values replace the user's value.

### Providers

Manage a provider through `providerInstances`, keyed by instance id. The built-in instance of each
provider uses the provider's id, such as `codex` or `claudeAgent`. Each entry needs its `driver`.
Values under `config` merge into the user's configuration for that instance, so the example above
pins the Codex binary and keeps the user's other Codex settings. Set `enabled` to `false` to turn an
instance off.

A policy only reaches the instances it names. Disabling the built-in `claudeAgent` instance does not
stop a user from adding a second Claude instance.

### OpenTelemetry export

A managed `observability` URL replaces the user's URL for that signal, including one set through
`T3CODE_OTLP_*_URL` or `OTEL_*` environment variables. An empty string turns that signal's export
off. Users can still turn all export off with `OTEL_SDK_DISABLED`. Product usage telemetry is
separate and cannot be managed yet.

In a configuration profile, use the same top-level keys, with dictionaries for nested objects and
arrays for lists.

## When a policy changes

T3 Code reads the policy when its server starts. Restart the desktop app, or the `t3` server, to
apply a change. The user's own `settings.json` is never rewritten with managed values, so removing
a key from the policy restores the user's previous value.

If a policy cannot be read or parsed, or sets a key that is unknown or has an invalid value, T3 Code
refuses to start rather than run with part of the policy unenforced. The error names the file and
every bad key. Because unknown keys are rejected, deploy a policy that uses a new setting only after
every machine runs a T3 Code version that has it.
