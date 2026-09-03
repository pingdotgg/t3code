# Custom model reasoning profiles

T3 Code can add a Reasoning menu to a manually configured Claude custom model. Profiles are supported beside `customModels` in a named entry under `providerInstances.<id>.config`. There is no separate profile file or in-app profile editor.

Profiles do not change built-in Claude models or models from other providers.

## Configure a profile

Edit `~/.t3/userdata/settings.json` on the machine running the T3 Code server. The settings watcher reloads valid changes without a restart.

Do not add profiles under the legacy `providers.claudeAgent` object. If the Claude provider exists only there, edit it once in **Settings → Providers** first; T3 Code migrates it into `providerInstances`.

```json
{
  "providerInstances": {
    "claude_gateway": {
      "driver": "claudeAgent",
      "config": {
        "customModels": ["gpt-5.6-sol"],
        "customModelProfiles": {
          "gpt-5.6-sol": {
            "capabilities": {
              "reasoning": {
                "levels": ["low", "medium", "high"]
              }
            }
          }
        }
      }
    }
  }
}
```

The profile key must match a trimmed entry in `customModels` for the same Claude provider. Each profile chooses an ordered subset of `low`, `medium`, `high`, `xhigh`, and `max`.

## Composer behavior

T3 Code adds **Default** before the configured values and keeps their order. When the Claude runtime starts, Default omits `--effort` so Claude Code uses its configured default. Other choices are passed without built-in model compatibility remapping.

Web, desktop, and mobile use the same provider capability metadata.

## Validation

An invalid profile marks only that named Claude provider instance unavailable. Other settings and providers remain active. Correct the profile to restore the instance.

- `levels` must contain at least one unique value.
- Each level must be `low`, `medium`, `high`, `xhigh`, or `max`.
- Every profile key must match a custom model in the same Claude provider.
- A built-in catalog entry wins when a custom model uses the same slug, so its profile is ignored.

A custom model does not need a profile. Without one, its current behavior remains unchanged.

When a level is removed, a saved selection that used it resolves to Default. When a custom model is removed in Settings, T3 Code removes its matching profile in the same update.
