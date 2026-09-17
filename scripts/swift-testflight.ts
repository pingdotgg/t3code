#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off preferSchemaOverJson:off - This standalone release tool uses Node APIs and validates JSON at the API boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const BUNDLE_ID = "com.t3tools.t3code.swiftui";
const TOKEN_SECONDS = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`Expected an object for ${label}.`);
  return value;
}

function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected a nonempty string for ${label}.`);
  }
  return value;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`Expected a boolean for ${label}.`);
  return value;
}

function items(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected a list for ${label}.`);
  return value;
}

function resource(value: unknown, type: string) {
  const data = record(value, type);
  if (data.type !== type) throw new Error(`Expected an App Store Connect ${type} resource.`);
  return {
    id: text(data.id, `${type}.id`),
    attributes: record(data.attributes ?? {}, `${type}.attributes`),
    relationships: record(data.relationships ?? {}, `${type}.relationships`),
  };
}

type Resource = ReturnType<typeof resource>;

function relationship(value: Resource, name: string, type: string) {
  const relation = record(value.relationships[name], `${name} relationship`);
  return relation.data === null ? undefined : resource(relation.data, type).id;
}

export function parseTestFlightEnv(source: string) {
  const env = NodeUtil.parseEnv(source);
  const config = {
    keyId: text(env.T3_SWIFT_ASC_KEY_ID, "T3_SWIFT_ASC_KEY_ID"),
    issuerId: text(env.T3_SWIFT_ASC_ISSUER_ID, "T3_SWIFT_ASC_ISSUER_ID"),
    appId: text(env.T3_SWIFT_ASC_APP_ID, "T3_SWIFT_ASC_APP_ID"),
    publicGroupId: text(env.T3_SWIFT_ASC_PUBLIC_GROUP_ID, "T3_SWIFT_ASC_PUBLIC_GROUP_ID"),
    internalGroupId: text(env.T3_SWIFT_ASC_INTERNAL_GROUP_ID, "T3_SWIFT_ASC_INTERNAL_GROUP_ID"),
  };
  if (config.publicGroupId === config.internalGroupId) {
    throw new Error("Public and internal groups must be different.");
  }
  const encodedKey = text(env.T3_SWIFT_ASC_PRIVATE_KEY_BASE64, "T3_SWIFT_ASC_PRIVATE_KEY_BASE64");
  let privateKey: NodeCrypto.KeyObject;
  try {
    const decoded = Buffer.from(encodedKey, "base64");
    if (decoded.toString("base64") !== encodedKey) throw new Error("invalid base64");
    privateKey = NodeCrypto.createPrivateKey(decoded);
  } catch {
    throw new Error("T3_SWIFT_ASC_PRIVATE_KEY_BASE64 must contain the base64-encoded .p8 file.");
  }
  requireAppStorePrivateKey(privateKey);
  return { config, privateKey };
}

type TestFlightConfig = ReturnType<typeof parseTestFlightEnv>["config"];
type BuildSelection = { build: string; version: string };

export async function readTestFlightEnv(path: string) {
  let file: NodeFSP.FileHandle | undefined;
  let source: string;
  try {
    file = await NodeFSP.open(expandHome(path), "r");
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("unsafe permissions");
    }
    source = await file.readFile("utf8");
  } catch {
    throw new Error(
      `Cannot read TestFlight env file at ${path}. Use a private file with mode 600.`,
    );
  } finally {
    await file?.close();
  }
  return parseTestFlightEnv(source);
}

function validateBuildSelection(selection: BuildSelection) {
  if (
    !/^\d+(?:\.\d+){0,2}$/u.test(selection.build) ||
    !/^\d+\.\d+(?:\.\d+)?$/u.test(selection.version)
  ) {
    throw new Error("Use an exact numeric build number and version.");
  }
  return selection;
}

function requireAppStorePrivateKey(privateKey: NodeCrypto.KeyObject) {
  if (
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("App Store Connect requires a P-256 private key.");
  }
}

