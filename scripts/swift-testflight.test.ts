// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - This tests the standalone Node release tool with a fake HTTP server.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createTestFlightClient,
  makeAppStoreToken,
  parseTestFlightArgs,
  parseTestFlightEnv,
  readTestFlightEnv,
  validateUploadMetadata,
  withTemporaryPrivateKey,
} from "./swift-testflight.ts";

const keys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const encodedKey = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString(
  "base64",
);
const envSource = `# Synthetic test credentials, never used with Apple.
T3_SWIFT_ASC_KEY_ID="TESTKEY123"
T3_SWIFT_ASC_ISSUER_ID=00000000-0000-0000-0000-000000000001
T3_SWIFT_ASC_PRIVATE_KEY_BASE64="${encodedKey}"
T3_SWIFT_ASC_APP_ID=12345
T3_SWIFT_ASC_PUBLIC_GROUP_ID=public
T3_SWIFT_ASC_INTERNAL_GROUP_ID=internal
`;
const { config } = parseTestFlightEnv(envSource);
const selection = { build: "46", version: "0.1.0" };
const notes = "Fix attachment imports and keep the keyboard open during dictation.";
const linkage = (type: string, id: string) => ({ data: { type, id } });

function mockServer(
  options: {
    bundleId?: string;
    groupAppId?: string;
    buildAppId?: string;
    buildExists?: boolean;
    processingState?: string;
    externalState?: string;
    reviewState?: string;
    assigned?: string[];
    autoNotifyEnabled?: boolean;
    existingNotes?: string | null;
    failAfterGroupAssignment?: boolean;
    approveImmediately?: boolean;
    sparseBetaRelations?: boolean;
  } = {},
) {
  const state = {
    externalState: options.externalState ?? "IN_BETA_TESTING",
    reviewState: options.reviewState,
    assigned: new Set(options.assigned ?? ["internal", "public"]),
    autoNotifyEnabled: options.autoNotifyEnabled ?? true,
    notes: options.existingNotes === undefined ? notes : options.existingNotes,
  };
  const writes: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin !== "https://api.appstoreconnect.apple.com") {
      throw new Error("Unexpected origin");
    }
    const path = url.pathname;
    const detail = {
      type: "buildBetaDetails",
      id: "detail-46",
      attributes: {
        externalBuildState: state.externalState,
        internalBuildState: "IN_BETA_TESTING",
        autoNotifyEnabled: state.autoNotifyEnabled,
      },
    };
    const reviews = state.reviewState
      ? [
          {
            type: "betaAppReviewSubmissions",
            id: "review-46",
            attributes: { betaReviewState: state.reviewState },
          },
        ]
      : [];
    const groupResource = (id: string) => ({
      type: "betaGroups",
      id,
      attributes: {
        name: id,
        isInternalGroup: id === "internal",
        hasAccessToAllBuilds: false,
        publicLinkEnabled: id === "public",
      },
      relationships: { app: linkage("apps", options.groupAppId ?? config.appId) },
    });
    if (method === "GET") {
      if (path === `/v1/apps/${config.appId}`) {
        return Response.json({
          data: {
            type: "apps",
            id: config.appId,
            attributes: {
              name: "T3 Code SwiftUI",
              bundleId: options.bundleId ?? "com.t3tools.t3code.swiftui",
              primaryLocale: "en-US",
            },
          },
        });
      }
      if (path === "/v1/betaGroups/public" || path === "/v1/betaGroups/internal") {
        expect(url.searchParams.get("include")).toBe("app");
        return Response.json({
          data: groupResource(path.endsWith("public") ? "public" : "internal"),
        });
      }
      if (path === "/v1/builds") {
        expect(url.searchParams.get("filter[app]")).toBe(config.appId);
        expect(url.searchParams.get("filter[version]")).toBe("46");
        expect(url.searchParams.get("filter[preReleaseVersion.version]")).toBe("0.1.0");
        const build = {
          type: "builds",
          id: "build-46",
          attributes: {
            version: "46",
            processingState: options.processingState ?? "VALID",
            expired: false,
            buildAudienceType: "APP_STORE_ELIGIBLE",
          },
          relationships: {
            app: url.searchParams.get("include")?.split(",").includes("app")
              ? linkage("apps", options.buildAppId ?? config.appId)
              : { links: { related: "/v1/builds/build-46/app" } },
            preReleaseVersion: linkage("preReleaseVersions", "version-1"),
            buildBetaDetail: options.sparseBetaRelations
              ? {}
              : linkage("buildBetaDetails", "detail-46"),
            betaAppReviewSubmission: options.sparseBetaRelations
              ? {}
              : state.reviewState
                ? linkage("betaAppReviewSubmissions", "review-46")
                : { data: null },
          },
        };
        return Response.json({
          data: options.buildExists === false ? [] : [build],
          included: [
            {
              type: "preReleaseVersions",
              id: "version-1",
              attributes: { version: "0.1.0", platform: "IOS" },
            },
            ...(options.sparseBetaRelations ? [] : [detail, ...reviews]),
          ],
        });
      }
      if (path === "/v1/buildBetaDetails" || path === "/v1/betaAppReviewSubmissions") {
        expect(url.searchParams.get("filter[build]")).toBe("build-46");
        return Response.json({ data: path === "/v1/buildBetaDetails" ? [detail] : reviews });
      }
      if (path === "/v1/betaGroups") {
        expect(url.searchParams.has("filter[app]")).toBe(false);
        expect(url.searchParams.get("filter[builds]")).toBe("build-46");
        return Response.json({ data: [...state.assigned].map(groupResource) });
      }
      if (path === "/v1/builds/build-46/betaBuildLocalizations") {
        return Response.json({
          data:
            state.notes === null
              ? []
              : [
                  {
                    type: "betaBuildLocalizations",
                    id: "notes-46",
                    attributes: { locale: "en-US", whatsNew: state.notes },
                  },
                ],
        });
      }
    } else {
      const body: unknown = JSON.parse(String(init?.body));
      writes.push({ method, path, body });
      if (path === "/v1/betaBuildLocalizations" || path === "/v1/betaBuildLocalizations/notes-46") {
        state.notes = notes;
        return Response.json({ data: { type: "betaBuildLocalizations", id: "notes-46" } });
      }
      if (path === "/v1/buildBetaDetails/detail-46") {
        state.autoNotifyEnabled = true;
        return Response.json({ data: { type: "buildBetaDetails", id: "detail-46" } });
      }
      if (
        path === "/v1/betaGroups/public/relationships/builds" ||
        path === "/v1/betaGroups/internal/relationships/builds"
      ) {
        state.assigned.add(path.includes("/public/") ? "public" : "internal");
        if (options.failAfterGroupAssignment) throw new Error("Lost response after write");
        return new Response(null, { status: 204 });
      }
      if (path === "/v1/betaAppReviewSubmissions") {
        state.externalState = options.approveImmediately
          ? "BETA_APPROVED"
          : "WAITING_FOR_BETA_REVIEW";
        state.reviewState = options.approveImmediately ? "APPROVED" : "WAITING_FOR_REVIEW";
        return Response.json(
          { data: { type: "betaAppReviewSubmissions", id: "review-46" } },
          { status: 201 },
        );
      }
      if (path === "/v1/buildBetaNotifications") {
        state.externalState = "IN_BETA_TESTING";
        return Response.json(
          { data: { type: "buildBetaNotifications", id: "notification-46" } },
          { status: 201 },
        );
      }
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  return {
    client: createTestFlightClient(config, keys.privateKey, fetchMock),
    fetchMock,
    state,
    writes,
  };
}

