import type { File } from "expo-file-system";

let tempFileSequence = 0;

/** Use distinct staging files for concurrent writes and remove them on failure. */
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
    } catch {}
    throw error;
  }
}