export function makeAppStoreToken(
  config: Pick<TestFlightConfig, "keyId" | "issuerId">,
  privateKey: NodeCrypto.KeyObject,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  requireAppStorePrivateKey(privateKey);
  const header = Buffer.from(
    JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: config.issuerId,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_SECONDS,
      aud: "appstoreconnect-v1",
    }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

// All writes use the app and groups verified by status(). No credentials go into command output.
export function createTestFlightClient(
  config: TestFlightConfig,
  privateKey: NodeCrypto.KeyObject,
  fetchImpl: typeof fetch = fetch,
) {
  async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith("/v1/")) {
      throw new Error("Refusing an App Store Connect request to an unexpected URL.");
    }
    const operation = `${method} ${url.pathname}`;
    const uncertainWrite =
      method === "GET" ? "" : " The write was not retried. Run status before trying again.";
    const token = makeAppStoreToken(config, privateKey);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`App Store Connect ${operation} failed or timed out.${uncertainWrite}`);
    }
    if (response.status === 204 && response.ok) return undefined;
    const result: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const details =
        isRecord(result) && Array.isArray(result.errors)
          ? result.errors
              .filter(isRecord)
              .map((error) =>
                [error.code, error.title, error.detail]
                  .filter((part): part is string => typeof part === "string")
                  .join(": "),
              )
              .join("; ")
              .replaceAll(token, "[redacted token]")
          : "";
      throw new Error(
        `App Store Connect ${operation}: HTTP ${response.status}${details ? ` (${details.slice(0, 1_000)})` : ""}.${uncertainWrite}`,
      );
    }
    return result;
  }

  async function getResource(path: string, type: string) {
    const response = record(await request(path), type);
    return resource(response.data, type);
  }

  async function list(path: string, type: string) {
    const result: Resource[] = [];
    const visited = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      if (visited.has(next)) throw new Error("App Store Connect repeated a page URL.");
      visited.add(next);
      const response = record(await request(next), `${type} response`);
      result.push(...items(response.data, type).map((item) => resource(item, type)));
      const links = record(response.links ?? {}, `${type} links`);
      next =
        links.next === undefined || links.next === null ? undefined : text(links.next, "next page");
    }
    return result;
  }

  async function group(id: string, internal: boolean) {
    const value = await getResource(
      `/v1/betaGroups/${encodeURIComponent(id)}?include=app`,
      "betaGroups",
    );
    if (value.id !== id || relationship(value, "app", "apps") !== config.appId) {
      throw new Error("Refusing a beta group that does not belong to the configured SwiftUI app.");
    }
    if (boolean(value.attributes.isInternalGroup, "isInternalGroup") !== internal) {
      throw new Error("The configured beta group has the wrong internal/external type.");
    }
    return {
      id,
      name: text(value.attributes.name, "group name"),
      internal,
      allBuilds: value.attributes.hasAccessToAllBuilds === true,
      publicLinkEnabled: value.attributes.publicLinkEnabled === true,
    };
  }

  async function verifyApp() {
    const app = await getResource(`/v1/apps/${encodeURIComponent(config.appId)}`, "apps");
    if (app.id !== config.appId || app.attributes.bundleId !== BUNDLE_ID) {
      throw new Error(`Refusing to use an app other than ${BUNDLE_ID}. Check appId.`);
    }
    return app;
  }

  function buildQuery(selection: BuildSelection) {
    validateBuildSelection(selection);
    return new URLSearchParams({
      "filter[app]": config.appId,
      "filter[version]": selection.build,
      "filter[preReleaseVersion.version]": selection.version,
      "filter[preReleaseVersion.platform]": "IOS",
      limit: "2",
    });
  }

  async function verifyUpload(selection: BuildSelection) {
    await Promise.all([
      verifyApp(),
      group(config.internalGroupId, true),
      group(config.publicGroupId, false),
    ]);
    const existing = await list(`/v1/builds?${buildQuery(selection)}`, "builds");
    if (existing.length > 0) {
      throw new Error(
        `Build ${selection.version} (${selection.build}) already exists. Run status; refusing another upload.`,
      );
    }
  }

  async function status(selection: BuildSelection) {
    const [app, internalGroup, publicGroup] = await Promise.all([
      verifyApp(),
      group(config.internalGroupId, true),
      group(config.publicGroupId, false),
    ]);
    const query = buildQuery(selection);
    query.set("include", "app,preReleaseVersion,buildBetaDetail,betaAppReviewSubmission");
    const response = record(await request(`/v1/builds?${query}`), "builds response");
    const builds = items(response.data, "builds");
    if (builds.length !== 1) {
      throw new Error(
        `Expected one SwiftUI build ${selection.version} (${selection.build}); found ${builds.length}.`,
      );
    }
    const build = resource(builds[0], "builds");
    if (
      relationship(build, "app", "apps") !== app.id ||
      build.attributes.version !== selection.build
    ) {
      throw new Error("App Store Connect returned a different app or build. Nothing was changed.");
    }
    const included = items(response.included ?? [], "included resources").map((value) =>
      record(value, "included resource"),
    );
    function includedResource(name: string, type: string) {
      const id = relationship(build, name, type);
      if (!id) return undefined;
      const value = included.find((item) => item.type === type && item.id === id);
      if (!value) throw new Error(`App Store Connect omitted the build's ${name}.`);
      return resource(value, type);
    }
    const version = includedResource("preReleaseVersion", "preReleaseVersions");
    if (
      version?.attributes.version !== selection.version ||
      version.attributes.platform !== "IOS"
    ) {
      throw new Error(
        "App Store Connect returned a different version or platform. Nothing was changed.",
      );
    }
    async function optionalBuildResource(name: string, type: string) {
      const relation = build.relationships[name];
      if (isRecord(relation) && relation.data !== undefined) return includedResource(name, type);
      // A missing linkage is not proof that no review exists. Read the filtered collection.
      const query = new URLSearchParams({ "filter[build]": build.id, limit: "2" });
      const values = await list(`/v1/${type}?${query}`, type);
      if (values.length > 1)
        throw new Error(`App Store Connect returned multiple ${name} resources.`);
      return values[0];
    }
    const [detail, review] = await Promise.all([
      optionalBuildResource("buildBetaDetail", "buildBetaDetails"),
      optionalBuildResource("betaAppReviewSubmission", "betaAppReviewSubmissions"),
    ]);
    // Apple accepts one relationship filter. The build's app was checked above.
    const membershipQuery = new URLSearchParams({
      "filter[builds]": build.id,
      limit: "200",
    });
    const memberships = await list(`/v1/betaGroups?${membershipQuery}`, "betaGroups");
    const groups = [internalGroup, publicGroup].map((item) => ({
      ...item,
      assigned:
        memberships.some((member) => member.id === item.id) || (item.internal && item.allBuilds),
    }));
    const externalState = detail
      ? text(detail.attributes.externalBuildState, "externalBuildState")
      : undefined;
    return {
      appId: app.id,
      appName: text(app.attributes.name, "app name"),
      bundleId: BUNDLE_ID,
      primaryLocale: text(app.attributes.primaryLocale, "primaryLocale"),
      buildId: build.id,
      ...selection,
      processingState: text(build.attributes.processingState, "processingState"),
      expired: boolean(build.attributes.expired, "expired"),
      audience: text(build.attributes.buildAudienceType, "buildAudienceType"),
      detailId: detail?.id,
      externalState,
      internalState: detail
        ? text(detail.attributes.internalBuildState, "internalBuildState")
        : undefined,
      autoNotifyEnabled: detail
        ? boolean(detail.attributes.autoNotifyEnabled, "autoNotifyEnabled")
        : false,
      reviewState: review ? text(review.attributes.betaReviewState, "betaReviewState") : undefined,
      groups,
      publicTesting:
        externalState === "IN_BETA_TESTING" &&
        groups.some((item) => !item.internal && item.assigned && item.publicLinkEnabled),
    };
  }

  function requirePublishable(current: Awaited<ReturnType<typeof status>>) {
    if (current.expired) throw new Error("This build has expired. Upload a new build.");
    if (current.processingState !== "VALID") {
      throw new Error(`Build processing is ${current.processingState}. Nothing was published.`);
    }
    if (current.audience !== "APP_STORE_ELIGIBLE") {
      throw new Error("This build is internal-only and cannot be released to the public beta.");
    }
    if (!current.groups.some((item) => !item.internal && item.publicLinkEnabled)) {
      throw new Error("The configured public beta group does not have an enabled public link.");
    }
    const allowed = [
      "READY_FOR_BETA_SUBMISSION",
      "WAITING_FOR_BETA_REVIEW",
      "IN_BETA_REVIEW",
      "BETA_APPROVED",
      "READY_FOR_BETA_TESTING",
      "IN_BETA_TESTING",
    ];
    if (
      !current.externalState ||
      !allowed.includes(current.externalState) ||
      current.reviewState === "REJECTED"
    ) {
      throw new Error(
        `Build is not ready for publication: ${current.externalState ?? "no beta details"}${current.reviewState ? ` (${current.reviewState})` : ""}.`,
      );
    }
    return text(current.detailId, "build beta detail ID");
  }

  async function publish(selection: BuildSelection, notes: string) {
    const whatsNew = notes.trim();
    if (!whatsNew || whatsNew.length > 4_000) {
      throw new Error("TestFlight notes must contain between 1 and 4,000 characters.");
    }
    let current = await status(selection);
    const detailId = requirePublishable(current);
    const localizations = await list(
      `/v1/builds/${encodeURIComponent(current.buildId)}/betaBuildLocalizations?limit=200`,
      "betaBuildLocalizations",
    );
    const localization = localizations.find(
      (item) => item.attributes.locale === current.primaryLocale,
    );
    if (localization && localization.attributes.whatsNew !== whatsNew) {
      await request(`/v1/betaBuildLocalizations/${encodeURIComponent(localization.id)}`, "PATCH", {
        data: { type: "betaBuildLocalizations", id: localization.id, attributes: { whatsNew } },
      });
    } else if (!localization) {
      await request("/v1/betaBuildLocalizations", "POST", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale: current.primaryLocale, whatsNew },
          relationships: { build: { data: { type: "builds", id: current.buildId } } },
        },
      });
    }
    if (!current.autoNotifyEnabled) {
      await request(`/v1/buildBetaDetails/${encodeURIComponent(detailId)}`, "PATCH", {
        data: { type: "buildBetaDetails", id: detailId, attributes: { autoNotifyEnabled: true } },
      });
    }
    for (const id of [config.internalGroupId, config.publicGroupId]) {
      current = await status(selection);
      requirePublishable(current);
      if (current.groups.some((item) => item.id === id && item.assigned)) continue;
      await request(`/v1/betaGroups/${encodeURIComponent(id)}/relationships/builds`, "POST", {
        data: [{ type: "builds", id: current.buildId }],
      });
    }
    current = await status(selection);
    requirePublishable(current);
    if (current.externalState === "READY_FOR_BETA_SUBMISSION" && !current.reviewState) {
      await request("/v1/betaAppReviewSubmissions", "POST", {
        data: {
          type: "betaAppReviewSubmissions",
          relationships: { build: { data: { type: "builds", id: current.buildId } } },
        },
      });
    } else if (
      current.externalState === "READY_FOR_BETA_TESTING" ||
      current.externalState === "BETA_APPROVED"
    ) {
      await request("/v1/buildBetaNotifications", "POST", {
        data: {
          type: "buildBetaNotifications",
          relationships: { build: { data: { type: "builds", id: current.buildId } } },
        },
      });
    }
    return status(selection);
  }

  return { status, publish, verifyUpload };
}

