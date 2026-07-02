# GitHub Copilot

T3 Code can run GitHub Copilot CLI through its ACP server mode.

## Setup

Install and authenticate GitHub Copilot CLI:

```bash
copilot login
```

Then enable the GitHub Copilot provider in T3 Code settings. The default command is:

```bash
copilot --acp --stdio
```

Use the provider's Launch arguments setting for Copilot CLI flags that should be passed before
`--acp --stdio`, such as tool filters or reasoning effort.
