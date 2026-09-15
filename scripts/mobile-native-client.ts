// @effect-diagnostics nodeBuiltinImport:off - Local native build tooling runs outside the server runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export type NativePlatform = "ios" | "android";
export interface NativeClientRecord {
  fingerprint: string;
  binary: string;
}
export type NativeClientStatus = "compatible" | "missing" | "unknown" | "stale";

export function clientStatus(
  fingerprint: string,
  binary: string | null,
  record: NativeClientRecord | null,
): NativeClientStatus {
  if (binary === null) return "missing";
  if (!record || record.binary !== binary) return "unknown";
  return record.fingerprint === fingerprint ? "compatible" : "stale";
}

/** Record only a successful installation built from unchanged native inputs. */
export async function ensureClient(operations: {
  fingerprint: () => Promise<string>;
  installedBinary: () => Promise<string | null>;
  readRecord: () => Promise<NativeClientRecord | null>;
  build: () => Promise<void>;
  saveRecord: (record: NativeClientRecord) => Promise<void>;
}) {
  const fingerprint = await operations.fingerprint();
  const status = clientStatus(
    fingerprint,
    await operations.installedBinary(),
    await operations.readRecord(),
  );
  if (status === "compatible") return { status, rebuilt: false, fingerprint };
  await operations.build();
  if ((await operations.fingerprint()) !== fingerprint) {
    throw new Error(
      "Native inputs changed during the build. Run ensure again; this build was not recorded.",
    );
  }
  const binary = await operations.installedBinary();
  if (binary === null)
    throw new Error("Build finished but the development client is not installed.");
  await operations.saveRecord({ fingerprint, binary });
  return { status: "compatible" as const, rebuilt: true, fingerprint };
}

/** Hash bundle contents, including native libraries and resources, not its install path or mtime. */
export async function hashBundle(root: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  async function visit(relative: string) {
    const entries = await NodeFSP.readdir(NodePath.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const name = NodePath.join(relative, entry.name);
      const absolute = NodePath.join(root, name);
      hash.update(JSON.stringify([name, entry.isDirectory(), entry.isSymbolicLink()]));
      if (entry.isDirectory()) await visit(name);
      else if (entry.isSymbolicLink()) hash.update(await NodeFSP.readlink(absolute));
      else {
        const fileHash = NodeCrypto.createHash("sha256");
        for await (const chunk of NodeFS.createReadStream(absolute)) fileHash.update(chunk);
        hash.update(fileHash.digest());
      }
    }
  }
  await visit("");
  return hash.digest("hex");
}

const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const mobileRoot = NodePath.join(repoRoot, "apps/mobile");
const bundleId = "com.t3tools.t3code.dev";

