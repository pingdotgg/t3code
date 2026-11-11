/* eslint-disable t3code/no-global-process-runtime -- Encryption identity must be selected before asynchronous application startup. */
// @effect-diagnostics nodeBuiltinImport:off - compatibility uses an isolated Electron child; credentials travel only over its private IPC pipe.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Electron from "electron";

declare const __T3CODE_DESKTOP_BRAND__: string | undefined;
const brand = typeof __T3CODE_DESKTOP_BRAND__ === "undefined" ? "t3" : __T3CODE_DESKTOP_BRAND__;
const helperSwitch = "--t3-agents-legacy-safe-storage";

export function configureSharedEncryptionIdentity(input: {
  platform: string;
  brand: string;
  isDevelopment: boolean;
  setName: (name: string) => void;
}): void {
  if (input.brand === "agents" && !input.isDevelopment && input.platform !== "win32") {
    // Electron captures this name for Keychain/libsecret before `ready`. The
    // display name can be restored afterwards; install and updater IDs stay separate.
    input.setName("t3code");
  }
}

const usesAgentsStorageCompatibility = () =>
  brand === "agents" && !process.env.VITE_DEV_SERVER_URL?.trim();

export const usesSharedEncryptionIdentity = () =>
  usesAgentsStorageCompatibility() && process.platform !== "win32";

/** Detect UTF-8 loss after Linux's unauthenticated v11 CBC decryption.
 * A wrong key can pass its padding check. Electron then replaces invalid UTF-8
 * with U+FFFD instead of throwing, so the legacy identity never gets tried.
 * v11 encryption is deterministic; genuine U+FFFD text round-trips unchanged.
 */
export function validateNativeDecryption(
  ciphertext: Uint8Array,
  plaintext: string,
  platform: string,
  encryptString: (value: string) => Uint8Array,
): string {
  const bytes = Buffer.from(ciphertext);
  if (
    platform === "linux" &&
    bytes.subarray(0, 3).toString("ascii") === "v11" &&
    plaintext.includes("\uFFFD") &&
    !Buffer.from(encryptString(plaintext)).equals(bytes)
  ) {
    throw new Error("Native decryption returned invalid UTF-8");
  }
  return plaintext;
}

const validateDecryption = (bytes: Uint8Array, plaintext: string) =>
  validateNativeDecryption(bytes, plaintext, process.platform, (text) =>
    Electron.safeStorage.encryptString(text),
  );

/** Called synchronously from main, before Effect services can yield to Electron. */
export function prepareSharedSafeStorage(): boolean {
  if (process.argv.includes(helperSwitch) && typeof process.send === "function") {
    // Earlier Agents releases used this identity. The helper never opens T3's
    // database, starts a backend, or acquires the application's single-instance lock.
    Electron.app.setName("t3agents");
    process.once("disconnect", () => Electron.app.exit());
    process.once("message", async (message: unknown) => {
      try {
        if (typeof message !== "string") throw new Error("Invalid request");
        await Electron.app.whenReady();
        if (process.platform === "darwin") Electron.app.dock?.hide();
        const bytes = Buffer.from(message, "base64");
        let value: string;
        try {
          value = validateDecryption(bytes, Electron.safeStorage.decryptString(bytes));
        } catch {
          value = validateDecryption(
            bytes,
            (await Electron.safeStorage.decryptStringAsync(bytes)).result,
          );
        }
        process.send?.({ value }, () => Electron.app.quit());
      } catch {
        process.send?.({ failed: true }, () => Electron.app.quit());
      }
    });
    return true;
  }
  configureSharedEncryptionIdentity({
    platform: process.platform,
    brand,
    isDevelopment: Boolean(process.env.VITE_DEV_SERVER_URL?.trim()),
    setName: (name) => Electron.app.setName(name),
  });
  return false;
}

// A burst of catalog/auth reads must not open multiple Keychain prompts. Keep
// failures for this launch as well; restart retries after the OS keyring is unlocked.
const legacyDecryptions = new Map<string, Promise<string>>();
function decryptLegacyAgentsString(value: Uint8Array): Promise<string> {
  const key = NodeCrypto.createHash("sha256").update(value).digest("hex");
  const cached = legacyDecryptions.get(key);
  if (cached) return cached;
  if (legacyDecryptions.size >= 16)
    legacyDecryptions.delete(legacyDecryptions.keys().next().value!);
  const result = decryptLegacyAgentsStringUncached(value);
  legacyDecryptions.set(key, result);
  return result;
}

async function decryptLegacyAgentsStringUncached(value: Uint8Array): Promise<string> {
  if (!usesAgentsStorageCompatibility()) throw new Error("Legacy Agents encryption unavailable");
  const profile = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agents-key-"));
  try {
    if (process.platform === "win32") {
      // The pre-fix Windows build initialized DPAPI in the fork's default
      // profile. Copy only its encrypted native key into the disposable helper
      // profile; never launch a second process against an installed app's profile.
      await NodeFSP.copyFile(
        NodePath.join(Electron.app.getPath("appData"), "t3agents", "Local State"),
        NodePath.join(profile, "Local State"),
      );
    }
    return await new Promise<string>((resolve, reject) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const passwordStore = Electron.app.commandLine.getSwitchValue("password-store");
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          ...(!Electron.app.isPackaged ? [Electron.app.getAppPath()] : []),
          helperSwitch,
          ...(Electron.app.commandLine.hasSwitch("no-sandbox") ? ["--no-sandbox"] : []),
          `--user-data-dir=${profile}`,
          ...(passwordStore ? [`--password-store=${passwordStore}`] : []),
        ],
        {
          env,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          timeout: 60_000,
          killSignal: "SIGKILL",
        },
      );
      let result: string | undefined;
      child.once("message", (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "value" in message &&
          typeof message.value === "string"
        ) {
          result = message.value;
        }
      });
      child.once("error", () => {
        reject(new Error("Legacy Agents decryption helper could not start"));
      });
      child.once("close", () => {
        if (result !== undefined) resolve(result);
        else reject(new Error("Legacy Agents decryption failed"));
      });
      child.send(Buffer.from(value).toString("base64"), () => {});
    });
  } finally {
    await NodeFSP.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

export async function decryptSharedString(value: Uint8Array): Promise<string> {
  try {
    return validateDecryption(value, Electron.safeStorage.decryptString(Buffer.from(value)));
  } catch (cause) {
    if (!usesAgentsStorageCompatibility()) throw cause;
    return decryptLegacyAgentsString(value);
  }
}
