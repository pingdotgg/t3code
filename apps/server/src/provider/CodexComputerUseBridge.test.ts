// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  COMPUTER_USE_SHIM_SHA256,
  COMPUTER_USE_SHIM_SOURCE,
  findComputerUseHelper,
  materializeComputerUseShim,
} from "./CodexComputerUseBridge.ts";

interface ShimPipeRequest {
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
  readonly meta: Record<string, unknown>;
}

interface ShimElicitation {
  readonly message: string;
  readonly meta: Record<string, unknown>;
}

interface ShimSky {
  readonly get_window_state: (input: {
    readonly window: { readonly id: number; readonly title?: string };
    readonly include_screenshot: boolean;
    readonly include_text: boolean;
  }) => Promise<unknown>;
}

let shimImportId = 0;

async function withExecutableShim(
  decision: { readonly action: "accept"; readonly _meta?: { readonly persist: "session" } },
  run: (context: {
    readonly sky: ShimSky;
    readonly requests: ReadonlyArray<ShimPipeRequest>;
    readonly elicitations: ReadonlyArray<ShimElicitation>;
  }) => Promise<void>,
): Promise<void> {
  const pipePath = "\\\\.\\pipe\\t3code-cua-test";
  const previousNodeRepl = Object.getOwnPropertyDescriptor(globalThis, "nodeRepl");
  const previousPipePath = process.env.T3_CODEX_COMPUTER_USE_PIPE_PATH;
  const requests: ShimPipeRequest[] = [];
  const elicitations: ShimElicitation[] = [];
  let onData: ((chunk: Uint8Array) => void) | undefined;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const connection = {
    on(event: string, listener: (value: Uint8Array) => void) {
      if (event === "data") onData = listener;
      return connection;
    },
    write(chunk: Uint8Array) {
      const request = JSON.parse(decoder.decode(chunk)) as ShimPipeRequest;
      requests.push(request);
      const approved = request.meta["x-oai-cua-approved-app"] === "electron.exe";
      const response = approved
        ? {
            id: request.id,
            ok: true,
            result: { screenshots: [], text: "approved" },
          }
        : {
            id: request.id,
            ok: false,
            approvalRequest: {
              app: "electron.exe",
              displayName: "Iris",
              riskLevel: "low",
            },
          };
      queueMicrotask(() => onData?.(encoder.encode(`${JSON.stringify(response)}\n`)));
      return true;
    },
  };

  Object.defineProperty(globalThis, "nodeRepl", {
    configurable: true,
    value: {
      config: {},
      requestMeta: { session_id: "session-1", turn_id: "turn-1" },
      nativePipe: { createConnection: async () => connection },
      createElicitation: async (request: ShimElicitation) => {
        elicitations.push(request);
        return decision;
      },
      emitImage: async () => undefined,
    },
  });
  process.env.T3_CODEX_COMPUTER_USE_PIPE_PATH = pipePath;

  try {
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(COMPUTER_USE_SHIM_SOURCE).toString("base64")}#executable-shim-${++shimImportId}`;
    const loaded = (await import(moduleUrl)) as unknown as { readonly sky: ShimSky };
    await run({ sky: loaded.sky, requests, elicitations });
  } finally {
    if (previousNodeRepl) {
      Object.defineProperty(globalThis, "nodeRepl", previousNodeRepl);
    } else {
      Reflect.deleteProperty(globalThis, "nodeRepl");
    }
    if (previousPipePath === undefined) {
      delete process.env.T3_CODEX_COMPUTER_USE_PIPE_PATH;
    } else {
      process.env.T3_CODEX_COMPUTER_USE_PIPE_PATH = previousPipePath;
    }
  }
}

