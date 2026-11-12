/**
 * Run the live AWS suites for services that have a Floci local provider
 * (`flociDual` / `ProviderLayer.dual` in Providers.ts) under
 * `ALCHEMY_TEST_DEV=1`.
 *
 * Dedicated `*.local.test.ts` files are excluded — those already set
 * `Test.make({ dev: true })` and some use `Alchemy.remote()` for out-of-band
 * live checks, which this env would redirect onto the emulator. Suites for
 * live-only resources (`liveOnlySuites`) are excluded too.
 *
 * Extra alchemy-test args are forwarded (`-t`, `--retry`, paths, …).
 * `--list` prints selected files without starting tests or touching Floci.
 * `--external` uses an existing server without Docker fallback or state reset.
 * `--dry-run` prints the resolved command without starting tests or touching Floci.
 * Shared state is preserved unless `--reset-shared` is explicitly passed.
 * Standing prerequisites of gated suites (see floci-fixtures.ts) are
 * provisioned in Floci before the run and removed after it.
 *
 * Usage: node scripts/test-aws-floci.ts [--list] [--dry-run] [--external] [--reset-shared] [alchemy-test args...]
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command, Flag } from "effect/cli";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Runtime from "effect/Runtime";
import * as Stdio from "effect/Stdio";
import { startFlociForTests } from "./floci-container.ts";
import { provisionFlociStandingFixtures } from "./floci-fixtures.ts";
import { preferLocalFlociImage } from "./floci-image.ts";
import { resolveFlociDefaultNetwork } from "./floci-network.ts";

const LABEL = "test:aws:floci";

/** Ends the run with `code` after the reason has already been printed. */
class ExitWith extends Data.TaggedError("ExitWith")<{ readonly code: number }> {
  readonly [Runtime.errorReported] = false;
  get [Runtime.errorExitCode]() {
    return this.code;
  }
}

const fail = (message: string) =>
  Console.error(`${LABEL}: ${message}`).pipe(Effect.andThen(new ExitWith({ code: 1 })));

const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error);

const extraDirs: Record<string, ReadonlyArray<string>> = {
  SecretsManager: ["Secret"],
};

// Opt-in gates whose tests are gated only for live-AWS cost, quota, slow
// provisioning, or preview access. Floci emulates all of them, so enable them
// here unless the caller set them explicitly. Gates that need standing
// resources are provisioned by floci-fixtures.ts.
const flociOptInGates = [
  "ALCHEMY_TEST_IDENTITY_CENTER",
  "AWS_LAMBDA_TEST_SHUTDOWN",
  "AWS_ORG_MANAGEMENT_ACCOUNT",
  "AWS_TEST_APIGWV2_VPCLINK",
  "AWS_TEST_APPSYNC_CACHE",
  "AWS_TEST_CLOUDHSM",
  "AWS_TEST_CLOUDTRAIL_LAKE",
  "AWS_TEST_CLOUDMAP_PUBLIC",
  "AWS_TEST_CODEARTIFACT_EVENTS",
  "AWS_TEST_CONFIG_RECORDER",
  "AWS_TEST_EFS_MULTI_AZ",
  "AWS_TEST_METRICSTREAM",
  "AWS_TEST_NAT_GATEWAY",
  "AWS_TEST_NETWORKFIREWALL",
  "AWS_TEST_ORG_MANAGEMENT",
  "AWS_TEST_POLICY_STORE_ALIAS",
  "AWS_TEST_RDS_DBCLUSTER",
  "AWS_TEST_RDS_DBCLUSTER_ENDPOINT",
  "AWS_TEST_RDS_DBINSTANCE",
  "AWS_TEST_RDS_DBSUBNETGROUP",
  "AWS_TEST_RE2_AGGREGATOR",
  "AWS_TEST_REDSHIFT",
  "AWS_TEST_REGION_OPT_IN",
  "AWS_TEST_SAGEMAKER_HYPERPOD",
  "AWS_TEST_SERVICE_QUOTAS",
  "AWS_TEST_SES_DEDICATED_IP",
  "AWS_TEST_SLOW",
  "AWS_TEST_TRANSFER_TRANSITIONS",
  "AWS_TEST_WAF_ASSOCIATION",
  "AWS_TEST_WAF_CLOUDFRONT",
  "CLOUDFRONT_TEST_VPC_ORIGIN",
  "INSPECTOR2_TEST_CIS",
  "INSPECTOR2_TEST_ENABLER",
  "LAMBDA_TEST_MICROVM",
  "LAMBDA_TEST_NETWORK_CONNECTOR",
  "RDS_TEST_LIFECYCLE",
];

