/// <reference lib="dom" />
import { SecretProviderId, SecretProviderKind } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, rpcClient, runPromise, test, WEB } from "./t3.ts";

const PROVIDER = SecretProviderId.make("scenario");
const REFERENCE_A = "op://Scenario/GitHub/first";
const REFERENCE_B = "op://Scenario/GitHub/second";

declare global {
  interface Window {
    secretCheckGate?: {
      readonly reached: (count: number) => Promise<void>;
      readonly finishFirst: () => Promise<void>;
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

    // Delay the real checks independently so only the older A can produce a reply.
    await browser.addInitScript(() => {
      type Frame = { readonly _tag?: string; readonly tag?: string; readonly id?: string | number };
      const checks: Array<() => Promise<void>> = [];
      const waiting: Array<{ readonly count: number; readonly resolve: () => void }> = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (this: WebSocket, data) {
        if (typeof data !== "string") return send.call(this, data);
        const parsed: Frame | Frame[] = JSON.parse(data);
        const frames = [parsed].flat();
        const check = frames.find(
          (frame) => frame._tag === "Request" && frame.tag === "server.checkSecretSource",
        );
        if (!check) return send.call(this, data);
        const other = frames.filter((frame) => frame !== check);
        if (other.length > 0) send.call(this, JSON.stringify(other));
        checks.push(
          () =>
            new Promise<void>((resolve) => {
              const receive = (event: MessageEvent) => {
                if (typeof event.data !== "string") return;
                const replies: Array<{ _tag?: string; requestId?: string | number }> = [
                  JSON.parse(event.data),
                ].flat();
                if (!replies.some((reply) => reply._tag === "Exit" && reply.requestId === check.id))
                  return;
                this.removeEventListener("message", receive);
                resolve();
              };
              this.addEventListener("message", receive);
              send.call(this, JSON.stringify(Array.isArray(parsed) ? [check] : check));
            }),
        );
        for (const waiter of waiting) if (waiter.count === checks.length) waiter.resolve();
      };
      window.secretCheckGate = {
        reached: (count) =>
          checks.length >= count
            ? Promise.resolve()
            : new Promise((resolve) => waiting.push({ count, resolve })),
        finishFirst: () => checks[0]!(),
      };
    });

    await t3.open(`/settings/source-control?machine=${encodeURIComponent(environment)}`);
    await screen.getByRole("button", "Toggle GitHub details", { exact: true }).tap();
    const input = screen.getByRole("textbox", "GitHub token reference", { exact: true });
    const check = screen.getByRole("button", "Check GitHub token", { exact: true });
    const startCheck = async (count: number) => {
      await check.tap();
      await browser.evaluate(async (count) => {
        await window.secretCheckGate!.reached(count);
        return null;
      }, count);
    };
    const commit = async (reference: string) => {
      await input.fill(reference);
      await input.press("Enter");
    };

    await startCheck(1);
    await commit(REFERENCE_B);
    await startCheck(2);
    await commit(REFERENCE_A);
    await startCheck(3);
    const pending = await browser.evaluate(async () => {
      await window.secretCheckGate!.finishFirst();
      // Nothing follows a stale reply on the fix, so give its RPC and React update time to land.
      for (let frame = 0; frame < 10; frame++) {
        await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      }
      return (
        document.querySelector<HTMLButtonElement>('button[aria-label="Check GitHub token"]')
          ?.disabled === true
      );
    });
    await app.screenshot("new-secret-check-after-old-reply");
    expect(pending, "The newer secret check is still pending after the earlier reply").toBe(true);
  },
);
