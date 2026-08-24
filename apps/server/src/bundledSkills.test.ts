import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

import {
  initializeCodexAppServerWithBundledSkills,
  registerBundledSkillsExtraRoot,
  resolveAsarUnpackedPath,
  resolveBundledMidsceneSkillPath,
  resolveBundledPiMcpExtensionPath,
  resolveBundledSkillsRoot,
} from "./bundledSkills.ts";

type CodexInitializationClient = Pick<
  CodexClient.CodexAppServerClient["Service"],
  "notify" | "request"
>;

const initializeParams = {
  clientInfo: {
    name: "t3code_desktop",
    title: "T3 Code Desktop",
    version: "0.1.0",
  },
  capabilities: {
    experimentalApi: true,
  },
} as const;

const SkillMetadata = Schema.Struct({
  name: Schema.Literal("midscene-preview"),
  description: Schema.String.check(Schema.isNonEmpty()),
});
const OpenAiSkillMetadata = Schema.Struct({
  interface: Schema.Struct({
    display_name: Schema.Literal("Midscene Preview"),
    short_description: Schema.Literal("Control and verify the built-in browser"),
    default_prompt: Schema.Literal("Use $midscene-preview to interact with the built-in browser."),
  }),
});
const decodeSkillMetadata = Schema.decodeUnknownEffect(fromYaml(SkillMetadata));
const decodeOpenAiSkillMetadata = Schema.decodeUnknownEffect(fromYaml(OpenAiSkillMetadata));

function skillFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) throw new Error("Skill frontmatter must start the file.");
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("Skill frontmatter is not terminated.");
  return markdown.slice(4, end);
}