describe("App Store Connect authentication", () => {
  it("does not print a token echoed in an API error", async () => {
    let capturedToken = "";
    const client = createTestFlightClient(config, keys.privateKey, async (_input, init) => {
      capturedToken = new Headers(init?.headers).get("Authorization")?.slice(7) ?? "";
      return Response.json({ errors: [{ detail: `Rejected ${capturedToken}` }] }, { status: 401 });
    });
    await expect(client.status(selection)).rejects.toThrow("Rejected [redacted token]");
    expect(capturedToken).not.toBe("");
  });

  it("parses a quoted env file and restores the downloaded PEM key", () => {
    const parsed = parseTestFlightEnv(envSource);
    expect(parsed.config).toEqual({
      keyId: "TESTKEY123",
      issuerId: "00000000-0000-0000-0000-000000000001",
      appId: "12345",
      publicGroupId: "public",
      internalGroupId: "internal",
    });
    expect(
      NodeCrypto.createPublicKey(parsed.privateKey).export({ type: "spki", format: "pem" }),
    ).toBe(keys.publicKey.export({ type: "spki", format: "pem" }));
  });

  it("does not export parsed env variables to the process", () => {
    const before = process.env.T3_SWIFT_ENV_PARSE_TEST_SENTINEL;
    parseTestFlightEnv(`${envSource}T3_SWIFT_ENV_PARSE_TEST_SENTINEL="local only"\n`);
    expect(process.env.T3_SWIFT_ENV_PARSE_TEST_SENTINEL).toBe(before);
  });

  it("requires private permissions on the env file", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-swift-env-test-"));
    const path = NodePath.join(directory, ".env.testflight.local");
    try {
      await NodeFSP.writeFile(path, envSource, { mode: 0o600 });
      expect((await readTestFlightEnv(path)).config).toEqual(config);
      await NodeFSP.chmod(path, 0o644);
      await expect(readTestFlightEnv(path)).rejects.toThrow("mode 600");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "removes the temporary Xcode key after success or failure: %s",
    async (fail) => {
      let temporaryPath: string | undefined;
      const operation = withTemporaryPrivateKey(keys.privateKey, async (path) => {
        temporaryPath = path;
        expect((await NodeFSP.stat(path)).mode & 0o777).toBe(0o600);
        expect((await NodeFSP.stat(NodePath.dirname(path))).mode & 0o777).toBe(0o700);
        const savedKey = NodeCrypto.createPrivateKey(await NodeFSP.readFile(path));
        expect(NodeCrypto.createPublicKey(savedKey).export({ type: "spki", format: "pem" })).toBe(
          keys.publicKey.export({ type: "spki", format: "pem" }),
        );
        if (fail) throw new Error("Upload failed");
      });
      if (fail) await expect(operation).rejects.toThrow("Upload failed");
      else await operation;
      if (!temporaryPath) throw new Error("The upload callback did not run");
      await expect(NodeFSP.stat(NodePath.dirname(temporaryPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("signs a ten-minute ES256 token with the API audience and P1363 signature", () => {
    const token = makeAppStoreToken(config, keys.privateKey, 1_000);
    const [header, payload, signature] = token.split(".");
    if (!header || !payload || !signature) throw new Error("Invalid token");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: config.keyId,
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({
      iss: config.issuerId,
      iat: 1_000,
      exp: 1_600,
      aud: "appstoreconnect-v1",
    });
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        {
          key: keys.publicKey,
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("rejects a key that cannot sign ES256", () => {
    const wrongKey = NodeCrypto.generateKeyPairSync("ed25519");
    expect(() => makeAppStoreToken(config, wrongKey.privateKey)).toThrow("P-256 private key");
  });
});

describe("SwiftUI TestFlight publication", () => {
  it.each([
    { bundleId: "com.t3tools.t3code.swiftui.dev" },
    { groupAppId: "other-app" },
    { buildAppId: "other-app" },
  ])("refuses wrong-app targets before any write: %j", async (options) => {
    const server = mockServer(options);
    await expect(server.client.publish(selection, notes)).rejects.toThrow(
      /Refusing|different app/u,
    );
    expect(server.writes).toEqual([]);
  });

  it("does not duplicate group assignment, review, or notifications for a testing build", async () => {
    const server = mockServer();
    const result = await server.client.publish(selection, notes);
    expect(result.publicTesting).toBe(true);
    expect(server.writes).toEqual([]);
  });

  it("sets notes, assigns both groups, and submits once without claiming review is complete", async () => {
    const server = mockServer({
      externalState: "READY_FOR_BETA_SUBMISSION",
      assigned: [],
      autoNotifyEnabled: false,
      existingNotes: null,
    });
    const result = await server.client.publish(selection, notes);
    expect(result.publicTesting).toBe(false);
    expect(result.externalState).toBe("WAITING_FOR_BETA_REVIEW");
    expect(server.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/betaBuildLocalizations",
      "PATCH /v1/buildBetaDetails/detail-46",
      "POST /v1/betaGroups/internal/relationships/builds",
      "POST /v1/betaGroups/public/relationships/builds",
      "POST /v1/betaAppReviewSubmissions",
    ]);
    expect(server.writes.at(-1)?.body).toEqual({
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: linkage("builds", "build-46") },
      },
    });
    await server.client.publish(selection, notes);
    expect(server.writes).toHaveLength(5);
  });

  it("notifies an approved build once and rereads the resulting testing state", async () => {
    const server = mockServer({ externalState: "BETA_APPROVED", reviewState: "APPROVED" });
    const result = await server.client.publish(selection, notes);
    expect(result.publicTesting).toBe(true);
    expect(server.writes.map((item) => item.path)).toEqual(["/v1/buildBetaNotifications"]);
    await server.client.publish(selection, notes);
    expect(server.writes).toHaveLength(1);
  });

  it("leaves automatic notification alone when a new review immediately becomes approved", async () => {
    const server = mockServer({
      externalState: "READY_FOR_BETA_SUBMISSION",
      approveImmediately: true,
    });
    const result = await server.client.publish(selection, notes);
    expect(result.externalState).toBe("BETA_APPROVED");
    expect(result.publicTesting).toBe(false);
    expect(server.writes.map((item) => item.path)).toEqual(["/v1/betaAppReviewSubmissions"]);
  });

  it("checks missing review linkage before deciding whether a submission exists", async () => {
    const server = mockServer({
      externalState: "READY_FOR_BETA_SUBMISSION",
      reviewState: "WAITING_FOR_REVIEW",
      sparseBetaRelations: true,
    });
    const result = await server.client.publish(selection, notes);
    expect(result.reviewState).toBe("WAITING_FOR_REVIEW");
    expect(server.writes).toEqual([]);
  });

  it.each([
    { processingState: "PROCESSING" },
    { externalState: "MISSING_EXPORT_COMPLIANCE" },
    { externalState: "BETA_REJECTED", reviewState: "REJECTED" },
    { buildExists: false },
  ])("fails before writes for a build that is not ready: %j", async (options) => {
    const server = mockServer(options);
    await expect(server.client.publish(selection, notes)).rejects.toThrow();
    expect(server.writes).toEqual([]);
  });

  it("does not retry a write when the response is lost", async () => {
    const server = mockServer({ assigned: ["public"], failAfterGroupAssignment: true });
    await expect(server.client.publish(selection, notes)).rejects.toThrow(
      "The write was not retried",
    );
    expect(server.writes).toHaveLength(1);
    expect(server.state.assigned.has("internal")).toBe(true);
    await server.client.publish(selection, notes);
    expect(server.writes).toHaveLength(1);
  });

  it("refuses another upload of a build that Apple already has", async () => {
    const server = mockServer();
    await expect(server.client.verifyUpload(selection)).rejects.toThrow("already exists");
    expect(server.writes).toEqual([]);
  });

  it("verifies app and groups before allowing a new upload", async () => {
    const server = mockServer({ buildExists: false });
    await expect(server.client.verifyUpload(selection)).resolves.toBeUndefined();
    expect(server.writes).toEqual([]);
  });
});

describe("release command input", () => {
  const info = {
    CFBundleIdentifier: "com.t3tools.t3code.swiftui",
    DTPlatformName: "iphoneos",
    CFBundleVersion: "46",
    CFBundleShortVersionString: "0.1.0",
  };
  const exportOptions = {
    method: "app-store-connect",
    destination: "upload",
    manageAppVersionAndBuildNumber: false,
  };

  it("reads an exact Release build from archive metadata", () => {
    expect(validateUploadMetadata(info, exportOptions)).toEqual(selection);
  });

  it.each([
    { ...info, CFBundleIdentifier: "com.t3tools.t3code.swiftui.dev" },
    { ...info, DTPlatformName: "iphonesimulator" },
  ])("rejects a dev or simulator archive", (metadata) => {
    expect(() => validateUploadMetadata(metadata, exportOptions)).toThrow("Release SwiftUI app");
  });

  it.each([
    { ...exportOptions, destination: "export" },
    { ...exportOptions, manageAppVersionAndBuildNumber: true },
    { ...exportOptions, testFlightInternalTestingOnly: true },
  ])("rejects export options that would change or restrict the release", (options) => {
    expect(() => validateUploadMetadata(info, options)).toThrow();
  });

  it("requires explicit release notes for publication", () => {
    expect(() => parseTestFlightArgs(["publish", "--build", "46", "--version", "0.1.0"])).toThrow(
      "--notes-file",
    );
    expect(
      parseTestFlightArgs([
        "status",
        "--build",
        "46",
        "--version",
        "0.1.0",
        "--env-file",
        "/tmp/.env.testflight.local",
      ]),
    ).toMatchObject({ command: "status", ...selection, envFile: "/tmp/.env.testflight.local" });
  });

  it("requires supplied export options and reads upload versions only from the archive", () => {
    expect(
      parseTestFlightArgs([
        "upload",
        "--archive",
        "/tmp/Test.xcarchive",
        "--export-options",
        "/tmp/ExportOptions.plist",
      ]),
    ).toMatchObject({
      command: "upload",
      archive: "/tmp/Test.xcarchive",
      exportOptions: "/tmp/ExportOptions.plist",
    });
    expect(() =>
      parseTestFlightArgs([
        "upload",
        "--archive",
        "/tmp/Test.xcarchive",
        "--export-options",
        "/tmp/ExportOptions.plist",
        "--build",
        "47",
      ]),
    ).toThrow("reads the build and version from the archive");
  });
});
