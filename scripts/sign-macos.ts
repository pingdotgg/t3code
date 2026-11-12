import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

export default async function sign(options: SignOptions): Promise<void> {
  await signApplication({ ...options, batchCodesignCalls: true });
}
