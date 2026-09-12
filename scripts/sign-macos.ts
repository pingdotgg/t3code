import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

const STABLE_ADHOC_BUNDLE_ID_ENV = "T3CODE_MACOS_STABLE_ADHOC_BUNDLE_ID";

/** Sign files with matching options together instead of spawning codesign for each file. */
export default async function sign(options: SignOptions): Promise<void> {
  const stableAdhocBundleId = process.env[STABLE_ADHOC_BUNDLE_ID_ENV]?.trim();
  if (!stableAdhocBundleId) {
    await signApplication({ ...options, batchCodesignCalls: true });
    return;
  }
  if (!/^[A-Za-z0-9.-]+$/u.test(stableAdhocBundleId)) {
    throw new Error(`${STABLE_ADHOC_BUNDLE_ID_ENV} must be a bundle identifier.`);
  }

  const existingOptionsForFile = options.optionsForFile;
  await signApplication({
    ...options,
    identity: "-",
    identityValidation: false,
    batchCodesignCalls: true,
    optionsForFile: (filePath, context) => ({
      ...existingOptionsForFile?.(filePath, context),
      timestamp: "none",
      ...(filePath === options.app
        ? {
            requirements: `=designated => identifier "${stableAdhocBundleId}"`,
          }
        : {}),
    }),
  });
}