describe("CodexComputerUseBridge", () => {
  it("pins trust to the exact embedded shim bytes", () => {
    NodeAssert.equal(
      COMPUTER_USE_SHIM_SHA256,
      NodeCrypto.createHash("sha256").update(COMPUTER_USE_SHIM_SOURCE).digest("hex"),
    );
    NodeAssert.doesNotMatch(COMPUTER_USE_SHIM_SOURCE, /^import\s/m);
    NodeAssert.match(COMPUTER_USE_SHIM_SOURCE, /Object\.freeze\(sky\)/);
    NodeAssert.match(
      COMPUTER_USE_SHIM_SOURCE,
      /const createElicitation = nodeRepl\.createElicitation;/,
    );
    NodeAssert.doesNotMatch(COMPUTER_USE_SHIM_SOURCE, /config\?\.createElicitation/);
    NodeAssert.doesNotMatch(COMPUTER_USE_SHIM_SOURCE, /transport\s*:/);
  });

  it.effect("materializes a content-addressed package and refuses mismatched bytes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cua-shim-"))),
      (codexHome) =>
        Effect.gen(function* () {
          const first = yield* materializeComputerUseShim(codexHome);
          const second = yield* materializeComputerUseShim(codexHome);
          NodeAssert.deepStrictEqual(second, first);
          NodeAssert.equal(
            yield* Effect.promise(() => NodeFSP.readFile(first.entryPath, "utf8")),
            COMPUTER_USE_SHIM_SOURCE,
          );

          yield* Effect.promise(() => NodeFSP.writeFile(first.entryPath, "mismatch", "utf8"));
          const result = yield* Effect.exit(materializeComputerUseShim(codexHome));
          NodeAssert.equal(Exit.isFailure(result), true);
          if (Exit.isFailure(result)) {
            NodeAssert.match(Cause.pretty(result.cause), /mismatched Computer Use shim/);
          }
        }),
      (codexHome) => Effect.promise(() => NodeFSP.rm(codexHome, { recursive: true, force: true })),
    ),
  );

  it("uses the trusted top-level elicitation API and retries the exact request after approval", () =>
    withExecutableShim({ action: "accept" }, async ({ sky, requests, elicitations }) => {
      const result = await sky.get_window_state({
        window: { id: 7 },
        include_screenshot: false,
        include_text: true,
      });

      NodeAssert.deepStrictEqual(result, { screenshots: [], text: "approved" });
      NodeAssert.equal(elicitations.length, 1);
      NodeAssert.deepStrictEqual(elicitations[0], {
        message: "Allow Codex to use Iris?",
        meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_id: "computer-use",
          connector_name: "Computer Use",
          persist: ["session", "always"],
          riskLevel: "low",
          tool_params: { app: "electron.exe" },
          tool_params_display: [{ name: "app", display_name: "App", value: "Iris" }],
        },
      });
      NodeAssert.equal(requests.length, 2);
      NodeAssert.equal(requests[0]?.method, "get_window_state");
      NodeAssert.equal(requests[1]?.method, requests[0]?.method);
      NodeAssert.deepStrictEqual(requests[1]?.params, requests[0]?.params);
      NodeAssert.deepStrictEqual(requests[0]?.meta, {
        session_id: "session-1",
        turn_id: "turn-1",
      });
      NodeAssert.deepStrictEqual(requests[1]?.meta, {
        session_id: "session-1",
        turn_id: "turn-1",
        "x-oai-cua-approved-app": "electron.exe",
      });
    }));

  it("does not share a session grant between distinct windows of the same executable", () =>
    withExecutableShim(
      { action: "accept", _meta: { persist: "session" } },
      async ({ sky, requests, elicitations }) => {
        const getState = (window: { readonly id: number; readonly title: string }) =>
          sky.get_window_state({
            window,
            include_screenshot: false,
            include_text: true,
          });

        await getState({ id: 7, title: "T3 Code (Dev)" });
        // Same window whose title changed (dirty marker, tab switch): the
        // session grant must survive, keyed on the stable window id.
        await getState({ id: 7, title: "* T3 Code (Dev)" });
        await getState({ id: 8, title: "Iris" });

        NodeAssert.equal(elicitations.length, 2);
        NodeAssert.equal(requests.length, 6);
        for (const offset of [0, 2, 4]) {
          NodeAssert.equal(requests[offset]?.meta["x-oai-cua-approved-app"], undefined);
          NodeAssert.equal(requests[offset + 1]?.meta["x-oai-cua-approved-app"], "electron.exe");
          NodeAssert.equal(requests[offset + 1]?.method, requests[offset]?.method);
          NodeAssert.deepStrictEqual(requests[offset + 1]?.params, requests[offset]?.params);
        }
        NodeAssert.notDeepStrictEqual(requests[0]?.params, requests[4]?.params);
      },
    ));

  it.effect("locates the helper from configured module roots without a runtime hash", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cua-helper-"))),
      (root) =>
        Effect.gen(function* () {
          const helperPath = NodePath.join(
            root,
            "@oai",
            "sky",
            "bin",
            "windows",
            "codex-computer-use.exe",
          );
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.dirname(helperPath), { recursive: true }),
          );
          yield* Effect.promise(() => NodeFSP.writeFile(helperPath, "helper", "utf8"));

          NodeAssert.equal(
            yield* findComputerUseHelper([NodePath.join(root, "missing"), root]),
            helperPath,
          );
        }),
      (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
    ),
  );
});
