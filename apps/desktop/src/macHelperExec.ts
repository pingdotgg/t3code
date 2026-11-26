// @effect-diagnostics nodeBuiltinImport:off -- Shared with the macOS backend entry, which runs before Effect.
import * as NodePath from "node:path";

/** The macOS backend entry says this on the control channel (fd 5) from its final process. */
export const BACKEND_SETTLED_LINE = '{"version":1,"type":"backendSettled"}\n';
/** The entry then blocks reading this fd until the desktop has recorded the backend. */
export const BACKEND_SETTLED_ACK_FD = 8;

// sys/filio.h on Darwin.
const FIOCLEX = 0x20006601;
const FIONCLEX = 0x20006602;

/** The Dock-less Helper that Electron ships inside a macOS app bundle beside its main executable. */
export function macHelperExecutable(executable: string): string {
  const name = NodePath.basename(executable);
  return NodePath.join(
    executable,
    "../../Frameworks",
    `${name} Helper.app/Contents/MacOS/${name} Helper`,
  );
}

/**
 * Clears close-on-exec on each open descriptor so it survives an exec. Returns a restore that
 * reports the descriptors it could not flag again. Throws, flags restored, if any cannot be kept.
 */
export function keepOpenAcrossExec(
  descriptors: ReadonlyArray<number>,
  ioctl: (fd: number, request: number) => number,
): () => ReadonlyArray<number> {
  const kept: Array<number> = [];
  const restore = () => kept.filter((fd) => ioctl(fd, FIOCLEX) !== 0);
  for (const fd of descriptors) {
    if (ioctl(fd, FIONCLEX) !== 0) {
      const unrestored = restore();
      throw new Error(
        `descriptor ${fd} would close across the exec` +
          (unrestored.length > 0 ? `; ${unrestored.join(", ")} stay inheritable` : ""),
      );
    }
    kept.push(fd);
  }
  return restore;
}
