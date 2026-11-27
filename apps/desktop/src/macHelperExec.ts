// @effect-diagnostics nodeBuiltinImport:off -- Shared with the macOS backend entry, which runs before Effect.
import * as NodePath from "node:path";

/** The Dock-less Helper that Electron ships inside a macOS app bundle beside its main executable. */
export function macHelperExecutable(executable: string): string {
  const name = NodePath.basename(executable);
  return NodePath.join(
    executable,
    "../../Frameworks",
    `${name} Helper.app/Contents/MacOS/${name} Helper`,
  );
}
