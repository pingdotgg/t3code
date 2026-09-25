# Investigate wrong T3 titles with Pydantic

Three constructed first messages exercise T3's real initial-title prompt builder
and Codex adapter with Luna. There are no later messages, previous titles, or topic
changes. The branch intentionally reproduces an input-truncation regression; it
is a sponsor demo, not a claim about the released app or a model benchmark.

The visible problem: the user asks for offline search, but the generated title is
about label colors. The request includes a long diagnostic export. The live
investigation measures whether the title names the requested subject. Character
and word counts remain visible as observations.

## Prepare before recording

Use Node 24, `vp`, `uv`, and an authenticated Codex CLI with Luna and Astra access:

```sh
vp i
cp docs/operations/logfire-demo.env.example .env.local
# Add your Logfire project's write token to .env.local.
node demos/logfire-titles/start.mjs
```

Open the printed pairing URL. State stays in this checkout's `.t3`. In another
terminal, publish the baseline once before filming:

```sh
uv run demos/logfire-titles/evaluate.py --name baseline
codex mcp add logfire --url https://logfire-us.pydantic.dev/mcp
# If configured but unauthenticated: codex mcp login logfire
```

For a separate recording desktop with the examples and an empty Astra Medium
thread, keep `start.mjs` running:

```sh
vp run build:desktop
node demos/logfire-titles/desktop.mjs
```

The recording desktop uses `.t3/recording-desktop` and ports 14242/6202. Its built
backend stays running while the agent edits the checkout. Evaluations load the checkout's first-message prompt builder and production Codex
adapter in a fresh process, then copy the actual results into the recording sidebar.
They do not send a coding-agent turn or call title regeneration. Subsequent
launches preserve the investigation. Alternatively, investigate from a fresh
Astra Medium thread in your regular T3 installation, bound to this checkout.

## Record

Open the offline-search example. Keep its opening sentence and the wrong title
visible together. Ask:

> I asked for offline search, but the title is about label colors. Can you use Logfire to find out why, fix it, and check the three demo chats?

Use the recorded baseline as the before measurement. After the fix, run one pass:

```sh
uv run demos/logfire-titles/evaluate.py --name after
```

The finish line is a Logfire trace explaining the wrong subject, a focused fix,
and three subject checks passing in **T3 first-message titles**. A regression test belongs
with the fix. Prompt style tuning, repeated benchmark runs, and broader cleanup
are outside this short investigation. The default is one call per case; do not
repeat the already-recorded baseline during filming.

Keep Logfire beside the agent. Native MCP calls show the Pydantic mark, tool name,
status, and expandable details. The agent chooses its queries and implementation.
If its MCP account has several projects, name the one receiving this demo's traces.

The traces record supplied inputs, outputs, source conversation, actual CLI tool
events and aggregate token usage. Full system context and individual model requests
are not exposed by the CLI; the telemetry labels those limits. Only title and agent
activity export. `title-prompt.txt` starts empty to use the built-in instructions.

Compare experiments with matching corpus hashes and evaluator definitions. The
subject check uses vocabulary groups, so read the outputs too. Earlier **T3 title pipeline** and **T3 title subject** datasets used multi-message
regeneration and are separate experiments.

## Replay

Save the investigator's changes, restore its changed files to the branch baseline,
and prepare a fresh baseline before the next recording:

```sh
node apps/server/scripts/logfire-title-demo.mjs reset
uv run demos/logfire-titles/evaluate.py --name baseline-take-2
```

Run names must be unique. Reset restores saved titles; evaluation makes fresh calls
and wording can vary. Credentials and local run artifacts stay untracked.
