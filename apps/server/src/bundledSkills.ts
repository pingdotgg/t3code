import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";

const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

type CodexInitializationClient = Pick<
  CodexClient.CodexAppServerClient["Service"],
  "notify" | "request"
>;

export function resolveAsarUnpackedPath(filePath: string): string {
  return filePath.replace(/([\\/])app\.asar(?=[\\/])/, "$1app.asar.unpacked");
}

function resolveElectronResourcesDirectory(moduleDirectory: string): string | undefined {
  const asarBoundary = /[\\/](?:app|server)\.asar(?=[\\/]|$)/u.exec(moduleDirectory);
  return asarBoundary ? moduleDirectory.slice(0, asarBoundary.index) : undefined;
}

export const resolveBundledSkillsRoot = Effect.fn("resolveBundledSkillsRoot")(function* (
  moduleDirectory: string = import.meta.dirname,
) {
  const path = yield* Path.Path;
  const electronResourcesDirectory = resolveElectronResourcesDirectory(moduleDirectory);
  return path.join(electronResourcesDirectory ?? moduleDirectory, "bundled-skills");
});

export const resolveBundledMidsceneSkillPath = Effect.fn("resolveBundledMidsceneSkillPath")(
  function* (moduleDirectory: string = import.meta.dirname) {
    const path = yield* Path.Path;
    const root = yield* resolveBundledSkillsRoot(moduleDirectory);
    return path.join(root, "midscene-preview", "SKILL.md");
  },
);

export const resolveBundledPiMcpExtensionPath = Effect.fn("resolveBundledPiMcpExtensionPath")(
  function* (moduleDirectory: string = import.meta.dirname) {
    const path = yield* Path.Path;
    const electronResourcesDirectory = resolveElectronResourcesDirectory(moduleDirectory);
    const entryFileName =
      electronResourcesDirectory === undefined && path.basename(moduleDirectory) === "src"
        ? "index.ts"
        : "index.mjs";
    return path.join(
      electronResourcesDirectory ?? moduleDirectory,
      "bundled-pi-extension",
      entryFileName,
    );
  },
);

export const registerBundledSkillsExtraRoot = Effect.fn("registerBundledSkillsExtraRoot")(
  function* (client: Pick<CodexInitializationClient, "request">, bundledSkillsRoot?: string) {
    const extraRoot =
      bundledSkillsRoot ?? (yield* resolveBundledSkillsRoot().pipe(Effect.provide(NodePath.layer)));
    yield* client
      .request("skills/extraRoots/set", {
        extraRoots: [extraRoot],
      })
      .pipe(
        Effect.catch((error) => {
          if (isCodexAppServerRequestError(error) && error.code === -32601) {
            return Effect.logDebug(
              "Codex App Server does not support bundled Skill roots; continuing without them.",
            );
          }
          return Effect.fail(error);
        }),
      );
  },
);

export const initializeCodexAppServerWithBundledSkills = Effect.fn(
  "initializeCodexAppServerWithBundledSkills",
)(function* (
  client: CodexInitializationClient,
  params: CodexSchema.V1InitializeParams,
  bundledSkillsRoot?: string,
) {
  const initialized = yield* client.request("initialize", params);
  yield* client.notify("initialized", undefined);
  yield* registerBundledSkillsExtraRoot(client, bundledSkillsRoot);
  return initialized;
});
