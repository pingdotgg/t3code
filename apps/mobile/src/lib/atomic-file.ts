import type { File } from "expo-file-system";

/**
 * Replaces a file's contents through a sibling temp file and an overwriting
 * rename, so an interrupted write (app restart, process death) never leaves a
 * truncated document at the final path.
 */
export async function writeFileAtomically(file: File, contents: string): Promise<void> {
  const { File: FileConstructor } = await import("expo-file-system");
  const temp = new FileConstructor(file.parentDirectory, `${file.name}.tmp`);
  temp.create({ intermediates: true, overwrite: true });
  temp.write(contents);
  temp.moveSync(file, { overwrite: true });
}
