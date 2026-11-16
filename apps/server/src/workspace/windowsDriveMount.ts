const MOUNT_FIELD_ESCAPE = /\\([0-7]{3})/g;
const WINDOWS_ROOT = /^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)\\?$/;

const unescapeMountField = (field: string) =>
  field.replace(MOUNT_FIELD_ESCAPE, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

export const normalizeWindowsPath = (path: string) =>
  (/^[a-z]:/.test(path) ? path[0]!.toUpperCase() + path.slice(1) : path).replace(/\\$/, "");

/**
 * The Windows directory behind the deepest mount holding `dir`, read from
 * `/proc/self/mountinfo` so a custom automount root resolves and an ext4
 * mount under `/mnt` never passes for a drive.
 */
export function windowsMountFor(
  mountInfo: string,
  dir: string,
): { readonly mountPoint: string; readonly windowsRoot: string } | undefined {
  let deepest: { mountPoint: string; windowsRoot: string | undefined } | undefined;
  for (const line of mountInfo.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    if (separator === -1) continue;
    const mountPoint = unescapeMountField(fields[4] ?? "");
    const contains =
      mountPoint === "/" ||
      dir === mountPoint ||
      dir.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`);
    if (!contains || (deepest !== undefined && deepest.mountPoint.length > mountPoint.length)) {
      continue;
    }
    // WSL2 mounts drives over 9p with `aname=drvfs;path=C:\`; WSL1 as `drvfs`.
    const options = (fields[separator + 3] ?? "").split(/[,;]/);
    const source = options.includes("aname=drvfs")
      ? options.find((option) => option.startsWith("path="))?.slice("path=".length)
      : fields[separator + 1] === "drvfs"
        ? unescapeMountField(fields[separator + 2] ?? "")
        : undefined;
    const root = unescapeMountField(fields[3] ?? "/")
      .split("/")
      .filter(Boolean);
    deepest = {
      mountPoint,
      windowsRoot:
        source !== undefined && WINDOWS_ROOT.test(source)
          ? [normalizeWindowsPath(source), ...root].join("\\")
          : undefined,
    };
  }
  return deepest?.windowsRoot === undefined
    ? undefined
    : { mountPoint: deepest.mountPoint, windowsRoot: deepest.windowsRoot };
}
