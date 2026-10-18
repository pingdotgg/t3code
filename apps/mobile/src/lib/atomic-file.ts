import type { File } from "expo-file-system";

let tempFileSequence = 0;

/**
 * Each write stages through its own temp file so concurrent writers to the same
 * destination cannot move or clobber each other's staging file mid-flight.
 * A failed write must clean up its own staging file so retries do not leak it.
 */
export async function writeFileAtomically(file: File, contents: string): Promise<void> {
  const { File: FileConstructor } = await import("expo-file-system");
  tempFileSequence += 1;
  const temp = new FileConstructor(file.parentDirectory, `${file.name}.${tempFileSequence}.tmp`);
  try {
    temp.create({ intermediates: true, overwrite: true });
    await temp.write(contents);
    temp.moveSync(file, { overwrite: true });
  } catch (error) {
    try {
      if (temp.exists) temp.delete();
    } catch {
      // Preserve the original write failure even if best-effort cleanup fails.
    }
    throw error;
  }
}
