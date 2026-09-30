import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeChatGPTAuth } from "./ChatGPTAuth.ts";

it.effect("publishes visible Firefox sign-in state and closes the flow when cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let aborted = false;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let signedOut = false;
      const browser = {
        signIn: (signal: AbortSignal) => {
          markStarted();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new DOMException("Cancelled", "AbortError"));
              },
              { once: true },
            );
          });
        },
        signOut: async () => {
          signedOut = true;
        },
        hasSession: async () => false,
      };
      const { controller } = yield* makeChatGPTAuth(
        ProviderInstanceId.make("chatgpt_web_test"),
        browser,
      );
      const waiting = yield* controller.start("browser-session");
      expect(waiting.phase).toBe("waiting");
      expect(waiting.message).toContain("Firefox window");
      yield* Effect.promise(() => started);
      const cancelled = yield* controller.cancel("browser-session", waiting.flowId!);
      expect(cancelled.phase).toBe("cancelled");
      expect(aborted).toBe(true);
      const signedOutState = yield* controller.logout(Effect.void);
      expect(signedOutState.phase).toBe("idle");
      expect(signedOut).toBe(true);
    }),
  ),
);
