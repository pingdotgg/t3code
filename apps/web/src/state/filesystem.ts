import { createFilesystemEnvironmentAtoms } from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId, FilesystemDriveList } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

// stream atoms never leave "waiting", so the query runner can't await them
export function waitForDrives(
  environmentId: EnvironmentId,
  timeoutMs = 3_000,
): Promise<FilesystemDriveList | null> {
  const atom = filesystemEnvironment.drives({ environmentId, input: {} });
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, timeoutMs);
    const finish = (result: AsyncResult.AsyncResult<FilesystemDriveList, unknown>) => {
      const list = Option.getOrNull(AsyncResult.value(result));
      if (list === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(list);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, finish);
    finish(appAtomRegistry.get(atom));
  });
}
