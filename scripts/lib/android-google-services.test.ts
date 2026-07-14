// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the credentials file resolution directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  ANDROID_GOOGLE_SERVICES_ENV_VAR,
  resolveAndroidGoogleServicesFile,
} from "./android-google-services.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const PREVIEW_PACKAGE = "com.t3tools.t3code.preview";

function makeTemporaryDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-google-services-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeGoogleServicesFile(
  directory: string,
  packageNames: ReadonlyArray<string>,
  fileName = "google-services.json",
): string {
  const filePath = NodePath.join(directory, fileName);
  NodeFS.writeFileSync(
    filePath,
    JSON.stringify({
      project_info: { project_id: "t3-code-test" },
      client: packageNames.map((packageName) => ({
        client_info: {
          mobilesdk_app_id: "1:1234567890:android:abcdef",
          android_client_info: { package_name: packageName },
        },
      })),
    }),
  );
  return filePath;
}

describe("resolveAndroidGoogleServicesFile", () => {
  it("returns undefined when the variable is unset outside an EAS Android build", () => {
    expect(
      resolveAndroidGoogleServicesFile({
        env: {},
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot: makeTemporaryDirectory(),
      }),
    ).toBeUndefined();
  });

  it("returns undefined for empty and whitespace-only values", () => {
    for (const value of ["", "   "]) {
      expect(
        resolveAndroidGoogleServicesFile({
          env: { [ANDROID_GOOGLE_SERVICES_ENV_VAR]: value },
          appVariant: "preview",
          androidPackage: PREVIEW_PACKAGE,
          appRoot: makeTemporaryDirectory(),
        }),
      ).toBeUndefined();
    }
  });

  it("resolves an absolute path that registers the requested package", () => {
    const directory = makeTemporaryDirectory();
    const filePath = writeGoogleServicesFile(directory, ["com.t3tools.t3code", PREVIEW_PACKAGE]);

    expect(
      resolveAndroidGoogleServicesFile({
        env: { [ANDROID_GOOGLE_SERVICES_ENV_VAR]: filePath },
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot: makeTemporaryDirectory(),
      }),
    ).toBe(filePath);
  });

  it("resolves a relative path against the app root", () => {
    const appRoot = makeTemporaryDirectory();
    const filePath = writeGoogleServicesFile(appRoot, [PREVIEW_PACKAGE]);

    expect(
      resolveAndroidGoogleServicesFile({
        env: { [ANDROID_GOOGLE_SERVICES_ENV_VAR]: "./google-services.json" },
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot,
      }),
    ).toBe(filePath);
  });

  it("fails an Android EAS preview build when the variable is unset", () => {
    expect(() =>
      resolveAndroidGoogleServicesFile({
        env: { EAS_BUILD: "true", EAS_BUILD_PLATFORM: "android" },
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot: makeTemporaryDirectory(),
      }),
    ).toThrow(ANDROID_GOOGLE_SERVICES_ENV_VAR);
  });

  it("does not fail an iOS EAS preview build when the variable is unset", () => {
    expect(
      resolveAndroidGoogleServicesFile({
        env: { EAS_BUILD: "true", EAS_BUILD_PLATFORM: "ios" },
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot: makeTemporaryDirectory(),
      }),
    ).toBeUndefined();
  });

  it("does not fail an Android EAS development build when the variable is unset", () => {
    expect(
      resolveAndroidGoogleServicesFile({
        env: { EAS_BUILD: "true", EAS_BUILD_PLATFORM: "android" },
        appVariant: "development",
        androidPackage: "com.t3tools.t3code.dev",
        appRoot: makeTemporaryDirectory(),
      }),
    ).toBeUndefined();
  });

  it("rejects a path that does not exist", () => {
    const appRoot = makeTemporaryDirectory();

    expect(() =>
      resolveAndroidGoogleServicesFile({
        env: {
          [ANDROID_GOOGLE_SERVICES_ENV_VAR]: NodePath.join(appRoot, "missing.json"),
        },
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot,
      }),
    ).toThrow("no file exists");
  });

  it("rejects a file that is not valid JSON", () => {
    const appRoot = makeTemporaryDirectory();
    const filePath = NodePath.join(appRoot, "google-services.json");
    NodeFS.writeFileSync(filePath, "not json");

    expect(() =>
      resolveAndroidGoogleServicesFile({
        env: { [ANDROID_GOOGLE_SERVICES_ENV_VAR]: filePath },
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot,
      }),
    ).toThrow("not valid JSON");
  });

  it("rejects a file that does not register the requested package", () => {
    const appRoot = makeTemporaryDirectory();
    const filePath = writeGoogleServicesFile(appRoot, ["com.t3tools.t3code"]);

    expect(() =>
      resolveAndroidGoogleServicesFile({
        env: { [ANDROID_GOOGLE_SERVICES_ENV_VAR]: filePath },
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot,
      }),
    ).toThrow(`does not register the Android package '${PREVIEW_PACKAGE}'`);
  });

  it("rejects a file with no Android clients and names what it found", () => {
    const appRoot = makeTemporaryDirectory();
    const filePath = NodePath.join(appRoot, "google-services.json");
    NodeFS.writeFileSync(filePath, JSON.stringify({ project_info: {} }));

    expect(() =>
      resolveAndroidGoogleServicesFile({
        env: { [ANDROID_GOOGLE_SERVICES_ENV_VAR]: filePath },
        appVariant: "preview",
        androidPackage: PREVIEW_PACKAGE,
        appRoot,
      }),
    ).toThrow("registered packages: none");
  });
});
