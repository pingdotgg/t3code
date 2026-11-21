import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

interface CodexAccount {
  readonly email: string;
  readonly workspaceId: string | undefined;
}

const signedInAccount = (provider: ServerProvider): CodexAccount | undefined =>
  provider.driver === CODEX_DRIVER &&
  provider.auth.status === "authenticated" &&
  provider.auth.email !== undefined
    ? { email: provider.auth.email, workspaceId: provider.auth.workspaceId }
    : undefined;

// The workspace id comes from an optional rate-limit read, so compare it only when both have one.
const isSameAccount = (previous: CodexAccount, next: CodexAccount) =>
  previous.email === next.email &&
  (previous.workspaceId === undefined ||
    next.workspaceId === undefined ||
    previous.workspaceId === next.workspaceId);

const recordAccounts = (
  accounts: Map<ProviderInstanceId, CodexAccount>,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceId> => {
  const switched: Array<ProviderInstanceId> = [];
  for (const provider of providers) {
    const next = signedInAccount(provider);
    if (next === undefined) continue;
    const previous = accounts.get(provider.instanceId);
    if (previous !== undefined && !isSameAccount(previous, next)) {
      switched.push(provider.instanceId);
    }
    accounts.set(provider.instanceId, {
      email: next.email,
      workspaceId:
        next.workspaceId ?? (previous?.email === next.email ? previous.workspaceId : undefined),
    });
  }
  return switched;
};

// A Codex app-server reads auth.json once, so after `codex login` switches accounts outside T3
// its live sessions keep the old account until they are closed.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const accounts = new Map<ProviderInstanceId, CodexAccount>();
    recordAccounts(accounts, yield* providers.getProviders);
    yield* providers.streamChanges.pipe(
      Stream.runForEach((snapshot) =>
        Effect.forEach(
          recordAccounts(accounts, snapshot),
          (instanceId) =>
            sessions.closeInstance(instanceId).pipe(Effect.ignoreCause({ log: true })),
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
