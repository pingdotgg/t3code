# Voice Live

> For maintainers. Using T3 Code? See [Voice](../user/voice.md).

Voice lets the user speak to T3 Code through OpenAI's Live API. Speech handling is delegated to a
Live session; task work (finding threads, answering questions, starting work, reporting research)
is selected by a small backend model running as a managed Responses delegation and executed by the
attached client. This page records the architecture and the constraints that shaped it.

## Client-owned execution, environment-brokered access

The defining split:

- **The environment server owns the OpenAI key and brokers Live sessions.** A route on the
  environment server (`/api/voice/sessions` and its close/usage siblings) accepts the browser's
  SDP offer, mints a Live session upstream with the environment-owned key, and returns the answer
  SDP. It retains the Live session ID for close and usage accounting. The key lives in the server
  secret store under `openai-api-key` and is read per mint; it is never sent to clients. The
  server advertises the `voiceLive` capability only while that key exists, so clients can trust
  the advertisement.
- **The attached client owns all tool execution.** The Live session's function calls are executed
  by the web client that hosts the voice panel, through the client's existing environment catalog
  and prepared authenticated connections. Remote servers do not know about each other, and only
  the attached client can drive its own UI navigation, so the executor must live there.

Consequences worth preserving:

- **Model-visible tools grant no authority.** The session config advertises the voice tools with
  concise descriptions, but every tool call executes through existing scope-checked T3 RPC on the
  target server. A tool the model calls cannot exceed the session's granted scopes; the target
  server enforces them on every request.
- **Broker scope is operate.** Minting a Live session incurs charges, so the broker routes require
  `orchestration:operate`. Read-only sessions are refused with the standard insufficient-scope
  error and zero upstream calls.
- **One broker environment per session.** The primary environment when it offers voice, otherwise
  the first connected environment that does. The session binds to that choice; tool destinations
  remain independent of it.
- **The transport is WebRTC only.** The client posts the SDP exchange to the broker and waits for
  `session.started` on the `oai-events` data channel; it never sends `session.start` (that rule is
  WebSocket-transport-specific). Close is `session.close`, waiting for `session.closed`, followed
  by broker close accounting. The documented upstream response shape (`session.id`,
  `transport.sdp`) is decoded exactly; a shapeless response fails rather than inventing an
  identity.

## Delegation and delivery

The small backend model runs as a managed Responses delegation inside the Live session. Function
results are submitted by the client as batched items followed by exactly one continuation request.
Completed research is steered back into the conversation with unsolicited application steering
(`session.commentary.append` with `delegation_id: null`); delegation IDs are never reused and the
two delegation modes are never mixed. Whether the backend actually sees that commentary context on
its next turn is an open live question, so the default delivery channel composes the result with
the thread identity and asks the backend to re-read the thread through the `voice.readThread` tool.

Delivery is keyed by thread ID and turn ID, never by repeated session status, and reconnect
recovery resumes from the last observed sequence. Voice session state is in-memory server-side;
ending the voice call never cancels T3-owned work.

## Timing marks

### Experimental direct commands

Fast commands are enabled by default in the fork build. The **Try fast commands**
toggle can select managed delegation before connecting. Fast commands opt the session into Live client delegation by omitting `session.delegation`
from the upstream mint request. Managed Responses remains available with the toggle off.

`command-session.ts` routes unique exact-title opens and empty new-thread drafts
through existing T3 actions. Typed commands run on submit; speech runs when Live
emits a client delegation signal, using the accumulated input transcript. Other
requests use the authenticated `/api/voice/backend` Responses endpoint and the
existing tool executor. Completed direct actions, tool outputs, and encrypted
reasoning items remain in the fallback conversation context.

This is an opt-in trial. A delegation signal is not an authoritative final
transcript boundary; late corrections and nondelegating conversational speech
need further work. The direct path does not create projects or start workers.
Opening a new thread uses T3's existing draft behavior, including draft reuse.
Confirmed direct actions play a local 150 ms chime and retain their identity in
backend history without sending a spoken confirmation to Live. Model-selected
navigation also chimes; the client suppresses its final navigation-only spoken
confirmation. Live instructions request silence for navigation in both modes.
The client also suppresses the Live media element and output transcript while
an imperative UI command resolves. This prevents model backchannels from
playing even if Live ignores the silence instruction. Clarifications, errors,
and substantive tool results release the hold; the local chime is independent
of the Live media element. New user input reevaluates the hold.

`continueThread` sends `thread.turn.start` to the supplied existing thread ID,
with no bootstrap or title seed. It reads the thread before dispatch and keeps
its model, runtime and interaction mode. Missing targets fail without creation.
Both client and managed delegation refuse `startThread` when the associated
utterance does not explicitly request creation. This conservative English
command gate can ask for clearer wording; it never substitutes creation for
an uncertain existing-thread request. Model instructions distinguish reading
status from sending a follow-up to the worker. A second pinned policy
separates the discussed thread from the destination of new work: a
`startThread` projectId is chosen from the task's subject via
`discoverProjects` metadata, the discussed or open thread's project is never
the default, an explicitly named destination is used as given, and an
ambiguous destination asks instead of defaulting.
The model fallback is bounded to eight tool rounds and the session to 200 client
delegations. Closing the session invalidates pending results; new requests
supersede pending older actions.

Eight named marks (`utterance_end`, `session_delegation_created`, `function_call_received`,
`tool_done`, `function_call_output_sent`, `first_output_transcript_delta`,
`navigation_acknowledged`, `first_useful_speech`) flow through one mark bus as structured records.
`utterance_end` is authoritative only from an annotated recorded-input endpoint; in a live browser
session it is emitted with `source: "unavailable"` as an explicit non-authoritative proxy.
Navigation acknowledgment reads the resulting route; it never assumes the destination resolved.

## Configuration surfaces

- Server secrets: `openai-api-key` (required; gates the capability advertisement) and
  `voice-broker-config` (optional JSON: `liveModel`, `backendModel`, `instructions`,
  `delegationInstructions`). Defaults are documented constants.
- Client storage (per origin): `t3code:voice-worker-profiles:v1` (routine/deep worker profiles) and
  `t3code:voice-delivery-records:v1` (pending-delivery mapping). Unconfigured profiles fail with
  model-unavailable rather than falling back silently.

Models are never hardcoded: the executor resolves provider instances and model slugs from each
environment's delivered `ServerProvider` snapshot and validates them before dispatch. Runtime mode
is never hardcoded at call sites; the server's default constant applies.

## Where the code lives

- `apps/server/src/voice/broker.ts` — session brokering, scope enforcement, secret-backed config.
- `apps/web/src/voice/` — live client (`live-client.ts`), tool executor (`tools.ts`), navigation
  (`navigation.ts`), research delivery bridge (`research.ts`), final wiring (`index.ts`), and the
  UI under `ui/`.
- `packages/contracts/src/voice.ts` — the frozen wire contracts: tool registry, error codes,
  broker schemas, timing marks.