// Values that gated suites need but Floci accepts without standing resources
// (checked against each suite and Floci's validation). Applied with `??=`.
const flociFixedValues: Record<string, string> = {
  // Distinct from the delegated-admin principal: registering a delegated
  // admin enables trusted access for its principal (Floci OrganizationsService).
  AWS_ORG_TRUSTED_SERVICE_PRINCIPAL: "ssm.amazonaws.com",
  AWS_ORG_DELEGATED_ADMIN_SERVICE_PRINCIPAL: "config.amazonaws.com",
  AWS_TEST_SES_MAIL_FROM_IDENTITY: "ses-mailfrom.alchemy-test.example.com",
  AWS_TEST_SES_MAIL_FROM_DOMAIN: "bounce.ses-mailfrom.alchemy-test.example.com",
  AWS_TEST_SNS_PLATFORM: "1",
  AWS_TEST_SNS_PLATFORM_NAME: "GCM",
  // Floci accepts GCM credentials of 24+ chars without "invalid"/"fake"/"probe".
  AWS_TEST_SNS_PLATFORM_CREDENTIAL: "alchemy-floci-gcm-server-key-000000000000",
  AWS_TEST_SNS_PLATFORM_TOKEN: "alchemy-floci-device-token-0001",
  // Floci's AgentCore control plane records the artifact without pulling it.
  AWS_TEST_AGENTCORE: "1",
  AWS_TEST_AGENTCORE_IMAGE:
    "000000000000.dkr.ecr.us-east-1.amazonaws.com/alchemy-floci-agentcore:latest",
  // Floci stores authorizer URIs without resolving the function.
  ALCHEMY_TEST_AUTHORIZER_URI:
    "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:000000000000:function:alchemy-floci-standing-authorizer/invocations",
};

/**
 * Suites inside a dualized service folder whose resources stay live-only
 * (registered without `flociDual` in Providers.ts). This runner points every
 * AWS client at the emulator, so they cannot reach the AWS service they test.
 */
const liveOnlySuites = new Set([
  // Floci does not emulate Lambda Web Functions.
  "Lambda/WebFunction.test.ts",
  "Lambda/WebFunctionEndpoint.test.ts",
  "Lambda/WebFunctionPermission.test.ts",
]);

/** alchemy-test flags whose next argument is their value. */
const flagsWithValue = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--retry",
  "--concurrency",
  "-c",
  "--profile",
]);

/** Flags this runner owns; everything else is forwarded to alchemy-test. */
const ownFlags = new Set([
  "--list",
  "--dry-run",
  "--external",
  "--reset-shared",
  "--help",
  "-h",
  "--version",
]);

/**
 * Moves forwarded alchemy-test args behind `--`, so the CLI parser takes them
 * verbatim (`--concurrency=2`, `-t <pattern>`, paths) instead of rejecting
 * flags it does not know.
 */
const splitArgs = (args: ReadonlyArray<string>) => {
  const own: string[] = [];
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      forwarded.push(...args.slice(i + 1));
      break;
    }
    if (ownFlags.has(arg)) {
      own.push(arg);
      continue;
    }
    forwarded.push(arg);
    if (flagsWithValue.has(arg) && args[i + 1] && !args[i + 1]!.startsWith("-")) {
      forwarded.push(args[++i]!);
    }
  }
  return [...own, "--", ...forwarded];
};

const dualizedServices = Effect.fn(function* (providersFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs.readFileString(providersFile);
  const names = new Set<string>(["Local"]);
  const pattern = /(?:flociDual|ProviderLayer\.dual)\(\s*([A-Za-z0-9]+)\./g;
  for (const match of source.matchAll(pattern)) {
    const service = match[1]!;
    names.add(service);
    for (const extra of extraDirs[service] ?? []) names.add(extra);
  }
  return [...names].sort();
});

/** Test files under `root`, matching `**\/*.test.ts` without dot directories. */
const findTestFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(root, { recursive: true });
  return entries
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter(
      (entry) =>
        entry.endsWith(".test.ts") && !entry.split("/").some((part) => part.startsWith(".")),
    );
});

const optionalEnv = (name: string) => Config.String(name).pipe(Config.withDefault(""));

