import type { ChatGptHandoffInput, ChatGptHandoffState } from "@t3tools/contracts";
import { ProviderSetupError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";

export function subscribeChatGptHandoff(
  input: ChatGptHandoffInput,
  owner: string,
  endpoints: { discoveryUrl: string; resource: string } | undefined = undefined,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      yield* Effect.addFinalizer(() => Effect.sync(() => bytes.clear()));
      const store = ServerSecretStore.ServerSecretStore.of({
        get: Effect.fn("ServerSecretStore.get")(function (key) {
          return Effect.sync(() => Option.fromUndefinedOr(bytes.get(key)));
        }),
        set: Effect.fn("ServerSecretStore.set")(function (key, value) {
          return Effect.sync(() => {
            bytes.set(key, value);
          });
        }),
        remove: Effect.fn("ServerSecretStore.remove")(function (key) {
          return Effect.sync(() => {
            bytes.delete(key);
          });
        }),
        create: Effect.fn("ServerSecretStore.create")(function () {
          return Effect.die("Handoff does not create persistent secrets.");
        }),
        getOrCreateRandom: Effect.fn("ServerSecretStore.getOrCreateRandom")(function () {
          return Effect.die("Handoff uses the destination environment identity.");
        }),
      });
      const auth = yield* makeCodexChatGptAuth({
        ...endpoints,
        instanceId: input.instanceId,
        reconnectProfile: input.profile,
        telemetryFlow: "primary_handoff",
        defaultReturnUrl: input.returnUrl,
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, store),
        Effect.provideService(
          ServerEnvironment.ServerEnvironmentIdentity,
          ServerEnvironment.ServerEnvironmentIdentity.of({
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
