import { useAtomValue } from "@effect/atom-react";
import {
  assetUrlStateFromResult,
  type AssetUrlState,
  createAssetEnvironmentAtoms,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectReadFileError, ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { type Artifact, type ArtifactContents, listArtifacts } from "../store/artifacts";
import { failureText } from "../settings/failureText";
import { boardEngine } from "./boards";
import { engineConnectionAtom, engineEnvironmentIdAtom, environmentProjects } from "./projects";
import { environmentSession } from "./server";

const readFile = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "board:artifact:read-file",
  tag: WS_METHODS.projectsReadFile,
});
const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

const isReadFileError = Schema.is(ProjectReadFileError);
const decodeContentsKey = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
);
const decodeBoardKey = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.Array(Schema.String)])),
);

/** The pause between one listing finishing and the next starting, which bounds how late a new file shows. */
const ARTIFACT_POLL_MS = 1_000;

export const NO_ARTIFACTS: ReadonlyArray<Artifact> = [];

const sameList = (left: ReadonlyArray<Artifact>, right: ReadonlyArray<Artifact>) =>
  left.length === right.length &&
  left.every((a, index) => a.absolutePath === right[index]?.absolutePath);

/**
 * The artifacts of one board, keyed by `[projectId, folder, worktreePaths]` as JSON. The agents
 * write them with their own tools, so the app lists them again every moment while a board shows them.
 * The value is null until the first listing answers.
 */
export const boardArtifactsAtom = Atom.family((key: string) =>
  Atom.make<ReadonlyArray<Artifact> | null>((get) => {
    const [projectId, folder, worktreePaths] = decodeBoardKey(key);
    const environmentId = get.once(engineEnvironmentIdAtom);
    const project = get
      .once(environmentProjects.projectsAtom)
      .find((entry) => entry.id === projectId);
    if (
      get(engineConnectionAtom).state.phase === "connected" &&
      environmentId !== null &&
      project !== undefined
    ) {
      const { files } = boardEngine(get.registry, environmentId);
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = async () => {
        const started = performance.now();
        try {
          const next = await listArtifacts(files, {
            workspaceRoot: project.workspaceRoot,
            folder,
            worktreePaths,
          });
          performance.mark("board:artifacts-listed", {
            detail: { files: next.length, ms: performance.now() - started },
          });
          const before = Option.getOrNull(get.self<ReadonlyArray<Artifact> | null>()) ?? null;
          if (!stopped && (before === null || !sameList(before, next))) get.setSelf(next);
        } catch {
          // The last list stays up until the next listing answers.
        }
        if (!stopped) timer = setTimeout(() => void refresh(), ARTIFACT_POLL_MS);
      };
      void refresh();
      get.addFinalizer(() => {
        stopped = true;
        clearTimeout(timer);
      });
    }
    return Option.getOrElse(get.self<ReadonlyArray<Artifact> | null>(), () => null);
  }).pipe(Atom.withLabel(`board-artifacts:${key}`)),
);

export const boardArtifactsKey = (
  projectId: string,
  folder: string,
  worktreePaths: ReadonlyArray<string>,
) => JSON.stringify([projectId, folder, worktreePaths]);

/** One artifact's text, or why the viewer cannot show it as text. */
export async function readArtifact(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  cwd: string,
  absolutePath: string,
): Promise<ArtifactContents> {
  const result = await runAtomCommand(
    registry,
    readFile,
    { environmentId, input: { cwd, relativePath: absolutePath, allowMissing: true } },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
    const file = result.value;
    return file.exists === false
      ? { kind: "missing" }
      : {
          kind: "text",
          contents: file.contents,
          byteLength: file.byteLength,
          truncated: file.truncated,
        };
  }
  const failure = squashAtomCommandFailure(result);
  if (isReadFileError(failure) && failure.failure === "binary_file") return { kind: "binary" };
  throw new Error(failureText(result));
}

/**
 * The signed URL of an image on the engine's host. The engine serves an absolute path whatever
 * thread names it, so `threadId` only has to be one the schema accepts.
 */
export function useArtifactImageUrl(
  environmentId: EnvironmentId,
  threadId: string,
  absolutePath: string | null,
): AssetUrlState {
  const result = useAtomValue(
    absolutePath === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({
          environmentId,
          input: {
            resource: { _tag: "media-file", threadId: ThreadId.make(threadId), path: absolutePath },
          },
        }),
  );
  const connection = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  return assetUrlStateFromResult(
    result,
    connection._tag === "Some" ? connection.value.httpBaseUrl : null,
  );
}

export type LoadedArtifact =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "done"; readonly contents: ArtifactContents };

const LOADING: LoadedArtifact = { status: "loading" };

/** The text of one artifact, keyed by `[environmentId, cwd, absolutePath]` as JSON. It reads when the viewer opens the file. */
export const artifactContentsAtom = Atom.family((key: string) =>
  Atom.make<LoadedArtifact>((get) => {
    const [environmentId, cwd, absolutePath] = decodeContentsKey(key);
    readArtifact(get.registry, EnvironmentId.make(environmentId), cwd, absolutePath)
      .then(
        (contents): LoadedArtifact => ({ status: "done", contents }),
        (error): LoadedArtifact => ({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((result) => get.setSelf(result));
    return Option.getOrElse(get.self<LoadedArtifact>(), () => LOADING);
  }).pipe(Atom.withLabel(`artifact-contents:${key}`)),
);

export const artifactContentsKey = (
  environmentId: EnvironmentId,
  cwd: string,
  absolutePath: string,
) => JSON.stringify([environmentId, cwd, absolutePath]);
