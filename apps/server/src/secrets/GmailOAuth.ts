// @effect-diagnostics nodeBuiltinImport:off -- OAuth state and PKCE need cryptographic randomness; deadlines release abandoned codes.
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";
import {
  GMAIL_CALLBACK_PATH,
  type LocalVaultInput,
  type LocalVaultResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { exchangeGmailCode, type GmailClientRegistration, type GmailGrant } from "./GmailApi.ts";
import { gmailCallbackSetup } from "./GmailCallback.ts";
import {
  disconnectVaultGmail,
  manageLocalVault,
  readVaultRecord,
  setVaultGmailGrant,
} from "./LocalVault.ts";
import { authorizeVaultUse } from "./VaultAccess.ts";

const lifetimeMs = 10 * 60_000;
const capacity = 32;
const restart = "This Gmail connection is no longer available. Start the connection again.";
const configure =
  "Open this vault entry in Settings and save its Google Web application credentials before connecting Gmail.";
const changed =
  "This vault entry or its Google credentials changed. Reopen it in Settings and start the connection again.";
const waiting =
  "Google has not returned consent yet. Complete consent in your browser, then finish the connection here.";
export const callbackPath = GMAIL_CALLBACK_PATH;

interface Target {
  readonly sessionId: string;
  readonly name: string;
  readonly title: string;
}
type ClientBinding = Pick<GmailClientRegistration, "clientId" | "redirectUri" | "revision">;
interface Flow extends Target, ClientBinding {
  readonly state: string;
  readonly verifier: string;
  readonly deadline: number;
  readonly timer: NodeJS.Timeout;
  phase: "waiting" | "ready" | "finishing";
  code?: string;
}
interface SafeFailure {
  readonly message: string;
}
interface Transport {
  readonly exchange: (
    input: { readonly code: string; readonly verifier: string },
    client: GmailClientRegistration,
  ) => Effect.Effect<GmailGrant, SafeFailure>;
}

interface GmailFlows {
  start(
    target: Target,
    client: ClientBinding,
  ): Effect.Effect<{ url: string; flowId: string }, SafeFailure>;
  receive(params: URLSearchParams): "accepted" | "rejected" | "inactive";
  finish<R>(
    sessionId: string,
    name: string,
    flowId: string,
    unlockClient: (
      title: string,
    ) => Effect.Effect<GmailClientRegistration | undefined, SafeFailure>,
    save: (
      title: string,
      grant: GmailGrant,
      revision: string,
    ) => Effect.Effect<void, SafeFailure, R>,
  ): Effect.Effect<void, SafeFailure, R>;
  cancelEntry(name: string): void;
  close(): void;
}

export function makeGmailFlows(transport: Transport): GmailFlows {
  const byId = new Map<string, Flow>();
  const byState = new Map<string, string>();
  function remove(flowId: string) {
    const flow = byId.get(flowId);
    if (flow) {
      NodeTimers.clearTimeout(flow.timer);
      delete flow.code;
      byState.delete(flow.state);
      byId.delete(flowId);
    }
  }
  function active(flowId: string) {
    const flow = byId.get(flowId);
    if (flow && performance.now() >= flow.deadline) {
      remove(flowId);
      return undefined;
    }
    return flow;
  }
  const start = Effect.fnUntraced(function* (
    target: Target,
    { clientId, redirectUri, revision }: ClientBinding,
  ) {
    for (const [id, previous] of byId) {
      if (!active(id) || previous.sessionId !== target.sessionId || previous.name !== target.name) {
        continue;
      }
      if (previous.phase === "finishing") {
        return yield* Effect.fail({ message: "A Gmail connection is already being saved." });
      }
      remove(id);
    }
    if (byId.size >= capacity) {
      return yield* Effect.fail({
        message: "Too many Gmail connections are pending. Try again later.",
      });
    }
    const flowId = NodeCrypto.randomBytes(32).toString("base64url");
    const state = NodeCrypto.randomBytes(32).toString("base64url");
    const verifier = NodeCrypto.randomBytes(32).toString("base64url");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge_method: "S256",
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    byId.set(flowId, {
      ...target,
      clientId,
      redirectUri,
      revision,
      state,
      verifier,
      deadline: performance.now() + lifetimeMs,
      // @effect-diagnostics-next-line globalTimersInEffect:off -- The deadline outlives the RPC; remove() clears it on completion or server shutdown.
      timer: NodeTimers.setTimeout(() => remove(flowId), lifetimeMs).unref(),
      phase: "waiting",
    });
    byState.set(state, flowId);
    // The privileged client gets the handle; Google receives only its independent state nonce.
    return { flowId, url: url.href };
  });
  function receive(params: URLSearchParams): "accepted" | "rejected" | "inactive" {
    const states = params.getAll("state");
    if (states.length !== 1) return "inactive";
    const id = byState.get(states[0]!);
    if (id === undefined) return "inactive";
    const flow = active(id);
    if (!flow || flow.phase !== "waiting") return "inactive";
    byState.delete(flow.state);
    const codes = params.getAll("code");
    const code = codes[0];
    if (params.has("error") || codes.length !== 1 || !code || !/^[\x21-\x7e]{1,2048}$/.test(code)) {
      remove(id);
      return "rejected";
    }
    flow.code = code;
    flow.phase = "ready";
    return "accepted";
  }
  const finish = Effect.fnUntraced(function* <R>(
    sessionId: string,
    name: string,
    flowId: string,
    unlockClient: (
      title: string,
    ) => Effect.Effect<GmailClientRegistration | undefined, SafeFailure>,
    save: (
      title: string,
      grant: GmailGrant,
      revision: string,
    ) => Effect.Effect<void, SafeFailure, R>,
  ) {
    const flow = active(flowId);
    if (!flow || flow.sessionId !== sessionId || flow.name !== name || flow.phase === "finishing") {
      return yield* Effect.fail({ message: restart });
    }
    if (flow.phase === "waiting") return yield* Effect.fail({ message: waiting });
    // Reject a bad PIN without spending the code or contacting Google. Storage checks it again
    // under the vault edit lock so a concurrent PIN or policy change cannot authorize the write.
    const client = yield* unlockClient(flow.title);
    if (active(flowId) !== flow || flow.phase !== "ready" || !flow.code) {
      return yield* Effect.fail({ message: restart });
    }
    if (
      !client ||
      client.revision !== flow.revision ||
      client.clientId !== flow.clientId ||
      client.redirectUri !== flow.redirectUri
    ) {
      remove(flowId);
      return yield* Effect.fail({ message: changed });
    }
    const code = flow.code;
    delete flow.code;
    flow.phase = "finishing";
    return yield* Effect.gen(function* () {
      const grant = yield* transport.exchange({ code, verifier: flow.verifier }, client);
      if (active(flowId) !== flow) return yield* Effect.fail({ message: restart });
      yield* save(flow.title, grant, flow.revision);
    }).pipe(
      Effect.mapError((error) => ({
        message:
          error.message === restart
            ? restart
            : `${error.message} Start the Gmail connection again.`,
      })),
      Effect.ensuring(Effect.sync(() => remove(flowId))),
    );
  });
  return {
    start,
    receive,
    finish,
    cancelEntry(name: string) {
      for (const [id, flow] of byId) if (flow.name === name) remove(id);
    },
    close() {
      for (const id of byId.keys()) remove(id);
    },
  };
}

export class GmailOAuth extends Context.Service<GmailOAuth, GmailFlows>()(
  "t3/secrets/GmailOAuth",
) {}

export const layer = Layer.effect(
  GmailOAuth,
  Effect.acquireRelease(
    Effect.sync(() => makeGmailFlows({ exchange: exchangeGmailCode })),
    (flows) => Effect.sync(() => flows.close()),
  ),
);

type GmailInput = Extract<
  LocalVaultInput,
  { action: "gmail-start" | "gmail-finish" | "gmail-disconnect" }
>;
export const manageGmailVault = Effect.fn("GmailOAuth.manageVault")(function (
  flows: GmailOAuth["Service"] | undefined,
  sessionId: string,
  store: ServerSecretStore["Service"] | undefined,
  input: GmailInput,
  options: { readonly canSetInitialPin: boolean },
): Effect.Effect<LocalVaultResult, never, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    if (!store?.directory || store.storageMode !== "linux-keyring-aes256gcm") {
      return yield* Effect.fail({
        message: "Connect to an environment with an encrypted Hyakki vault.",
      });
    }
    // Disconnect is local: even a removed OAuth configuration must not strand an old grant.
    if (input.action === "gmail-disconnect") {
      yield* disconnectVaultGmail(store, input);
      flows?.cancelEntry(input.name);
      return yield* manageLocalVault(store, { action: "list" }, options);
    }
    if (!flows)
      return yield* Effect.fail({ message: "This server cannot start a Gmail connection." });
    if (input.action === "gmail-start") {
      const listed = yield* manageLocalVault(store, { action: "list" }, options);
      if (listed.error !== null) return listed;
      if (!listed.security?.configured)
        return yield* Effect.fail({ message: "Set a vault PIN before connecting Gmail." });
      const existing = yield* readVaultRecord(store, input.name);
      if (!existing?.gmailClient) return yield* Effect.fail({ message: configure });
      if (!listed.gmailRedirectUri) return yield* Effect.fail({ message: gmailCallbackSetup });
      if (existing.gmailClient.redirectUri !== listed.gmailRedirectUri) {
        return yield* Effect.fail({
          message:
            "Update this entry’s redirect URI in Settings and in Google Cloud before connecting Gmail.",
        });
      }
      if (existing.title !== input.title) {
        return yield* Effect.fail({
          message: "The vault entry title does not match. Reopen the connection from Settings.",
        });
      }
      const gmailAuthorization = yield* flows.start(
        {
          sessionId,
          name: input.name,
          title: input.title,
        },
        existing.gmailClient,
      );
      return { ...listed, gmailAuthorization };
    }
    yield* flows.finish(
      sessionId,
      input.name,
      input.flowId,
      (title) =>
        Effect.gen(function* () {
          yield* authorizeVaultUse(
            store,
            input.name,
            "tagged",
            Redacted.make(Redacted.value(input.pin)),
          );
          const entry = yield* readVaultRecord(store, input.name);
          return entry?.title === title ? entry.gmailClient : undefined;
        }),
      (title, grant, expectedClientRevision) =>
        setVaultGmailGrant(store, {
          name: input.name,
          title,
          grant,
          expectedClientRevision,
          pin: input.pin,
        }),
    );
    return yield* manageLocalVault(store, { action: "list" }, options);
  }).pipe(
    Effect.orElseSucceed((error) => ({ names: [], entries: [], error: error.message })),
    Effect.ensuring(
      Effect.sync(() => {
        if (input.action !== "gmail-start") Redacted.wipeUnsafe(input.pin);
      }),
    ),
  );
});
