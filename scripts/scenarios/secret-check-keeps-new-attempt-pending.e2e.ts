/// <reference lib="dom" />
import { SecretProviderId, SecretProviderKind, WS_METHODS } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { FromClientEncoded } from "effect/rpc/RpcMessage";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, rpcClient, runPromise, test, WEB } from "./t3.ts";

const PROVIDER = SecretProviderId.make("scenario");
const REFERENCE_A = "op://Scenario/GitHub/first";
const REFERENCE_B = "op://Scenario/GitHub/second";

declare global {
  interface Window {
    IS_REACT_ACT_ENVIRONMENT?: boolean | undefined;
    secretCheckGate?: {
      readonly captured: ReadonlyArray<Promise<() => void>>;
      finishFirst?: () => Promise<void>;
    };
  }
}

test(
  "An earlier check of the same reference leaves the new check pending",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const origin = app.baseUrl ?? "";
    const environment = await runPromise(environmentId(origin));
    await t3.project("demo");
    await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${T3_HOME}/bin/op`, "#!/bin/sh\nexit 1\n");
        yield* fs.chmod(`${T3_HOME}/bin/op`, 0o755);
        const client = yield* rpcClient(T3_HOME, origin);
        yield* client["server.updateSettings"]({
          patch: {
            secretProviders: {
              [PROVIDER]: {
                kind: SecretProviderKind.make("one_password"),
                label: "Scenario",
                config: { account: "scenario" },
              },
            },
            sourceControlHosts: {
              github: {
                tokens: {
                  "github.com": {
                    provider: PROVIDER,
                    reference: REFERENCE_A,
                  },
                },
              },
            },
          },
        });
      }).pipe(Effect.scoped),
    );

    // Hold the real requests until the scenario releases one.
    await browser.addInitScript((method) => {
      const checks = Array.from({ length: 3 }, () => Promise.withResolvers<() => void>());
      let count = 0;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (typeof data !== "string") return send.call(this, data);
        const parsed: FromClientEncoded | FromClientEncoded[] = JSON.parse(data);
        const batched = Array.isArray(parsed);
        const frames = batched ? parsed : [parsed];
        const other = frames.filter((frame) => {
          if (frame._tag !== "Request" || frame.tag !== method) return true;
          const check = checks[count++];
          if (!check) throw new Error("Unexpected extra secret check");
          check.resolve(() => send.call(this, JSON.stringify(batched ? [frame] : frame)));
          return false;
        });
        if (other.length === frames.length) return send.call(this, data);
        if (other.length > 0) send.call(this, JSON.stringify(other));
      };
      window.secretCheckGate = { captured: checks.map((check) => check.promise) };
    }, WS_METHODS.serverCheckSecretSource);

    await t3.open(`/settings/source-control?machine=${encodeURIComponent(environment)}`);
    await screen.getByRole("button", "Toggle GitHub details", { exact: true }).tap();
    const input = screen.getByRole("textbox", "GitHub token reference", { exact: true });
    const check = screen.getByRole("button", "Check GitHub token", { exact: true });
    await browser.evaluate(async () => {
      // Reuse the dev app's modules so the command and React renderer share their singletons.
      const loadedModule = (pattern: RegExp) => {
        const entry = performance
          .getEntriesByType("resource")
          .find(({ name }) => pattern.test(new URL(name).pathname));
        if (!entry) throw new Error(`The app did not load ${pattern}`);
        return entry.name;
      };
      const effect: typeof Effect = await import(loadedModule(/\/(effect_Effect|Effect)\.js$/));
      const {
        default: react,
      }: { default: { act: (work: () => Promise<void>) => PromiseLike<void> } } = await import(
        loadedModule(/\/react\.js$/)
      );
      const serverModule = "/src/state/server.ts";
      type Run = (...args: never[]) => Effect.Effect<unknown, { readonly _tag: string }>;
      const { serverEnvironment }: { serverEnvironment: { checkSecretSource: { run: Run } } } =
        await import(serverModule);
      const command = serverEnvironment.checkSecretSource;
      const run = command.run;
      const settled = Promise.withResolvers<void>();
      command.run = (...args) => {
        command.run = run;
        // Observe completion of the command's root fiber, including its finalizers.
        return effect.withFiber((fiber) => {
          fiber.addObserver(() => settled.resolve());
          return run(...args);
        });
      };
      const gate = window.secretCheckGate!;
      gate.finishFirst = async () => {
        const release = await gate.captured[0]!;
        const wasActEnvironment = window.IS_REACT_ACT_ENVIRONMENT;
        window.IS_REACT_ACT_ENVIRONMENT = true;
        try {
          await react.act(async () => {
            release();
            await settled.promise;
          });
        } finally {
          window.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
        }
      };
      return null;
    });
    const startCheck = async (index: number) => {
      await check.tap();
      await browser.evaluate(async (index) => {
        await window.secretCheckGate!.captured[index];
        return null;
      }, index);
    };
    const commit = async (reference: string) => {
      await input.fill(reference);
      await input.press("Enter");
    };

    await startCheck(0);
    await commit(REFERENCE_B);
    await startCheck(1);
    await commit(REFERENCE_A);
    await startCheck(2);
    const pending = await browser.evaluate(async () => {
      await window.secretCheckGate!.finishFirst!();
      return (
        document.querySelector<HTMLButtonElement>('button[aria-label="Check GitHub token"]')
          ?.disabled === true
      );
    });
    await app.screenshot("new-secret-check-after-old-reply");
    expect(pending, "The newer secret check is still pending after the earlier reply").toBe(true);
  },
);
