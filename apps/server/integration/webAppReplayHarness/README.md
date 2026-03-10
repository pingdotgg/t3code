# webAppReplayHarness

Internal integration-testing package for deterministic record/replay browser E2E flows.

## Design

- **Fixture-driven replay core** (`interactionResolver`, `template`, `fixtureLoader`)
- **Process replay transport** (`jsonRpcProcessReplay`) for JSON-RPC-over-stdio CLIs (Codex today)
- **CLI replay transport** (`cliReplay`) for execute-oriented command surfaces (Git/GitHub CLI today)
- **Service adapters** (`services`, `codexProcess`) that map app services onto replay transports
- **App harness bootstrap** (`createHarness`) to boot server + Vite against replay dependencies

The goal is to keep replay infra stable as new IO methods are added: fixtures encode IO contracts while adapters stay thin.
