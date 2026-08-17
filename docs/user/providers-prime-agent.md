# Prime Agent

Prime Agent support is available as an early-access provider. T3 Code connects to the
`prime-agent` CLI on the server machine and keeps each T3 thread in an isolated Prime Agent
session directory.

## Install And Log In

Install Prime Agent:

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
```

Start it once and use `/login` to authenticate a supported subscription:

```bash
prime-agent
/login
```

API keys also work. Put the provider's key, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`PRIME_API_KEY`, in the Prime Agent provider instance's Environment variables in T3 Code. Mark
keys as sensitive so they are stored as server secrets.

In Settings, enable Prime Agent and leave **Binary path** as `prime-agent` unless the command is
outside the server's `PATH`.

Prime Agent does not expose credential status through ACP, so T3 Code can verify the CLI and model
catalog but may show authentication as unknown. If a turn reports an authentication error, run
Prime Agent in a terminal and use `/login`, or check the provider instance's API key environment
variable.

## Choose A Model

T3 Code reads Prime Agent's installed model catalog and shows exact `provider/model` choices.
The **Prime Agent Default** entry does not override Prime Agent's model. It uses the model selected
in Prime Agent's own configuration.

Model changes start a new thread. Prime Agent's current ACP interface selects the model when the
provider process starts and does not switch it inside an existing session.

## Continue A Thread

T3 Code gives every Prime Agent thread its own session directory. Reopening a thread continues the
latest Prime Agent session in that directory, including after the T3 Code server restarts.

Different Prime Agent provider instances keep separate T3-managed thread directories. Their
credentials and global Prime Agent configuration still come from the environment in which each
instance runs.

## Permission Mode

Prime Agent currently supports **Full Access** in T3 Code. Its built-in IPython tool runs with the
same operating-system permissions as the T3 Code server and does not expose the approval and
sandbox controls required by the other T3 permission modes.

T3 Code rejects a Prime Agent session started with another permission mode instead of presenting a
mode it cannot enforce. Use a separate operating-system account or another isolation boundary when
the workspace must not have full host access.
