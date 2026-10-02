# Live background-work verification

Run from the repository root with Node 24 and installed dependencies. This uses
real provider CLI credentials and consumes model usage:

```sh
node apps/server/scripts/verify-background-live.ts --repeat 2
```

Each scenario starts the production server in a fresh temporary T3 home and Git
project. It connects through authenticated HTTP and the same typed WebSocket RPC
contract as clients. There are no substituted adapters, in-memory databases, or
seeded projection rows. Existing T3 environments are not modified.

The scenarios exercise delegated completion after the parent ends its turn,
delivery into an active foreground command, native background-command wake-up,
and nested delegated results. A local HTTP request holds the actual background
command until the required parent state is observed. Its random response is not
included in the parent prompt. Passing requires the agent to retrieve that result,
acknowledge it, and finish; a delivery receipt alone is insufficient.

Assertions also check task-result publication, acknowledgement state, typed
notifications rather than additional user-message items, run boundaries, and an
empty provider background roster. Successful scenarios restart the real server
and check that the acknowledgement survives and runs remain completed. This is
a clean-restart persistence check, not proof of crash recovery during delivery.

Use `--scenario idle|active|native|nested`, `--model`, `--provider`, and `--timeout`
in seconds to narrow a run. The default provider is `claudeAgent` and the default
model is `claude-sonnet-4-6`. The native scenario specifically requests Claude's
background Bash tool; do not treat it as generic provider conformance. Active
delivery expects a provider supporting active steering. Missing authentication,
unsupported capabilities, provider failures, and model instruction violations
are failures, never skipped passes. Inspect the retained trace to distinguish them.

Check the verifier's failure detection with a real failing HTTP dependency:

```sh
node apps/server/scripts/verify-background-live.ts --scenario active --fail-gate
```

That command must exit nonzero. It must not be counted as a passing product test.

Each run prints its evidence directory. It retains the SQLite database, native
provider logs, streamed events, final projection, prompt, revision and dirty-file
inventory, and machine-readable verdict. Suite reports link every attempt,
including failures; repeating a test does not erase an earlier failure. Evidence
is local and may contain provider output. Do not upload the entire T3 home.

This loop does not verify rendered folding, mobile UI, cancellation, or abrupt
process loss between provider acceptance and receipt persistence. Those require
additional scenarios before claiming complete background-lifecycle coverage.
