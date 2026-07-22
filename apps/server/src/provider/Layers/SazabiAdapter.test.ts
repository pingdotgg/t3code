import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  SazabiSettings,
  ThreadId,
} from "@t3tools/contracts";

import type { SazabiAdapterShape } from "../Services/SazabiAdapter.ts";
import { makeSazabiAdapter, SAZABI_ADAPTER_NOT_IMPLEMENTED_DETAIL } from "./SazabiAdapter.ts";

const decodeSazabiSettings = Schema.decodeSync(SazabiSettings);

const withAdapter = <A, E>(use: (adapter: SazabiAdapterShape) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeSazabiAdapter(decodeSazabiSettings({ enabled: true }), {
        instanceId: ProviderInstanceId.make("sazabi"),
      });
      return yield* use(adapter);
    }),
  );

const THREAD = ThreadId.make("sazabi-scaffold-thread");

describe("makeSazabiAdapter (scaffold)", () => {
  it.effect("advertises the sazabi provider with model switching unsupported", () =>
    withAdapter((adapter) =>
      Effect.sync(() => {
        expect(adapter.provider).toBe("sazabi");
        expect(adapter.capabilities.sessionModelSwitch).toBe("unsupported");
      }),
    ),
  );

  it.effect("fails startSession with a clear not-implemented error", () =>
    withAdapter((adapter) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          adapter.startSession({
            threadId: THREAD,
            provider: ProviderDriverKind.make("sazabi"),
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("sazabi"),
              model: "sazabi-default",
            },
          }),
        );
        expect(error._tag).toBe("ProviderAdapterRequestError");
        if (error._tag === "ProviderAdapterRequestError") {
          expect(error.method).toBe("session/start");
          expect(error.detail).toContain(SAZABI_ADAPTER_NOT_IMPLEMENTED_DETAIL);
        }
      }),
    ),
  );

  it.effect("fails sendTurn with a clear not-implemented error", () =>
    withAdapter((adapter) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          adapter.sendTurn({ threadId: THREAD, input: "hello sazabi", attachments: [] }),
        );
        expect(error._tag).toBe("ProviderAdapterRequestError");
        if (error._tag === "ProviderAdapterRequestError") {
          expect(error.method).toBe("session/prompt");
          expect(error.detail).toContain(SAZABI_ADAPTER_NOT_IMPLEMENTED_DETAIL);
        }
      }),
    ),
  );

  it.effect("fails readThread and rollbackThread as not implemented", () =>
    withAdapter((adapter) =>
      Effect.gen(function* () {
        const readError = yield* Effect.flip(adapter.readThread(THREAD));
        expect(readError._tag).toBe("ProviderAdapterRequestError");
        if (readError._tag === "ProviderAdapterRequestError") {
          expect(readError.method).toBe("thread/read");
        }

        const rollbackError = yield* Effect.flip(adapter.rollbackThread(THREAD, 1));
        expect(rollbackError._tag).toBe("ProviderAdapterRequestError");
        if (rollbackError._tag === "ProviderAdapterRequestError") {
          expect(rollbackError.method).toBe("thread/rollback");
        }
      }),
    ),
  );

  it.effect("fails interactive responses as not implemented", () =>
    withAdapter((adapter) =>
      Effect.gen(function* () {
        const approvalError = yield* Effect.flip(
          adapter.respondToRequest(THREAD, ApprovalRequestId.make("req-1"), "accept"),
        );
        expect(approvalError._tag).toBe("ProviderAdapterRequestError");
        if (approvalError._tag === "ProviderAdapterRequestError") {
          expect(approvalError.method).toBe("session/request_permission");
        }

        const inputError = yield* Effect.flip(
          adapter.respondToUserInput(THREAD, ApprovalRequestId.make("req-2"), {}),
        );
        expect(inputError._tag).toBe("ProviderAdapterRequestError");
        if (inputError._tag === "ProviderAdapterRequestError") {
          expect(inputError.method).toBe("session/user_input");
        }
      }),
    ),
  );

  it.effect("treats interrupt/stop lifecycle operations as safe no-ops", () =>
    withAdapter((adapter) =>
      Effect.gen(function* () {
        yield* adapter.interruptTurn(THREAD);
        yield* adapter.stopSession(THREAD);
        yield* adapter.stopAll();
        const sessions = yield* adapter.listSessions();
        const hasSession = yield* adapter.hasSession(THREAD);
        expect(sessions).toEqual([]);
        expect(hasSession).toBe(false);
      }),
    ),
  );
});
