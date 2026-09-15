// @effect-diagnostics nodeBuiltinImport:off - Tests exercise local filesystem build records.
import { assert, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  clientStatus,
  ensureClient,
  hashBundle,
  installedBinary,
  type NativeClientRecord,
} from "./mobile-native-client.ts";

it("requires a build for absent, unrecorded, replaced, and stale clients", () => {
  const record = { fingerprint: "native-a", binary: "binary-a" };
  assert.equal(clientStatus("native-a", null, record), "missing");
  assert.equal(clientStatus("native-a", "binary-a", null), "unknown");
  assert.equal(clientStatus("native-a", "binary-b", record), "unknown");
  assert.equal(clientStatus("native-b", "binary-a", record), "stale");
  assert.equal(clientStatus("native-a", "binary-a", record), "compatible");
});

it("builds an unknown client once, then reuses it across JavaScript changes", async () => {
  let record: NativeClientRecord | null = null;
  let builds = 0;
  const operations = {
    fingerprint: async () => "native-a",
    installedBinary: async () => "binary-a",
    readRecord: async () => record,
    build: async () => {
      builds++;
    },
    saveRecord: async (value: NativeClientRecord) => {
      record = value;
    },
  };
  assert.equal((await ensureClient(operations)).rebuilt, true);
  assert.equal((await ensureClient(operations)).rebuilt, false);
  assert.equal(builds, 1);
  assert.deepEqual(record, { fingerprint: "native-a", binary: "binary-a" });
});

it("never records failed builds, missing installations, or native inputs changed during a build", async () => {
  for (const failure of ["build", "missing", "changed"] as const) {
    let built = false;
    let recorded = false;
    await expect(
      ensureClient({
        fingerprint: async () => (built && failure === "changed" ? "native-b" : "native-a"),
        installedBinary: async () => null,
        readRecord: async () => null,
        build: async () => {
          if (failure === "build") throw new Error("Compiler failed");
          built = true;
        },
        saveRecord: async () => {
          recorded = true;
        },
      }),
    ).rejects.toThrow(/Compiler failed|not installed|inputs changed/);
    assert.equal(recorded, false);
  }
});

it("detects native library and resource replacement independent of the install directory", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "native-client-test-"));
  try {
    const first = NodePath.join(root, "first.app");
    const second = NodePath.join(root, "second.app");
    for (const dir of [first, second]) {
      await NodeFSP.mkdir(NodePath.join(dir, "Frameworks"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(dir, "Frameworks/native.dylib"), "native-a");
      await NodeFSP.writeFile(NodePath.join(dir, "Info.plist"), "config-a");
    }
    const baseline = await hashBundle(first);
    assert.equal(await hashBundle(second), baseline);
    await NodeFSP.writeFile(NodePath.join(second, "Frameworks/native.dylib"), "native-b");
    assert.notEqual(await hashBundle(second), baseline);
    await NodeFSP.writeFile(NodePath.join(second, "Frameworks/native.dylib"), "native-a");
    await NodeFSP.writeFile(NodePath.join(second, "Info.plist"), "config-b");
    assert.notEqual(await hashBundle(second), baseline);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("recognizes Android APK installs with randomized tilde paths and rejects failed hash reads", async () => {
  let hashOutput = "a".repeat(64) + "  /data/app/~~random==/com.t3tools.t3code.dev-abc==/base.apk";
  const run = (_program: string, args: string[]) => {
    if (args.includes("list")) return "package:com.t3tools.t3code.dev";
    if (args.includes("path"))
      return "package:/data/app/~~random==/com.t3tools.t3code.dev-abc==/base.apk";
    return hashOutput;
  };
  const binary = await installedBinary("android", "emulator-5554", run);
  assert.match(binary!, /^[a-f0-9]{64}$/);
  hashOutput = "sha256sum: read error";
  await expect(installedBinary("android", "emulator-5554", run)).rejects.toThrow("Could not hash");
  assert.equal(await installedBinary("android", "emulator-5554", () => ""), null);
});