export function validateUploadMetadata(infoPlist: unknown, exportOptions: unknown) {
  const info = record(infoPlist, "archived app Info.plist");
  if (info.CFBundleIdentifier !== BUNDLE_ID || info.DTPlatformName !== "iphoneos") {
    throw new Error("Upload requires an iPhoneOS archive of the Release SwiftUI app.");
  }
  const options = record(exportOptions, "export options");
  if (options.method !== "app-store-connect" || options.destination !== "upload") {
    throw new Error("Export options must use method app-store-connect and destination upload.");
  }
  if (options.manageAppVersionAndBuildNumber !== false) {
    throw new Error("Export options must set manageAppVersionAndBuildNumber to false.");
  }
  if (options.testFlightInternalTestingOnly === true) {
    throw new Error("Refusing an internal-only export for the public TestFlight app.");
  }
  return validateBuildSelection({
    build: text(info.CFBundleVersion, "CFBundleVersion"),
    version: text(info.CFBundleShortVersionString, "CFBundleShortVersionString"),
  });
}

async function readPlist(path: string): Promise<unknown> {
  const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
  try {
    const { stdout } = await execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1_024 * 1_024,
    });
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Cannot read plist at ${path}.`);
  }
}

async function uploadArchive(
  archive: string,
  exportOptions: string,
  config: TestFlightConfig,
  privateKey: NodeCrypto.KeyObject,
  verifyUpload: (selection: BuildSelection) => Promise<void>,
) {
  const archivePath = NodePath.resolve(expandHome(archive));
  const optionsPath = NodePath.resolve(expandHome(exportOptions));
  const [info, options] = await Promise.all([
    readPlist(NodePath.join(archivePath, "Products/Applications/T3Code.app/Info.plist")),
    readPlist(optionsPath),
  ]);
  const selection = validateUploadMetadata(info, options);
  await verifyUpload(selection);
  await withTemporaryPrivateKey(
    privateKey,
    (keyPath) =>
      new Promise<void>((resolve, reject) => {
        const child = NodeChildProcess.spawn(
          "xcodebuild",
          [
            "-exportArchive",
            "-archivePath",
            archivePath,
            "-exportOptionsPlist",
            optionsPath,
            "-authenticationKeyPath",
            keyPath,
            "-authenticationKeyID",
            config.keyId,
            "-authenticationKeyIssuerID",
            config.issuerId,
          ],
          { stdio: "inherit" },
        );
        child.once("error", () => reject(new Error("Could not start xcodebuild.")));
        child.once("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error("Xcode upload failed. Check status before trying another upload.")),
        );
      }),
  );
  process.stdout.write(
    `Xcode uploaded SwiftUI ${selection.version} (${selection.build}). Check status after Apple processes it.\n`,
  );
}

// Xcode needs a file. REST requests use only the in-memory key.
export async function withTemporaryPrivateKey(
  privateKey: NodeCrypto.KeyObject,
  operation: (keyPath: string) => Promise<void>,
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-swift-testflight-"));
  try {
    await NodeFSP.chmod(directory, 0o700);
    const keyPath = NodePath.join(directory, "AuthKey.p8");
    await NodeFSP.writeFile(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), {
      mode: 0o600,
      flag: "wx",
    });
    await operation(keyPath);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

export function parseTestFlightArgs(args: string[]) {
  const { values, positionals } = NodeUtil.parseArgs({
    args,
    allowPositionals: true,
    options: {
      "env-file": { type: "string" },
      build: { type: "string" },
      version: { type: "string" },
      "notes-file": { type: "string" },
      archive: { type: "string" },
      "export-options": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return { command: "help" as const };
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    (command !== "status" && command !== "publish" && command !== "upload")
  ) {
    throw new Error("Choose status, publish, or upload. Use --help for usage.");
  }
  const envFile =
    values["env-file"] ??
    process.env.T3_SWIFT_TESTFLIGHT_ENV_FILE ??
    NodePath.join(NodeOS.homedir(), ".config/t3code/.env.testflight");
  if (command === "upload") {
    if (values.build || values.version || values["notes-file"]) {
      throw new Error(
        "Upload reads the build and version from the archive; do not supply --build, --version, or --notes-file.",
      );
    }
    return {
      command: "upload" as const,
      envFile,
      archive: text(values.archive, "--archive"),
      exportOptions: text(values["export-options"], "--export-options"),
    };
  }
  if (values.archive || values["export-options"])
    throw new Error("Archive options are only valid with upload.");
  const selection = validateBuildSelection({
    build: text(values.build, "--build"),
    version: text(values.version, "--version"),
  });
  if (command === "status" && values["notes-file"]) {
    throw new Error("--notes-file is only valid with publish.");
  }
  return command === "publish"
    ? {
        command: "publish" as const,
        envFile,
        ...selection,
        notesFile: text(values["notes-file"], "--notes-file"),
      }
    : { command: "status" as const, envFile, ...selection };
}

function expandHome(path: string) {
  return path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(2)) : path;
}

async function main() {
  const args = parseTestFlightArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(`Usage:
  node scripts/swift-testflight.ts status --build 46 --version 0.1.0
  node scripts/swift-testflight.ts publish --build 46 --version 0.1.0 --notes-file /path/to/notes.txt
  node scripts/swift-testflight.ts upload --archive /path/to/T3Code.xcarchive --export-options /path/to/ExportOptions.plist

