import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** The renderer's local state, kept as one text file in the app's user data folder. */
export function createLocalStateFile(file: string) {
  return {
    read: (): string => {
      try {
        return NodeFS.readFileSync(file, "utf8");
      } catch {
        return "";
      }
    },
    write: (text: string): void => {
      // Renamed into place, so a crash mid-write never leaves half a file.
      const pending = `${file}.tmp`;
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(pending, text);
      NodeFS.renameSync(pending, file);
    },
  };
}