function command(program: string, args: string[], inherit = false): string {
  const result = NodeChildProcess.spawnSync(program, args, {
    cwd: mobileRoot,
    env: {
      ...process.env,
      APP_VARIANT: "development",
      MOBILE_VERSION_POLICY: "appVersion",
      T3CODE_IOS_PERSONAL_TEAM: "0",
      CI: "1",
      EXPO_NO_GIT_STATUS: "1",
    },
    encoding: "utf8",
    stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args[0]} failed (${result.status}): ${result.stderr ?? "see build output"}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

async function fingerprint(platform: NativePlatform) {
  const output = command(process.execPath, [
    "--eval",
    `require('expo/fingerprint').createFingerprintAsync(process.cwd(), { platforms: [process.argv[1]], silent: true }).then(fp => console.log('T3_NATIVE_FINGERPRINT=' + fp.hash)).catch(e => { console.error(e); process.exitCode = 1; });`,
    platform,
  ]);
  const hash = output
    .split("\n")
    .find((line) => line.startsWith("T3_NATIVE_FINGERPRINT="))
    ?.split("=")[1];
  if (!hash || !/^[a-f0-9]{40,64}$/.test(hash))
    throw new Error("Expo did not return a native fingerprint.");
  return hash;
}

function validateDevice(platform: NativePlatform, device: string) {
  if (platform === "ios") {
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone host build CLI, outside the Effect runtime.
    if (NodeOS.platform() !== "darwin")
      throw new Error("Run iOS check/ensure on the Mac that hosts the simulator.");
    const listing: { devices: Record<string, { udid: string; state: string }[]> } = JSON.parse(
      command("xcrun", ["simctl", "list", "devices", "available", "--json"]),
    );
    const simulator = Object.values(listing.devices)
      .flat()
      .find((entry) => entry.udid === device);
    if (!simulator) throw new Error(`No available iOS simulator with UDID ${device}.`);
    if (simulator.state !== "Booted")
      throw new Error(`Boot the selected simulator first: xcrun simctl boot ${device}`);
  } else {
    if (command("adb", ["-s", device, "get-state"]) !== "device")
      throw new Error("Android device is not connected.");
    if (command("adb", ["-s", device, "shell", "getprop", "ro.kernel.qemu"]) !== "1") {
      throw new Error("Select an Android emulator, not a physical device.");
    }
  }
}

export async function installedBinary(platform: NativePlatform, device: string, run = command) {
  if (platform === "ios") {
    // Listing apps distinguishes an absent app from a failed simctl command.
    const apps = run("xcrun", ["simctl", "listapps", device]);
    if (!apps.includes(`"${bundleId}"`)) return null;
    return hashBundle(run("xcrun", ["simctl", "get_app_container", device, bundleId, "app"]));
  }
  const installed = run("adb", ["-s", device, "shell", "pm", "list", "packages", bundleId]);
  if (!installed.split("\n").some((line) => line.trim() === `package:${bundleId}`)) return null;
  const packages = run("adb", ["-s", device, "shell", "pm", "path", bundleId]);
  const apks = packages
    .split("\n")
    .filter((line) => line.startsWith("package:"))
    .map((line) => line.slice(8).trim())
    .sort();
  if (apks.length === 0) return null;
  const hashes = apks.map((apk) => {
    if (!/^\/[\w/+=.~-]+\.apk$/.test(apk)) throw new Error("Unexpected installed APK path.");
    const hash = run("adb", ["-s", device, "shell", "sha256sum", apk]).split(/\s/)[0];
    if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Could not hash installed APK.");
    return hash;
  });
  return NodeCrypto.createHash("sha256").update(hashes.sort().join("\n")).digest("hex");
}

async function main() {
  const [mode, platform, device, ...extra] = process.argv.slice(2);
  if (
    (mode !== "check" && mode !== "ensure") ||
    (platform !== "ios" && platform !== "android") ||
    !device ||
    extra.length
  ) {
    throw new Error(
      "Usage: node scripts/mobile-native-client.ts <check|ensure> <ios|android> <simulator-udid|emulator-serial>",
    );
  }
  validateDevice(platform, device);
  const recordPath = NodePath.join(
    NodeOS.homedir(),
    ".cache/t3code/native-clients",
    platform,
    `${NodeCrypto.createHash("sha256").update(device).digest("hex")}.json`,
  );
  const operations = {
    fingerprint: () => fingerprint(platform),
    installedBinary: () => installedBinary(platform, device),
    readRecord: async (): Promise<NativeClientRecord | null> => {
      try {
        const record: unknown = JSON.parse(await NodeFSP.readFile(recordPath, "utf8"));
        return record !== null &&
          typeof record === "object" &&
          "fingerprint" in record &&
          "binary" in record &&
          typeof record.fingerprint === "string" &&
          typeof record.binary === "string"
          ? { fingerprint: record.fingerprint, binary: record.binary }
          : null;
      } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
          return null;
        throw error;
      }
    },
    build: async () => {
      process.stderr.write(
        "Native client is missing, stale, or unverified. Building and installing a development client...\n",
      );
      const tracked = NodeChildProcess.execFileSync(
        "git",
        ["ls-files", `apps/mobile/${platform}`],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );
      if (tracked.trim())
        throw new Error(
          "Native directory contains tracked files; clean prebuild would overwrite them.",
        );
      command(
        "vp",
        ["exec", "expo", "prebuild", "--clean", "--platform", platform, "--no-install"],
        true,
      );
      command(
        "vp",
        [
          "exec",
          "expo",
          `run:${platform}`,
          "--device",
          device,
          "--no-bundler",
          ...(platform === "ios"
            ? ["--configuration", "Debug", "--scheme", "T3CodeDev"]
            : ["--variant", "debug"]),
        ],
        true,
      );
    },
    saveRecord: async (record: NativeClientRecord) => {
      await NodeFSP.mkdir(NodePath.dirname(recordPath), { recursive: true });
      await NodeFSP.writeFile(recordPath, JSON.stringify(record) + "\n");
    },
  };
  if (mode === "ensure") {
    process.stdout.write(JSON.stringify(await ensureClient(operations)) + "\n");
  } else {
    const current = await operations.fingerprint();
    const status = clientStatus(
      current,
      await operations.installedBinary(),
      await operations.readRecord(),
    );
    process.stdout.write(
      JSON.stringify({
        status,
        fingerprint: current,
        next:
          status === "compatible"
            ? "Start Metro with vp run dev:client"
            : `node scripts/mobile-native-client.ts ensure ${platform} ${device}`,
      }) + "\n",
    );
    process.exitCode = status === "compatible" ? 0 : 2;
  }
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