Optional: --env-file /path/to/.env or T3_SWIFT_TESTFLIGHT_ENV_FILE.
Default env file: ~/.config/t3code/.env.testflight (mode 600, never committed).
Required variables: T3_SWIFT_ASC_KEY_ID, T3_SWIFT_ASC_ISSUER_ID,
T3_SWIFT_ASC_PRIVATE_KEY_BASE64, T3_SWIFT_ASC_APP_ID,
T3_SWIFT_ASC_PUBLIC_GROUP_ID, T3_SWIFT_ASC_INTERNAL_GROUP_ID.
Only the Release SwiftUI app and the two configured existing groups are supported.
Publish does not upload, create testers, change signing, or expire other builds.
`);
    return;
  }
  const { config, privateKey } = await readTestFlightEnv(args.envFile);
  const client = createTestFlightClient(config, privateKey);
  if (args.command === "upload") {
    await uploadArchive(args.archive, args.exportOptions, config, privateKey, client.verifyUpload);
    return;
  }
  const selection = { build: args.build, version: args.version };
  const result =
    args.command === "publish"
      ? await client.publish(selection, await NodeFSP.readFile(expandHome(args.notesFile), "utf8"))
      : await client.status(selection);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (args.command === "publish") {
    process.stdout.write(
      result.publicTesting
        ? "Public beta testing is active.\n"
        : `Public testing is not active yet. Apple reports ${result.externalState ?? result.processingState}. Run status to check again.\n`,
    );
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "TestFlight command failed."}\n`,
    );
    process.exitCode = 1;
  });
}
