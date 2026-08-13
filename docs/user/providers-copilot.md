# GitHub Copilot

T3 Code connects directly to the official GitHub Copilot CLI through its ACP server. It does not
route Copilot through OpenCode.

## Install

Install the CLI globally:

```bash
npm install -g @github/copilot
```

Then authenticate:

```bash
copilot login
```

Keep the provider's Binary path set to `copilot` unless the executable is installed elsewhere.

## Token Authentication

The Copilot CLI also accepts authentication from environment variables. Add one of these to the
Copilot provider instance in Settings:

```text
COPILOT_GITHUB_TOKEN
GH_TOKEN
GITHUB_TOKEN
```

Mark tokens as sensitive. The CLI decides credential precedence and can also use a stored
`copilot login` or GitHub CLI (`gh auth`) session. T3 Code forwards the provider environment,
including `COPILOT_HOME`, without interpreting credentials.

## Early Access

GitHub currently describes ACP support as a public preview. T3 Code labels the provider Early
Access because CLI behavior may change while that preview evolves.
