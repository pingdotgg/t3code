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
    "codex": { "driver": "codex", "enabled": false }
  }
}
```

Nested objects merge key by key, so the example above turns off the built-in Codex instance and
keeps the rest of the user's Codex configuration. Arrays and plain values replace the user's value.
A provider instance entry needs its `driver`. Disabling the built-in `codex` instance does not stop
a user from adding a second Codex instance.

Telemetry export settings (`observability`) cannot be managed yet; T3 Code ignores them in a policy.

In a configuration profile, use the same top-level keys, with dictionaries for nested objects and
arrays for lists.

## When a policy changes

T3 Code reads the policy when its server starts. Restart the desktop app, or the `t3` server, to
apply a change. The user's own `settings.json` is never rewritten with managed values, so removing
a key from the policy restores the user's previous value.

If a policy file cannot be parsed, T3 Code ignores that file. If one key has an invalid value or is
not a known setting, T3 Code ignores that key and enforces the rest. Both cases are written to the
server log.
