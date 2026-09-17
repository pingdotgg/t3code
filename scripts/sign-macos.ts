import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

/** Sign files with matching options together instead of spawning codesign for each file. */
export default async function sign(options: SignOptions): Promise<void> {
  await signApplication({ ...options, batchCodesignCalls: true });
}
