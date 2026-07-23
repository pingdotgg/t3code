# T3 Code

T3 Code connects a single user experience to independently configured coding-agent providers.

## Language

**Pi**:
Mario Zechner's Pi coding agent, specifically the `@earendil-works/pi-coding-agent` CLI and its native agent/session behavior.
_Avoid_: piAgent, generic Pi

**Supported Pi Version**:
Pi CLI version 0.81.1 or later. The T3 Code Pi integration's contract is defined against the RPC and extension behavior available in version 0.81.1.

**Pi Provider**:
The T3 Code provider driver that starts the user-installed Pi CLI in RPC mode and translates its protocol into T3 Code provider events and operations.
_Avoid_: Pi integration, Pi wrapper

**Focused Pi Parity**:
The initial Pi capability set: normal session, streaming, attachment, interruption, model, and approval flows shared with existing providers. Pi-specific features remain deferred until the integration is stable.

**Pi Session Directory**:
The Pi-managed storage directory assigned to one T3 Code Pi provider instance. T3 Code starts threads in persistent-session mode there with their stable native session IDs; Pi materializes the session file lazily while persisting the thread's first accepted prompt turn.

**Pi Provider Configuration**:
Pi's own configuration for credentials, built-in providers, custom providers, and model definitions. Pi remains the source of truth for this configuration; T3 Code may separately configure a Pi runtime instance and presentation preferences.

**Pi Runtime Instance**:
One independently configured connection from T3 Code to Pi, with its own executable/configuration environment and isolated Pi session directory. A runtime instance uses Pi's provider and model configuration without owning it.

**Pi Config Directory**:
The Pi configuration directory selected for a Pi runtime instance. When unset, the instance uses Pi's normal user configuration; when set, T3 Code passes it to Pi as `PI_AGENT_DIR`.

**Pi Tool Policy**:
Pi's enabled and disabled tool set. In base Pi RPC mode, enabled tools run without T3 Code per-tool confirmation; supervised execution would require a Pi extension that blocks and requests confirmation through Pi's extension UI protocol.

**Pi Continuation Compatibility**:
The rule that a Pi thread may resume only through the Pi runtime instance that created it, preserving its Pi configuration directory, extensions, credentials, model catalog, and native session storage.
