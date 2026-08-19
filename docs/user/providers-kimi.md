# Kimi

T3 Code can run agents on Moonshot AI's Kimi models (K3, Kimi K2.7 Coding) through the official
Kimi CLI. For first-time setup of T3 Code itself, see [Install T3 Code](./install.md).

## Requirements

- The Kimi CLI (`kimi`) installed and on your PATH. Use the official install script
  ([full instructions](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)):

  ```bash
  # macOS / Linux
  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
  # Windows (PowerShell)
  irm https://code.kimi.com/kimi-code/install.ps1 | iex
  ```

  or npm: `npm install -g @moonshot-ai/kimi-code`

- On Windows, the Kimi CLI requires [Git for Windows](https://git-scm.com/downloads/win) for its
  shell environment. If Git Bash is installed in a custom location, set the `KIMI_SHELL_PATH`
  environment variable to your `bash.exe`.
- A Kimi account with a Kimi For Coding subscription.

## Sign In

You can sign in from inside T3 Code: open Settings → Providers, find the Kimi provider, and press
**Sign in with Kimi**. Approve the sign-in in your browser (the shown code must match), and the
provider flips to authenticated on its own.

Signing in from a terminal works too:

```bash
kimi login
```

Both paths store the same credential, and the Kimi CLI keeps it refreshed from then on. To sign
out, run `kimi logout`.

## Models

T3 Code discovers the models your subscription offers when the provider is checked. Current plans
include:

```text
k3                          Kimi K3 (default)
kimi-for-coding             Kimi K2.7 Coding
kimi-for-coding-highspeed   Kimi K2.7 Coding Highspeed
```

Pick the model per thread from the model picker, like any other provider.

## Separate Accounts Or Sandboxes

The Kimi provider settings include a `KIMI_CODE_HOME path`. When set, T3 Code points the Kimi CLI
at that directory for credentials and sessions, so a second provider instance with its own
`KIMI_CODE_HOME path` runs against a separate Kimi account. Signing in from the provider card
writes the credential into that instance's directory.
