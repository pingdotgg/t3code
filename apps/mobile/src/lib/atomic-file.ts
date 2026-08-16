import type { File } from "expo-file-system";

let tempFileSequence = 0;

/**
 * Replaces a file's contents through a sibling temp file and an overwriting
 * rename, so an interrupted write (app restart, process death) never leaves a
 * truncated document at the final path. Each write stages through its own
 * temp file so concurrent writers to the same destination cannot move or
 * clobber each other's staging file mid-flight.
 */
export async function writeFileAtomically(file: File, contents: string): Promise<void> {
  const { File: FileConstructor } = await import("expo-file-system");
  tempFileSequence += 1;
  const temp = new FileConstructor(file.parentDirectory, `${file.name}.${tempFileSequence}.tmp`);
  temp.create({ intermediates: true, overwrite: true });
  temp.write(contents);
  temp.moveSync(file, { overwrite: true });
}
