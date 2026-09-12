# Drive T3 Code from an agent

`t3 drive` gives scripts and agents JSON access to running environments and repeatable synthetic conversation states. Use `t3 drive --help` for commands and each subcommand's `--help` for flags.

## Control a running environment

Start an environment normally, then use the same T3 home:

```sh
t3 drive snapshot --home-dir /tmp/t3-demo
t3 drive snapshot --home-dir /tmp/t3-demo --thread THREAD_ID
t3 drive send --home-dir /tmp/t3-demo THREAD_ID "Verify the changes and report the results."
```

The environment snapshot includes projects and thread metadata, including archived threads. Request a thread snapshot to inspect its messages, activities, plans, and checkpoints. `send` starts a real provider turn using that thread's current model and permission modes. Its JSON response includes the command ID, message ID, and persisted sequence. Acceptance means the command was saved, not that the provider has completed the work.

For project and thread creation, archive/unarchive, settle/unsettle, interruption, approval responses, and other actions, write a client command to a JSON file:

```sh
t3 drive schema > command.schema.json
t3 drive dispatch command.json --home-dir /tmp/t3-demo
```

Commands use the same validation, authorization, and event handling as the app. Supply a unique `commandId` for each new action; reusing an ID makes a retry idempotent. Internal synthetic commands are rejected by live dispatch. A missing or unreachable server is an error; live commands never switch to offline database access.

To connect to a remote environment, replace `--home-dir` with `--url https://your-environment.example` and supply an existing environment bearer session in `T3_DRIVE_TOKEN`. Read operations require `orchestration:read`; mutations also require `orchestration:operate`. Keep tokens out of command files and source control. Local commands create and revoke their own temporary session.

## Build a repeatable scenario

Generate an editable example with empty, completed, streaming, error, and archived threads:

```sh
t3 drive example --workspace /path/to/project > scenario.json
t3 drive schema --scenario > scenario.schema.json
t3 drive serve scenario.json --home-dir /tmp/t3-drive-example
```

`serve` starts the real application server, loads the scenario before it becomes ready, and leaves orchestration reactors and session recovery disabled. Synthetic streaming and error states remain available to inspect. Pair the web, desktop, or mobile client with the printed URL. This is a demo environment: provider turns, checkpoint work, and other reactor-driven actions do not run. Direct terminal, filesystem, and git controls still operate normally.

To generate a home without starting a server, use `t3 drive scenario scenario.json --home-dir /tmp/t3-drive-offline`. Starting that home later with `t3 serve --base-dir /tmp/t3-drive-offline` enables normal recovery, which changes orphaned running sessions into errors. Use `drive serve` for stable synthetic states.

The destination must not already exist, even as an empty directory. Use a new path for each run. Scenarios never overwrite an existing home. The workspace path points at an existing project; generating or loading the example does not create workspace files.

A scenario is `{ "version": 1, "commands": [...] }`. Edit the example or use the schema to describe assistant deltas and completions, imported history, sessions, activities, plans, diffs, and other durable domain state. The entire file is schema-validated before creating the home, and duplicate command IDs are rejected. Commands then run in order through the event engine and its projections, without provider processes or side-effect reactors. The output identifies the new home and its shell snapshot. If a command violates a domain invariant, the error identifies the command and retains the partial home for inspection; retry with a corrected scenario and a new home.

Scenarios reproduce persisted application state, not external filesystem contents, provider callbacks, terminal processes, network failures, or every transient client state. Starting a normal server restores normal provider and recovery behavior. Synthetic approval requests do not create real provider callbacks. Use real turns and the client to verify those interactions.

Compare thread snapshots with expected values in your agent or shell assertions, and inspect the corresponding client behavior. Scenario data makes a verification case repeatable; it does not itself establish that there are no regressions.
