# Modal Sandbox Secrets

Task sandboxes receive credentials through named Modal Secrets. Store only the Modal Secret names in
project configuration; never store raw token values in Convex.

Recommended MVP secrets:

| Modal Secret            | Required keys                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `t3-git-auth`           | `GH_TOKEN` or `GITHUB_TOKEN`                                                                                                     |
| `t3-codex-subscription` | `T3_CODEX_AUTH_JSON_B64`                                                                                                         |
| `t3-opencode-bedrock`   | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`, `T3_OPENCODE_MODEL`; optional `OPENCODE_CONFIG_CONTENT`, `T3_OPENCODE_CONFIG_JSON_B64` |
| `t3-execution-bridge`   | `T3_EXECUTION_BRIDGE_SHARED_SECRET`                                                                                              |

Optional keys:

- `T3_CODEX_CONFIG_TOML_B64`: writes `$CODEX_HOME/config.toml`.
- `T3_GH_HOSTS_YML_B64`: writes GitHub CLI `hosts.yml`.
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`: use these instead of
  `AWS_BEARER_TOKEN_BEDROCK` only when using standard AWS credentials.
- `AWS_DEFAULT_REGION`: accepted by AWS SDK tooling when `AWS_REGION` is not used.

Base64 helpers:

```sh
base64 < ~/.codex/auth.json | tr -d '\n'
base64 < ~/.codex/config.toml | tr -d '\n'
base64 < ~/.config/gh/hosts.yml | tr -d '\n'
```

Attach the secret names to the Project:

```json
{
  "sandboxProvider": "modal",
  "modalAllowedSecretNamesJson": "[\"t3-git-auth\",\"t3-codex-subscription\",\"t3-opencode-bedrock\",\"t3-execution-bridge\"]"
}
```

The runtime entrypoint decodes file-backed secrets before starting T3, configures `GH_TOKEN` for
`gh`, configures Git credentials for HTTPS pushes, and preserves `OPENCODE_CONFIG_CONTENT` for
OpenCode Bedrock provider configuration.

When `T3_OPENCODE_MODEL` is present, the entrypoint also bootstraps T3 server settings so OpenCode is
the default provider for coding turns and PR text generation. For the current MVP E2E this is:

```sh
T3_OPENCODE_MODEL=amazon-bedrock/us.anthropic.claude-opus-4-7
```

For OpenCode Bedrock, keep `OPENCODE_CONFIG_CONTENT` minimal and let OpenCode use its bundled
Amazon Bedrock provider. The working MVP shape is:

```json
{
  "provider": {
    "amazon-bedrock": {
      "options": {
        "region": "us-east-1"
      }
    }
  },
  "model": "amazon-bedrock/us.anthropic.claude-opus-4-7",
  "small_model": "amazon-bedrock/us.anthropic.claude-opus-4-7"
}
```
