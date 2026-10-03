import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = PreviewIpc.resolvePartitionScope("a", "b::c");
    const second = PreviewIpc.resolvePartitionScope("a::b", "c");

    expect(first).toEqual({ scope: '["a","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["a::b","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("preserves lone surrogates without collapsing them to replacement characters", () => {
    const highSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\ud800");
    const lowSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\udc00");
    const replacement = PreviewIpc.resolvePartitionScope("environment", "profile-�");

    expect(highSurrogate.scope).toBe('["environment","profile-\\ud800"]');
    expect(lowSurrogate.scope).toBe('["environment","profile-\\udc00"]');
    expect(highSurrogate.scope).not.toBe(lowSurrogate.scope);
    expect(highSurrogate.scope).not.toBe(replacement.scope);
    expect(lowSurrogate.scope).not.toBe(replacement.scope);
  });

  it("keeps the legacy default partition scope and incognito persistence", () => {
    expect(PreviewIpc.resolvePartitionScope("environment::legacy", undefined)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", DEFAULT_BROWSER_PROFILE_ID),
    ).toEqual({ scope: "environment::legacy", persistent: true });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", INCOGNITO_BROWSER_PROFILE_ID),
    ).toEqual({
      scope: '["environment::legacy","incognito"]',
      persistent: false,
      namespace: "profile",
    });
  });

  effectIt.effect("targets imports at the same partition tuple as the renderer", () => {
    const received: Array<Parameters<BrowserImport.BrowserImport["Service"]["importCookies"]>[0]> =
      [];
    const browserImport = BrowserImport.BrowserImport.of({
      listSources: Effect.succeed([]),
      importCookies: (input) =>
        Effect.sync(() => {
          received.push(input);
          return { imported: 0, skipped: 0, skippedDomains: [] };
        }),
    });
    const request = (environmentId: string, targetProfileId: string) =>
      PreviewIpc.importBrowserCookies.handler({
        environmentId,
        sourceId: "helium",
        sourceProfileDirectory: "Default",
        targetProfileId,
      });

    return Effect.gen(function* () {
      yield* request("a", "b");
      yield* request("a::b", DEFAULT_BROWSER_PROFILE_ID);

      expect(received[0]).toMatchObject(PreviewIpc.resolvePartitionScope("a", "b"));
      expect(received[1]).toMatchObject(
        PreviewIpc.resolvePartitionScope("a::b", DEFAULT_BROWSER_PROFILE_ID),
      );
      expect(received[0]?.namespace).toBe("profile");
      expect(received[1]?.namespace).toBeUndefined();
    }).pipe(Effect.provideService(BrowserImport.BrowserImport, browserImport));
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect("returns automation status for long runtime tab ids", () =>
    Effect.gen(function* () {
      const tabId =
        `["environment-1","thread:delegated-task:${"a".repeat(120)}",` +
        `"server-epoch-1","preview-1"]`;
      const status = {
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      };
      const manager = PreviewManager.PreviewManager.of({
        automationStatus: () => Effect.succeed(status),
      } as unknown as PreviewManager.PreviewManager["Service"]);

      expect(tabId.length).toBeGreaterThan(128);
      expect(
        yield* PreviewIpc.automationStatus
          .handler({ tabId })
          .pipe(Effect.provideService(PreviewManager.PreviewManager, manager)),
      ).toEqual(status);
    }),
  );

  it("keeps the public automation status tab id limit", () => {
    const encode = Schema.encodeUnknownSync(PreviewAutomationStatus);
    const tabId = "t".repeat(129);

    expect(() =>
      encode({
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      }),
    ).toThrow();
  });

  effectIt.effect("resolves failures that have a public automation tag instead of rejecting", () =>
    Effect.gen(function* () {
      const locator = "role=button[[";
      const manager = PreviewManager.PreviewManager.of({
        automationWaitFor: (_tabId: string, input: { readonly text?: string }) =>
          input.text === "Ready"
            ? Effect.void
            : Effect.fail(
                new PreviewManager.PreviewAutomationTimeoutError({
                  tabId: "tab-1",
                  timeoutMs: 2_000,
                }),
              ),
        automationScroll: () =>
          Effect.fail(
            new PreviewManager.PreviewAutomationInvalidSelectorError({
              operation: "scroll",
              tabId: "tab-1",
              selectorKind: "locator",
              selectorLength: locator.length,
              reasonLength: 16,
              cause: { invalidSelector: true, message: "Unexpected token" },
            }),
          ),
        automationType: (_tabId: string, input: { readonly selector?: string }) =>
          Effect.fail(
            input.selector === undefined
              ? new PreviewManager.PreviewAutomationTargetNotEditableError({
                  tabId: "tab-1",
                  selectorKind: "focused-element",
                })
              : new PreviewManager.PreviewAutomationTargetNotFoundError({
                  operation: "type",
                  tabId: "tab-1",
                  selectorKind: "selector",
                  selectorLength: input.selector.length,
                }),
          ),
      } as unknown as PreviewManager.PreviewManager["Service"]);
      const provide = Effect.provideService(PreviewManager.PreviewManager, manager);

      expect(
        yield* PreviewIpc.automationWaitFor
          .handler({ tabId: "tab-1", input: { text: "Ready" } })
          .pipe(provide),
      ).toBeUndefined();
      expect(
        yield* PreviewIpc.automationWaitFor
          .handler({ tabId: "tab-1", input: { text: "Missing", timeoutMs: 2_000 } })
          .pipe(provide),
      ).toEqual({ _tag: "PreviewAutomationTimeoutError", timeoutMs: 2_000 });
      expect(
        yield* PreviewIpc.automationScroll
          .handler({ tabId: "tab-1", input: { locator, deltaY: 100 } })
          .pipe(provide),
      ).toEqual({
        _tag: "PreviewAutomationInvalidSelectorError",
        selectorKind: "locator",
        selectorLength: locator.length,
      });
      expect(
        yield* PreviewIpc.automationType
          .handler({ tabId: "tab-1", input: { text: "hello" } })
          .pipe(provide),
      ).toEqual({
        _tag: "PreviewAutomationTargetNotEditableError",
        selectorKind: "focused-element",
      });
      // Target-not-found has no public response tag, so it still rejects.
      const notFound = yield* PreviewIpc.automationType
        .handler({ tabId: "tab-1", input: { selector: "#field", text: "hello" } })
        .pipe(provide, Effect.exit);
      expect(Exit.isFailure(notFound)).toBe(true);
      if (Exit.isSuccess(notFound)) return;
      expect(Option.getOrUndefined(Cause.findErrorOption(notFound.cause))).toBeInstanceOf(
        PreviewManager.PreviewAutomationTargetNotFoundError,
      );
    }),
  );
});
