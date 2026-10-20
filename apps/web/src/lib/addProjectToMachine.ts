import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectCloneSnapshot, ProjectId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjectClonesAtom } from "../state/projectClones";
import { projectEnvironment } from "../state/projects";
import { sourceControlEnvironment } from "../state/sourceControl";

export type CloneProtocol = "ssh" | "https";

/** Matches the server's read cap: a larger file would arrive truncated. */
export const COPYABLE_FILE_MAX_BYTES = 1024 * 1024;

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/;
const SSH_URL = /^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^@/\s]+@)?([^:/\s]+)(:\d+)?\/(.+)$/;

function parseCloneUrl(
  url: string,
): { protocol: CloneProtocol; host: string; path: string; customPort: boolean } | null {
  const trimmed = url.trim();
  const ssh = SSH_URL.exec(trimmed);
  if (ssh) return { protocol: "ssh", host: ssh[1]!, path: ssh[3]!, customPort: !!ssh[2] };
  const https = HTTPS_URL.exec(trimmed);
  if (https) return { protocol: "https", host: https[1]!, path: https[3]!, customPort: !!https[2] };
  const scp = SCP_LIKE_URL.exec(trimmed);
  if (scp) return { protocol: "ssh", host: scp[1]!, path: scp[2]!, customPort: false };
  return null;
}

export function cloneUrlProtocol(url: string): CloneProtocol | null {
  return parseCloneUrl(url)?.protocol ?? null;
}

/**
 * Rewrites a clone URL to the other protocol, because the target machine may
 * only have SSH keys or only an HTTPS credential helper. Returns null when the
 * URL cannot be rewritten safely, such as a custom port.
 */
export function cloneUrlForProtocol(url: string, protocol: CloneProtocol): string | null {
  const parsed = parseCloneUrl(url);
  if (!parsed) return null;
  if (parsed.protocol === protocol) return url.trim();
  if (parsed.customPort) return null;
  return protocol === "ssh"
    ? `git@${parsed.host}:${parsed.path}`
    : `https://${parsed.host}/${parsed.path}`;
}

const DEFAULT_COPIED_FILE_NAME = /^(?:\.env(?:\..+)?|\.envrc|\.dev\.vars)$/;

/** Env files are the ignored files people almost always want on a new machine. */
export function isDefaultCopiedFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return DEFAULT_COPIED_FILE_NAME.test(name);
}

export interface AddProjectToMachineInput {
  readonly source: { readonly environmentId: EnvironmentId; readonly cwd: string };
  /** Where the source project sits below its repository root, or "". */
  readonly subdirectory: string;
  readonly target: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly projectId: ProjectId;
  readonly title: string;
  readonly remoteUrl: string;
  readonly destinationPath: string;
  readonly files: ReadonlyArray<string>;
}

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

/**
 * Resolves when the clone finishes, or null once it is removed. A failed or
 * cancelled clone keeps waiting, since its toast offers a retry.
 */
function waitForClone(environmentId: EnvironmentId, projectId: ProjectId) {
  return new Promise<ProjectCloneSnapshot | null>((resolve) => {
    const atom = environmentProjectClonesAtom(environmentId);
    let seen = false;
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const check = (clones: ReadonlyArray<ProjectCloneSnapshot>) => {
      if (settled) return;
      const clone = clones.find((candidate) => candidate.projectId === projectId);
      if (clone) seen = true;
      const result = clone?.phase === "done" ? clone : !clone && seen ? null : undefined;
      if (result === undefined) return;
      settled = true;
      unsubscribe?.();
      resolve(result);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    check(appAtomRegistry.get(atom));
  });
}

/**
 * Clones a project onto another machine, then copies the chosen ignored files
 * from the source. The client relays the files because the two servers never
 * talk to each other. Resolves once the clone starts; the clone toast shows
 * progress and a second toast reports the copied files.
 */
export async function addProjectToMachine(input: AddProjectToMachineInput): Promise<void> {
  // Read first, so the copy reflects the files as they were when the user asked.
  const reads = await Promise.all(
    input.files.map(async (relativePath) => {
      const result = await executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.readFile({
          environmentId: input.source.environmentId,
          input: { cwd: input.source.cwd, relativePath },
        }),
        { label: "Read file to copy", reportFailure: false, refresh: true },
      );
      if (result._tag === "Failure") return { relativePath, error: failureMessage(result) };
      if (result.value.truncated) return { relativePath, error: "Too large to copy." };
      return { relativePath, contents: result.value.contents };
    }),
  );

  const started = await runAtomCommand(
    appAtomRegistry,
    sourceControlEnvironment.startProjectClone,
    {
      environmentId: input.target.environmentId,
      input: {
        projectId: input.projectId,
        title: input.title,
        createdAt: new Date().toISOString(),
        remoteUrl: input.remoteUrl,
        destinationPath: input.destinationPath,
      },
    },
    { label: "Add project to machine", reportFailure: false },
  );
  if (started._tag === "Failure") throw new Error(failureMessage(started));
  if (input.files.length === 0) return;

  void (async () => {
    const clone = await waitForClone(input.target.environmentId, input.projectId);
    if (!clone) return;
    const failed: Array<string> = [];
    let copied = 0;
    for (const read of reads) {
      if (!("contents" in read)) {
        failed.push(`${read.relativePath}: ${read.error}`);
        continue;
      }
      const written = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.writeFile,
        {
          environmentId: input.target.environmentId,
          input: {
            cwd: started.value.cwd,
            relativePath: input.subdirectory
              ? `${input.subdirectory}/${read.relativePath}`
              : read.relativePath,
            contents: read.contents,
          },
        },
        { label: "Copy file to machine", reportFailure: false },
      );
      if (written._tag === "Failure")
        failed.push(`${read.relativePath}: ${failureMessage(written)}`);
      else copied += 1;
    }
    const noun = (count: number) => (count === 1 ? "file" : "files");
    toastManager.add(
      stackedThreadToast(
        failed.length === 0
          ? {
              type: "success",
              title: `Copied ${copied} ${noun(copied)} to ${input.target.label}`,
              description: reads.map((read) => read.relativePath).join(", "),
            }
          : {
              type: "error",
              title: `Could not copy ${failed.length} ${noun(failed.length)} to ${input.target.label}`,
              description: failed.join("\n"),
            },
      ),
    );
  })();
}
