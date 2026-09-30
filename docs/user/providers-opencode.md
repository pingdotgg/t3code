# OpenCode

Install and authenticate OpenCode on the machine running your environment, then
enable it in **Settings > Providers**. See [provider setup](./install.md#providers).
T3 Code requires OpenCode 1.14.19 or newer, including when you connect an existing
OpenCode server.

## Local or external server

Leave **Server URL** empty to let T3 Code start OpenCode locally. A password in
provider settings applies to both that server and T3 Code's connection. With no
password setting, the local server uses `OPENCODE_SERVER_PASSWORD` from its
environment.

To use an existing OpenCode server, set **Server URL** and its password in provider
settings. T3 Code uses only that configured password for an external server; it
does not forward a local `OPENCODE_SERVER_PASSWORD`. If connection or version checks
fail, check the URL, credentials, and OpenCode version, then refresh provider status.

After a lost connection, send another prompt to reconnect to the same OpenCode
session.

## Approvals

OpenCode follows the shared [permission modes](./permission-modes.md). **Auto** has
the same rules as **Supervised** because OpenCode has no AI approval reviewer.
Environment files such as `.env` and `.env.local` need approval in restricted
modes even though normal file reads do not; `.env.example` is allowed.

**Allow for workspace** applies to matching requests in other OpenCode sessions
using the same workspace. It is broader than the current thread, especially on a
shared external server. Use **Allow once** for a single request. Denying an action
does not stop the whole turn.

## Refresh models, commands, and skills

After changing an OpenCode login or configuration, use **Refresh provider status**
in **Settings > Providers** for that environment. On mobile, use **Refresh models**
in the thread settings. Reconnecting also refreshes the catalog; periodic provider
health checks do not.

Credential changes are read on refresh. Native OpenCode configuration can remain
cached while the local helper is running. Let it sit for 30 seconds without model
refreshes or text-generation work, then refresh again to reload the files. Repeated
refreshes keep the helper alive. An external server may need its own reload or
restart before T3 Code can see configuration changes.

Existing threads keep their selected model and options even when it disappears
from the catalog. If OpenCode rejects that model, select an available one and retry.

## OpenCode 2 (`opencode2`)

The **OpenCode 2** provider is a separate instance kind for the OpenCode 2.x
line. It talks to the same `opencode` binary name, but requires
**v2.0.18 or newer**; a 1.x binary or server on an `opencode2` instance
reports an error pointing back at the 1.x provider above. The 1.x provider
treats any `>=2.0.0` runtime as out of range, so each line stays on its own
provider.

Local and external server behavior matches the 1.x provider: leave **Server
URL** empty to let T3 Code spawn the server, or set it to use an existing
one. The password rules differ slightly:

- For a spawned server, T3 Code always generates a fresh in-memory password
  for that server. Both `OPENCODE_PASSWORD` and the 1.x
  `OPENCODE_SERVER_PASSWORD` are stripped from the spawned server's
  environment, so ambient credentials never leak into it. A password in
  provider settings does not apply to spawned servers.
- For an external server, T3 Code uses only the configured password.

**1.x legacy note:** OpenCode 1.x stays on the **OpenCode** provider
(`opencode`), which requires 1.14.19 or newer and stays below 2.0.0. Your
existing threads, logins, and configuration keep working there; move an
instance to **OpenCode 2** only after upgrading the binary or server to
2.0.18+.