const command = Command.make(
  "test-aws-floci",
  {
    list: Flag.Boolean("list").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the selected test files without starting tests or Floci"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the resolved command without starting tests or Floci"),
    ),
    external: Flag.Boolean("external").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Use an existing Floci server, without Docker fallback or state reset (or ALCHEMY_FLOCI_EXTERNAL=1)",
      ),
    ),
    resetShared: Flag.Boolean("reset-shared").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Reset the shared emulator state before the run"),
    ),
    args: Argument.String("alchemy-test-args").pipe(
      Argument.withDescription("Test paths and alchemy-test flags (-t, --retry, -c, …), forwarded"),
      Argument.atLeast(0),
    ),
  },
  Effect.fn(function* (options) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;

    const repoRoot = path.resolve(import.meta.dirname, "..");
    const testPackageRoot = path.join(repoRoot, "packages/integration-tests");
    const awsTestRoot = path.join(testPackageRoot, "test/AWS");
    const providersFile = path.join(repoRoot, "packages/aws/src/Providers.ts");

    const flags: string[] = [];
    const paths: string[] = [];
    const args = options.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.startsWith("-")) {
        flags.push(arg);
        if (flagsWithValue.has(arg) && args[i + 1] && !args[i + 1]!.startsWith("-")) {
          flags.push(args[++i]!);
        }
        continue;
      }
      paths.push(arg);
    }
    const listOnly = options.list;
    const dryRun = options.dryRun;
    const resetShared = options.resetShared;
    const external = options.external || (yield* optionalEnv("ALCHEMY_FLOCI_EXTERNAL")) === "1";

    const allowedRoots = yield* Effect.filter(
      (yield* dualizedServices(providersFile)).map((service) => path.join(awsTestRoot, service)),
      (dir) => fs.exists(dir),
    );
    if (allowedRoots.length === 0) {
      yield* Console.error(`${LABEL}: no dualized AWS service test dirs found`);
      return yield* new ExitWith({ code: 1 });
    }

    const requestedRoots =
      paths.length > 0 ? paths.map((p) => path.resolve(testPackageRoot, p)) : allowedRoots;

    const files: string[] = [];
    for (const root of requestedRoots) {
      const info = yield* fs.stat(root).pipe(Effect.option);
      if (info._tag === "None" || info.value.type !== "Directory") {
        files.push(path.relative(testPackageRoot, root));
        continue;
      }
      for (const file of yield* findTestFiles(root)) {
        if (file.endsWith(".local.test.ts")) continue;
        if (liveOnlySuites.has(path.relative(awsTestRoot, path.join(root, file)))) continue;
        files.push(path.relative(testPackageRoot, path.join(root, file)));
      }
    }

    if (listOnly) {
      return yield* Console.log([...new Set(files)].sort().join("\n"));
    }

    if (resetShared && (external || (yield* optionalEnv("ALCHEMY_FLOCI_NO_RESET")) !== "")) {
      return yield* fail("--reset-shared conflicts with --external or ALCHEMY_FLOCI_NO_RESET");
    }

    // Local providers currently use this gateway regardless of SDK overrides.
    const endpointError =
      "AWS_ENDPOINT_URL must be http://localhost:4566; isolated gateways are not supported yet";
    const endpointValue = yield* Config.String("AWS_ENDPOINT_URL").pipe(
      Config.withDefault("http://localhost:4566"),
    );
    if (!URL.canParse(endpointValue)) return yield* fail(endpointError);
    const endpoint = new URL(endpointValue);
    if (
      endpoint.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(endpoint.hostname) ||
      endpoint.port !== "4566" ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password
    ) {
      return yield* fail(endpointError);
    }

    const hasFlag = (...names: string[]) =>
      flags.some((flag) => names.some((name) => flag === name || flag.startsWith(`${name}=`)));
    if (!hasFlag("--profile")) flags.unshift("--profile", "testing");
    if (!hasFlag("--concurrency", "-c")) flags.unshift("--concurrency", "4");
    const testCommand = ["bun", "alchemy-test", ...new Set(files.sort()), ...flags];
    if (dryRun) {
      return yield* Console.log(
        JSON.stringify({
          command: testCommand,
          cwd: testPackageRoot,
          external,
          resetShared,
          endpoint: "http://localhost:4566",
        }),
      );
    }

    // The env is written to `process.env` rather than only handed to the
    // child: the in-process Floci helpers (`ensureFloci`, fixtures) read
    // `ALCHEMY_FLOCI_*` from it too, and the child inherits it.
    const setEnv = (values: Record<string, string>, overwrite: boolean) =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(values)) {
          if (overwrite || process.env[name] === undefined) process.env[name] = value;
        }
      });
    yield* setEnv(
      {
        ALCHEMY_TEST_DEV: "1",
        AWS_ENDPOINT_URL: "http://localhost:4566",
        ...(external ? { ALCHEMY_FLOCI_EXTERNAL: "1" } : {}),
      },
      true,
    );
    yield* setEnv(
      {
        ...Object.fromEntries(flociOptInGates.map((gate) => [gate, "1"])),
        // One test process deploys many functions at once; each rolldown build
        // holds its whole module graph in native memory.
        ALCHEMY_BUNDLE_CONCURRENCY: "2",
        ...flociFixedValues,
      },
      false,
    );

    if (external) {
      yield* Console.log(`${LABEL}: using the existing Floci server (no Docker fallback)`);
    } else {
      yield* preferLocalFlociImage(LABEL);
      yield* startFlociForTests(LABEL).pipe(
        Effect.catch((error) =>
          fail(
            `could not start the Floci container: ${errorMessage(error)}; tests were not started`,
          ),
        ),
      );
    }

    // Suites that take subnet/security-group IDs from the environment (e.g.
    // Timestream DbInstance) get the emulator's default VPC network. Floci must
    // be serving for this lookup, so start it here in non-external mode.
    const subnetIds = yield* optionalEnv("AWS_TEST_SUBNET_IDS");
    const securityGroupIds = yield* optionalEnv("AWS_TEST_SECURITY_GROUP_IDS");
    if ((yield* optionalEnv("AWS_TEST_SLOW")) !== "" && (!subnetIds || !securityGroupIds)) {
      const network = yield* resolveFlociDefaultNetwork(external).pipe(
        Effect.catch((error) =>
          fail(
            `could not resolve the emulator's default VPC network: ${errorMessage(error)}; tests were not started`,
          ),
        ),
      );
      yield* setEnv(
        {
          AWS_TEST_SUBNET_IDS: network.subnetIds.join(","),
          AWS_TEST_SECURITY_GROUP_IDS: network.securityGroupIds.join(","),
        },
        false,
      );
    }

    if (resetShared) {
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.post("http://localhost:4566/_floci/state/reset").pipe(
        Effect.timeout("5 seconds"),
        Effect.catch((error) =>
          fail(`could not reset emulator state: ${errorMessage(error)}; tests were not started`),
        ),
      );
      if (res.status < 200 || res.status >= 300) {
        return yield* fail(`emulator state reset returned ${res.status}; tests were not started`);
      }
      yield* Console.log(`${LABEL}: reset shared emulator state`);
    } else {
      yield* Console.log(`${LABEL}: preserving shared emulator state`);
    }

    // Provisioned after any reset so the reset cannot wipe them. Interrupting
    // provisioning (Ctrl-C) removes already-created fixtures first.
    const fixtures = yield* provisionFlociStandingFixtures(external, { files }).pipe(
      Effect.catch((error) =>
        fail(
          `could not provision standing fixtures: ${errorMessage(error)}; tests were not started`,
        ),
      ),
    );
    yield* setEnv(fixtures.env, false);

    const teardown =
      Object.keys(fixtures.env).length === 0
        ? Effect.void
        : Console.log(`${LABEL}: removing standing fixtures`).pipe(
            Effect.andThen(fixtures.teardown),
            Effect.catch((error) =>
              Console.error(`${LABEL}: fixture teardown failed: ${errorMessage(error)}`),
            ),
          );

    // Not detached: terminal Ctrl-C reaches the child through the shared
    // process group. On interruption (Ctrl-C, or a SIGTERM aimed at this
    // runner alone) the child is sent SIGTERM and awaited, then fixtures are
    // torn down.
    const exitCode = yield* Effect.scoped(
      spawner
        .spawn(
          ChildProcess.make(testCommand[0]!, testCommand.slice(1), {
            cwd: testPackageRoot,
            detached: false,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }),
        )
        .pipe(Effect.flatMap((child) => child.exitCode)),
    ).pipe(
      Effect.catch((error) => Console.error(`${LABEL}: ${errorMessage(error)}`).pipe(Effect.as(1))),
      Effect.ensuring(teardown),
    );
    if (exitCode !== 0) return yield* new ExitWith({ code: exitCode });
  }),
).pipe(Command.withDescription("Run the Floci-dualized AWS suites against the local emulator"));

Stdio.Stdio.use(({ args }) =>
  Effect.flatMap(args, (argv) => Command.runWith(command, { version: "0.0.0" })(splitArgs(argv))),
).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain,
);
