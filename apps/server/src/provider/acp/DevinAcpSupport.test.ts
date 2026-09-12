// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";
import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  buildDevinPrompt,
  currentDevinModelIdFromSessionSetup,
  DEVIN_BROWSER_AUTH_METHOD,
  devinCredentialsFilePaths,
  devinHasAmbientCredentials,
  devinModeFor,
  resolveDevinAuthMethodId,
  resolveDevinModeId,
  resolveDevinModelId,
} from "./DevinAcpSupport.ts";

const modeState = (modes: ReadonlyArray<{ id: string; name?: string }>): AcpSessionModeState => ({
  currentModeId: modes[0]?.id ?? "ask",
  availableModes: modes.map((mode) => ({ id: mode.id, name: mode.name ?? mode.id })),
});

const DEVIN_MODES = modeState([
  { id: "accept-edits" },
  { id: "smart" },
  { id: "ask" },
  { id: "plan" },
  { id: "bypass" },
]);

it.layer(NodeServices.layer)("DevinAcpSupport", (it) => {
  it("maps T3 runtime and interaction modes onto Devin session modes", () => {
    assert.equal(devinModeFor("full-access", undefined), "bypass");
    assert.equal(devinModeFor("auto", undefined), "smart");
    assert.equal(devinModeFor("auto-accept-edits", undefined), "accept-edits");
    assert.equal(devinModeFor("approval-required", undefined), "ask");
    assert.equal(devinModeFor("full-access", "plan"), "plan");
    assert.equal(devinModeFor("approval-required", "plan"), "plan");
  });

  it("resolves only modes Devin actually advertises", () => {
    assert.equal(
      resolveDevinModeId({
        runtimeMode: "full-access",
        interactionMode: undefined,
        modeState: DEVIN_MODES,
      }),
      "bypass",
    );
    assert.equal(
      resolveDevinModeId({
        runtimeMode: "approval-required",
        interactionMode: "plan",
        modeState: DEVIN_MODES,
      }),
      "plan",
    );
    assert.isUndefined(
      resolveDevinModeId({
        runtimeMode: "full-access",
        interactionMode: undefined,
        modeState: modeState([{ id: "ask" }]),
      }),
    );
    assert.isUndefined(
      resolveDevinModeId({
        runtimeMode: "full-access",
        interactionMode: undefined,
        modeState: undefined,
      }),
    );
  });

  it("normalizes model selections through the Devin alias table", () => {
    assert.equal(resolveDevinModelId("swe-2"), "swe-2-high");
    assert.equal(resolveDevinModelId("swe2"), "swe-2-high");
    assert.equal(resolveDevinModelId("swe-2-medium"), "swe-2-medium");
    assert.equal(resolveDevinModelId("  claude-opus-4.5  "), "claude-opus-4.5");
    assert.isUndefined(resolveDevinModelId(undefined));
    assert.isUndefined(resolveDevinModelId("   "));
  });

  it("reads the current model from the session's model config option", () => {
    const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "swe-2-medium",
        options: [{ value: "swe-2-medium", name: "SWE-2 Medium" }],
      },
    ];
    assert.equal(
      currentDevinModelIdFromSessionSetup({ sessionId: "s", configOptions }),
      "swe-2-medium",
    );
    assert.isUndefined(currentDevinModelIdFromSessionSetup({ sessionId: "s" }));
    assert.isUndefined(
      currentDevinModelIdFromSessionSetup({
        sessionId: "s",
        configOptions: [
          {
            id: "fast",
            name: "Fast",
            category: "other",
            type: "boolean",
            currentValue: true,
          },
        ],
      }),
    );
  });

  it.effect("applies model selection through setModel only when the value changes", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const runtime = {
        getConfigOptions: Effect.succeed([
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "swe-2-high",
            options: [],
          },
        ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
        setModel: (modelId: string) =>
          Effect.sync(() => {
            calls.push(modelId);
          }),
      };

      const unchanged = yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-2-high",
        mapError: (cause) => cause,
      });
      assert.equal(unchanged, "swe-2-high");
      assert.deepEqual(calls, []);

      const changed = yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-2-max",
        mapError: (cause) => cause,
      });
      assert.equal(changed, "swe-2-max");
      assert.deepEqual(calls, ["swe-2-max"]);
    }),
  );

  it.effect("does not send set_config_option when the session has no model option", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const runtime = {
        getConfigOptions: Effect.succeed([
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "smart",
            options: [],
          },
        ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
        setModel: (modelId: string) =>
          Effect.sync(() => {
            calls.push(modelId);
          }),
      };

      const result = yield* applyDevinAcpModelSelection({
        runtime,
        model: "swe-2-max",
        mapError: (cause) => cause,
      });
      assert.isUndefined(result);
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("resolves no auth method when ambient credentials exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-home-" });
      const home = dir;
      yield* fs.makeDirectory(NodePath.join(home, ".local/share/devin"), { recursive: true });
      yield* fs.writeFileString(
        NodePath.join(home, ".local/share/devin/credentials.toml"),
        'token = "x"\n',
      );

      const environment = { HOME: home };
      assert.isTrue(yield* devinHasAmbientCredentials(environment));
      assert.isUndefined(yield* resolveDevinAuthMethodId({ environment, browserAuth: true }));
    }).pipe(Effect.scoped),
  );

  it.effect("prefers the API key env var over the credentials file", () =>
    Effect.gen(function* () {
      const environment = {
        HOME: NodePath.join(NodeOS.tmpdir(), "t3code-devin-no-such-home"),
        WINDSURF_API_KEY: "ws-test-key",
      };
      assert.isTrue(yield* devinHasAmbientCredentials(environment));
      assert.isUndefined(yield* resolveDevinAuthMethodId({ environment, browserAuth: true }));
    }),
  );

  it.effect("returns devin-browser only when logged out and browser auth is allowed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-home-" });
      const environment = { HOME: dir };

      assert.isFalse(yield* devinHasAmbientCredentials(environment));
      assert.equal(
        yield* resolveDevinAuthMethodId({ environment, browserAuth: true }),
        DEVIN_BROWSER_AUTH_METHOD,
      );
      // Background paths never get a browser method even when logged out.
      assert.isUndefined(yield* resolveDevinAuthMethodId({ environment, browserAuth: false }));
    }).pipe(Effect.scoped),
  );

  it("builds the devin acp spawn input from settings", () => {
    assert.deepEqual(buildDevinAcpSpawnInput(undefined, "/repo"), {
      command: "devin",
      args: ["acp"],
      cwd: "/repo",
    });
    assert.deepEqual(buildDevinAcpSpawnInput({ binaryPath: "/opt/devin" }, "/repo"), {
      command: "/opt/devin",
      args: ["acp"],
      cwd: "/repo",
    });
  });

  it("joins the credentials path under the resolved home", () => {
    assert.deepEqual(devinCredentialsFilePaths({ HOME: "/home/tester" }), [
      "/home/tester/.local/share/devin/credentials.toml",
    ]);
  });

  it("honours XDG_DATA_HOME and LOCALAPPDATA credential locations", () => {
    assert.deepEqual(
      devinCredentialsFilePaths({
        HOME: "/home/tester",
        XDG_DATA_HOME: "/data/xdg",
        LOCALAPPDATA: "C:/Users/tester/AppData/Local",
      }),
      [
        "/data/xdg/devin/credentials.toml",
        "C:/Users/tester/AppData/Local/devin/credentials.toml",
        "/home/tester/.local/share/devin/credentials.toml",
      ],
    );
  });

  it.effect("builds prompt blocks for text and attachments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-devin-prompt-" });
      const attachmentsDir = NodePath.join(dir, "attachments");
      yield* fs.makeDirectory(attachmentsDir, { recursive: true });
      // Attachment files live at `<attachmentsDir>/<attachmentId><ext>`.
      yield* fs.writeFileString(NodePath.join(attachmentsDir, "t-a1.md"), "# hello\n");
      yield* fs.writeFile(NodePath.join(attachmentsDir, "t-a2.png"), Buffer.from([0x89, 0x50]));

      const blocks = yield* buildDevinPrompt({
        input: "do the thing",
        attachments: [
          {
            type: "file",
            id: "t-a1",
            name: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 8,
          },
          {
            type: "image",
            id: "t-a2",
            name: "pic.png",
            mimeType: "image/png",
            sizeBytes: 2,
          },
        ],
        attachmentsDir,
      });

      assert.equal(blocks[0]?.type, "text");
      const resource = blocks.find((block) => block.type === "resource");
      assert.isDefined(resource);
      const image = blocks.find((block) => block.type === "image");
      assert.isDefined(image);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an empty prompt", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        buildDevinPrompt({
          input: "   ",
          attachments: [],
          attachmentsDir: NodeOS.tmpdir(),
        }),
      );
      assert.equal(error._tag, "AcpRequestError");
    }),
  );
});