describe("bundled Skills", () => {
  it.effect("resolves the source or distribution sibling in regular filesystem layouts", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* resolveBundledSkillsRoot("/opt/t3/apps/server/dist"),
        "/opt/t3/apps/server/dist/bundled-skills",
      );
      assert.equal(
        yield* resolveBundledMidsceneSkillPath("/opt/t3/apps/server/dist"),
        "/opt/t3/apps/server/dist/bundled-skills/midscene-preview/SKILL.md",
      );
      assert.equal(
        yield* resolveBundledPiMcpExtensionPath("/opt/t3/apps/server/dist"),
        "/opt/t3/apps/server/dist/bundled-pi-extension/index.mjs",
      );
      assert.equal(
        yield* resolveBundledPiMcpExtensionPath("/opt/t3/apps/server/src"),
        "/opt/t3/apps/server/src/bundled-pi-extension/index.ts",
      );
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it("keeps ASAR unpacking available for bundled files that require it", () => {
    assert.equal(
      resolveAsarUnpackedPath(
        "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist/bundled-skills",
      ),
      "/Applications/T3 Code.app/Contents/Resources/app.asar.unpacked/apps/server/dist/bundled-skills",
    );
    assert.equal(
      resolveAsarUnpackedPath(
        String.raw`C:\Program Files\T3 Code\resources\app.asar\apps\server\dist\bundled-skills`,
      ),
      String.raw`C:\Program Files\T3 Code\resources\app.asar.unpacked\apps\server\dist\bundled-skills`,
    );
  });

  it.effect("maps packaged macOS Skills to the external resources directory", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* resolveBundledSkillsRoot(
          "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist",
        ),
        "/Applications/T3 Code.app/Contents/Resources/bundled-skills",
      );
      assert.equal(
        yield* resolveBundledMidsceneSkillPath(
          "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist",
        ),
        "/Applications/T3 Code.app/Contents/Resources/bundled-skills/midscene-preview/SKILL.md",
      );
      assert.equal(
        yield* resolveBundledPiMcpExtensionPath(
          "/Applications/T3 Code.app/Contents/Resources/app.asar/apps/server/dist",
        ),
        "/Applications/T3 Code.app/Contents/Resources/bundled-pi-extension/index.mjs",
      );
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it.effect("maps packaged Windows Skills outside app.asar and server.asar", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* resolveBundledSkillsRoot(
          String.raw`C:\Program Files\T3 Code\resources\app.asar\apps\server\dist`,
        ),
        String.raw`C:\Program Files\T3 Code\resources\bundled-skills`,
      );
      assert.equal(
        yield* resolveBundledSkillsRoot(
          String.raw`C:\Program Files\T3 Code\resources\server.asar\apps\server\dist`,
        ),
        String.raw`C:\Program Files\T3 Code\resources\bundled-skills`,
      );
      assert.equal(
        yield* resolveBundledPiMcpExtensionPath(
          String.raw`C:\Program Files\T3 Code\resources\app.asar\apps\server\dist`,
        ),
        String.raw`C:\Program Files\T3 Code\resources\bundled-pi-extension\index.mjs`,
      );
      assert.equal(
        yield* resolveBundledPiMcpExtensionPath(
          String.raw`C:\Program Files\T3 Code\resources\server.asar\apps\server\dist`,
        ),
        String.raw`C:\Program Files\T3 Code\resources\bundled-pi-extension\index.mjs`,
      );
    }).pipe(Effect.provide(NodePath.layerWin32)),
  );

  it.effect("ships valid and matching Midscene Skill metadata", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* resolveBundledSkillsRoot(import.meta.dirname);
      const skillDirectory = path.join(root, "midscene-preview");
      const skillMarkdown = yield* fileSystem.readFileString(path.join(skillDirectory, "SKILL.md"));
      const openAiYaml = yield* fileSystem.readFileString(
        path.join(skillDirectory, "agents", "openai.yaml"),
      );

      const skill = yield* decodeSkillMetadata(skillFrontmatter(skillMarkdown));
      const openAi = yield* decodeOpenAiSkillMetadata(openAiYaml);

      assert.equal(skill.name, "midscene-preview");
      assert.match(skill.description, /built-in browser/);
      assert.match(
        skillMarkdown,
        /If configuration is unknown, do not call Midscene merely to probe it/,
      );
      assert.match(
        skillMarkdown,
        /Continue in the same built-in browser with deterministic `preview_\*` tools/,
      );
      assert.equal(openAi.interface.display_name, "Midscene Preview");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("registers the bundled root after the initialized notification", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly kind: "notify" | "request";
        readonly method: string;
        readonly payload: unknown;
      }> = [];
      const client = {
        request: (method: string, payload: unknown) => {
          calls.push({ kind: "request", method, payload });
          return Effect.succeed(
            method === "initialize"
              ? {
                  userAgent: "codex/1.0.0",
                  codexHome: "/tmp/codex",
                  platformFamily: "unix",
                  platformOs: "macos",
                }
              : {},
          );
        },
        notify: (method: string, payload: unknown) => {
          calls.push({ kind: "notify", method, payload });
          return Effect.void;
        },
      } as unknown as CodexInitializationClient;

      const initialized = yield* initializeCodexAppServerWithBundledSkills(
        client,
        initializeParams,
        "/opt/t3/bundled-skills",
      );

      assert.equal(initialized.userAgent, "codex/1.0.0");
      assert.deepStrictEqual(calls, [
        { kind: "request", method: "initialize", payload: initializeParams },
        { kind: "notify", method: "initialized", payload: undefined },
        {
          kind: "request",
          method: "skills/extraRoots/set",
          payload: { extraRoots: ["/opt/t3/bundled-skills"] },
        },
      ]);
    }),
  );

  it.effect("continues when an older Codex does not implement extra roots", () =>
    Effect.gen(function* () {
      const client = {
        request: () =>
          Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32601,
              errorMessage: "Method not found: skills/extraRoots/set",
            }),
          ),
      } as unknown as Pick<CodexInitializationClient, "request">;

      yield* registerBundledSkillsExtraRoot(client, "/opt/t3/bundled-skills");
    }),
  );

  it.effect("propagates every extra-roots failure except method-not-found", () =>
    Effect.gen(function* () {
      const failure = new CodexErrors.CodexAppServerRequestError({
        code: -32602,
        errorMessage: "Invalid skills root",
      });
      const client = {
        request: () => Effect.fail(failure),
      } as unknown as Pick<CodexInitializationClient, "request">;

      const error = yield* registerBundledSkillsExtraRoot(client, "/opt/t3/bundled-skills").pipe(
        Effect.flip,
      );

      assert.strictEqual(error, failure);
    }),
  );
});
