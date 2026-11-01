// @effect-diagnostics nodeBuiltinImport:off

import { it } from "@effect/vitest";
import * as NodeTls from "node:tls";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import {
  makeApplyDesktopShellEnvironmentSnapshot,
  requireDesktopTelemetryWriteProgress,
} from "./DesktopTelemetryReceiver.ts";

describe("DesktopTelemetryReceiver", () => {
  it.effect("updates live TLS trust when shell certificates arrive after startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const certificatePath = path.join(directory, "extra-ca.pem");
      const original = NodeTls.getCACertificates("default");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeTls.setDefaultCACertificates(original)),
      );
      const baseline = NodeTls.rootCertificates[0]!;
      const extra = NodeTls.rootCertificates[1]!;
      const replacement = NodeTls.rootCertificates[2]!;
      NodeTls.setDefaultCACertificates([baseline]);
      yield* fs.writeFileString(certificatePath, `${extra}\n${replacement}`);
      const environment: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const applySnapshot = makeApplyDesktopShellEnvironmentSnapshot(environment, "darwin");
      const message = {
        version: 1,
        type: "shellEnvironment",
        platform: "darwin",
        discovered: true,
        environment: { NODE_EXTRA_CA_CERTS: certificatePath },
      } as const;
      const fingerprints = (certificates: ReadonlyArray<string>) =>
        certificates.map((pem) => new NodeCrypto.X509Certificate(pem).fingerprint256).sort();
      yield* applySnapshot({ ...message, platform: "win32" });
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(fingerprints([baseline]));
      expect(environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING).toBe("1");
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, extra, replacement]),
      );
      expect(environment.NODE_EXTRA_CA_CERTS).toBe(certificatePath);
      expect(environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING).toBeUndefined();

      yield* fs.writeFileString(certificatePath, replacement);
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );

      yield* fs.writeFileString(
        certificatePath,
        "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
      );
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );
      yield* fs.remove(certificatePath);
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );

      yield* applySnapshot({ ...message, environment: { NODE_EXTRA_CA_CERTS: null } });
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(fingerprints([baseline]));
      expect(environment.NODE_EXTRA_CA_CERTS).toBeUndefined();

      NodeTls.setDefaultCACertificates([]);
      yield* fs.writeFileString(certificatePath, extra);
      const applyOpaqueTrust = makeApplyDesktopShellEnvironmentSnapshot(environment, "darwin");
      yield* applyOpaqueTrust(message);
      expect(NodeTls.getCACertificates("default")).toEqual([]);
      expect(environment.NODE_EXTRA_CA_CERTS).toBe(certificatePath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { platform: "darwin", discovered: true, applied: true, pending: false },
    { platform: "win32", discovered: true, applied: false, pending: true },
    { platform: "darwin", discovered: false, applied: true, pending: true },
  ])(
    "applies platform=$platform discovered=$discovered with pending=$pending",
    ({ platform, discovered, applied, pending }) =>
      Effect.gen(function* () {
        const environment: NodeJS.ProcessEnv = {
          PATH: "/old/bin",
          JAVA_HOME: "/old/java",
          UNRELATED: "keep",
          T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
        };
        yield* makeApplyDesktopShellEnvironmentSnapshot(
          environment,
          "darwin",
        )({
          version: 1,
          type: "shellEnvironment",
          platform,
          discovered,
          environment: { PATH: "/fresh/bin", JAVA_HOME: null },
        });
        expect(environment).toEqual({
          PATH: applied ? "/fresh/bin" : "/old/bin",
          ...(applied ? {} : { JAVA_HOME: "/old/java" }),
          UNRELATED: "keep",
          ...(pending ? { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" } : {}),
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});
