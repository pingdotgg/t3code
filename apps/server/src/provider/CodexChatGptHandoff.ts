import type { ChatGptHandoffInput, ChatGptHandoffState } from "@t3tools/contracts";
import { ProviderSetupError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";

// The primary owns OAuth for this stream; the destination owns the refresh session.
export function subscribeChatGptHandoff(
  input: ChatGptHandoffInput,
  owner: string,
  endpoints: { discoveryUrl: string; resource: string } | undefined = undefined,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      yield* Effect.addFinalizer(() => Effect.sync(() => bytes.clear()));
      const store = ServerSecretStore.of({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            bytes.set(key, value);
          }),
        remove: (key) =>
          Effect.sync(() => {
            bytes.delete(key);
          }),
        create: () => Effect.die("Handoff does not create persistent secrets."),
        getOrCreateRandom: () => Effect.die("Handoff uses the destination environment identity."),
      });
      const auth = yield* makeCodexChatGptAuth({
        ...endpoints,
        instanceId: input.instanceId,
        reconnectProfile: input.profile,
        telemetryFlow: "primary_handoff",
        defaultReturnUrl: input.returnUrl,
      }).pipe(
        Effect.provideService(ServerSecretStore, store),
        Effect.provideService(
          ServerEnvironmentIdentity,
          ServerEnvironmentIdentity.of({
            getEnvironmentId: Effect.succeed(input.environmentId),
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
      );
      yield* auth.controller.start(owner, Effect.void, "chatgpt", input.returnUrl, "server");
      return auth.controller.subscribe(owner).pipe(
        Stream.takeUntil((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
        Stream.mapEffect((state): Effect.Effect<ChatGptHandoffState, ProviderSetupError> =>
          state.phase === "succeeded"
            ? auth.exportProfile.pipe(
                Effect.map((profile) => ({ phase: "finished" as const, profile })),
              )
            : Effect.succeed({ phase: "auth" as const, state }),
        ),
      );
    }),
  );
}
