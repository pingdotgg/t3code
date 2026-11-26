// Fork: Kaluwa's Extensions page. Lists and changes each subscription's user-level MCP servers,
// plugins and skills by running that subscription's own CLI with its own environment, the way its
// driver does. Only Antigravity's MCP file is edited directly, because `agy mcp` ignores GEMINI_HOME.
import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ExtensionsError,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ExtensionMcpServer,
  type ExtensionMcpServerSpec,
  type ExtensionPlugin,
  type ExtensionSkill,
  type ExtensionsCapabilities,
  type ExtensionsListInput,
  type ExtensionsListResult,
  type ExtensionsMutation,
  type ExtensionsMutationOutcome,
  type ExtensionsMutationResult,
  type ExtensionsReadIssue,
  type ExtensionsSubscription,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  antigravityUserSkillDirectories,
  resolveAntigravityUserHome,
} from "../provider/Drivers/AntigravitySkills.ts";
import {
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import { claudeAccountConfigPath } from "../provider/claudeResetCredits.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  editAntigravityMcpConfig,
  readAntigravityMcpServers,
  type AntigravityEditResult,
} from "./antigravityExtensions.ts";
import {
  claudeAddJson,
  CLAUDE_CONNECTOR_PREFIX,
  parseClaudeMcpList,
  parseClaudePluginList,
  readClaudeUserMcpServers,
  withClaudeHealth,
} from "./claudeExtensions.ts";
import {
  CODEX_USER_CONFIG_ONLY_ARGS,
  codexAddPlan,
  codexSpecFromGet,
  parseCodexMcpList,
  type CopiedSpec,
} from "./codexExtensions.ts";
import { scrubSecretValues } from "./redaction.ts";
import {
  discoverSkills,
  isSafeSkillName,
  linkSkill,
  listLibrarySkills,
  moveSkillToLibrary,
  SKILL_LIBRARY_SEGMENTS,
  unlinkSkill,
  type SkillOutcome,
} from "./skills.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const SUPPORTED_DRIVERS = [CLAUDE, CODEX, ANTIGRAVITY] as const;

const CLI_TIMEOUT = Duration.seconds(30);
// `claude mcp list` connects to every server, and a sign-in waits for the browser.
const HEALTH_TIMEOUT = Duration.seconds(60);
const SIGN_IN_TIMEOUT = Duration.minutes(5);
const READ_CONCURRENCY = 4;
const MAX_MESSAGE_LENGTH = 400;

const driverOrder = (driver: ProviderDriverKind) =>
  SUPPORTED_DRIVERS.findIndex((candidate) => candidate === driver);
const isDefaultInstance = (instance: {
  readonly instanceId: ProviderInstanceId;
  readonly config: ProviderInstanceConfig;
}) => String(instance.instanceId) === String(instance.config.driver);

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeAntigravitySettings = Schema.decodeUnknownOption(AntigravitySettings);

interface SubscriptionBase {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly accentColor: string | null;
  readonly configHome: string;
  readonly env: NodeJS.ProcessEnv;
  readonly binary: string;
  readonly skillsDirs: ReadonlyArray<string>;
  readonly capabilities: ExtensionsCapabilities;
}

type Subscription =
  | (SubscriptionBase & { readonly driver: "claudeAgent"; readonly accountConfigPath: string })
  | (SubscriptionBase & { readonly driver: "codex" })
  | (SubscriptionBase & { readonly driver: "antigravity"; readonly mcpConfigPath: string });

type Capability = keyof ExtensionsCapabilities;

const CAPABILITY_LABELS: Record<Capability, string> = {
  mcp: "MCP servers",
  mcpSignIn: "MCP sign-in",
  mcpSetEnabled: "turning MCP servers on and off",
  plugins: "plugins",
  skills: "skill changes",
};

const outcome = (
  instanceId: ProviderInstanceId,
  ok: boolean,
  message: string | null = null,
): ExtensionsMutationOutcome => ({ instanceId, ok, message });

export class ExtensionsService extends Context.Service<
  ExtensionsService,
  {
    readonly list: (
      input: ExtensionsListInput,
    ) => Effect.Effect<ExtensionsListResult, ExtensionsError>;
    readonly mutate: (
      mutation: ExtensionsMutation,
    ) => Effect.Effect<ExtensionsMutationResult, ExtensionsError>;
  }
>()("t3/extensions/ExtensionsService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const digest = yield* Digest.Digest;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const libraryDir = path.join(home, ...SKILL_LIBRARY_SEGMENTS);

  const withServices = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const displayPath = (absolute: string) => {
    if (absolute === home) return "~";
    return absolute.startsWith(home + path.sep) ? `~${absolute.slice(home.length)}` : absolute;
  };

  const readOptionalFile = (file: string) =>
    fileSystem
      .readFileString(file)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")));

  const writeFileAtomically = Effect.fn("ExtensionsService.writeFileAtomically")(function* (
    file: string,
    contents: string,
  ) {
    const temporary = `${file}.${process.pid}.tmp`;
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(temporary, contents);
    yield* fileSystem
      .rename(temporary, file)
      .pipe(Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)));
  });

  const runCli = (
    subscription: Subscription,
    args: ReadonlyArray<string>,
    options: { readonly timeout?: Duration.Duration; readonly stdin?: string } = {},
  ) =>
    processRunner.run({
      command: subscription.binary,
      args,
      env: subscription.env,
      // Packaged desktop builds run from $HOME, where cwd-scoped `claude` wrappers refuse to start.
      cwd: stateDir,
      timeout: options.timeout ?? CLI_TIMEOUT,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    });

  const cliFailure = (output: ProcessRunner.ProcessRunOutput, secrets: ReadonlyArray<string>) => {
    const text = (output.stderr.trim() || output.stdout.trim()).slice(-MAX_MESSAGE_LENGTH);
    return text.length > 0
      ? scrubSecretValues(text, secrets)
      : `Exited with code ${String(output.code)}.`;
  };

  /** Runs a changing CLI command and reports it as one instance's outcome; it never fails. */
  const runCliOutcome = (
    subscription: Subscription,
    args: ReadonlyArray<string>,
    options: {
      readonly timeout?: Duration.Duration;
      readonly stdin?: string;
      readonly secrets?: ReadonlyArray<string>;
      readonly successMessage?: string | null;
    } = {},
  ) =>
    runCli(subscription, args, options).pipe(
      Effect.map((output) =>
        output.code === 0
          ? outcome(subscription.instanceId, true, options.successMessage ?? null)
          : outcome(subscription.instanceId, false, cliFailure(output, options.secrets ?? [])),
      ),
      Effect.catch((error) =>
        Effect.succeed(outcome(subscription.instanceId, false, error.message)),
      ),
    );

  const configuredInstances = Effect.fn("ExtensionsService.configuredInstances")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        () => new ExtensionsError({ message: "Could not read the server settings." }),
      ),
    );
    const instances: Array<{ instanceId: ProviderInstanceId; config: ProviderInstanceConfig }> =
      Object.entries(settings.providerInstances)
        .filter(([, config]) => SUPPORTED_DRIVERS.some((driver) => driver === config.driver))
        .map(([instanceId, config]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          config,
        }));
    // A driver's default instance exists even before settings name it.
    for (const driver of SUPPORTED_DRIVERS) {
      if (!Object.hasOwn(settings.providerInstances, driver)) {
        instances.push({ instanceId: ProviderInstanceId.make(driver), config: { driver } });
      }
    }
    return instances
      .filter(({ config }) => resolveProviderInstanceEnabled(config))
      .sort(
        (left, right) =>
          driverOrder(left.config.driver) - driverOrder(right.config.driver) ||
          Number(!isDefaultInstance(left)) - Number(!isDefaultInstance(right)) ||
          left.instanceId.localeCompare(right.instanceId),
      );
  });

  const resolveSubscription = Effect.fn("ExtensionsService.resolveSubscription")(function* (
    instanceId: ProviderInstanceId,
    config: ProviderInstanceConfig,
  ) {
    const live = yield* registry.getInstance(instanceId);
    const base = {
      instanceId,
      displayName:
        config.displayName ??
        live?.displayName ??
        PROVIDER_DISPLAY_NAMES[config.driver] ??
        config.driver,
      accentColor: config.accentColor ?? live?.accentColor ?? null,
    };
    if (config.driver === CLAUDE) {
      const settings = decodeClaudeSettings(config.config ?? {});
      if (Option.isNone(settings)) return Option.none<Subscription>();
      const baseEnv = yield* mergeClaudeProcessEnvironment(
        settings.value,
        config.environment,
        hostEnvironment,
      );
      const env = yield* makeClaudeEnvironment(settings.value, baseEnv);
      const configHome = yield* resolveClaudeHomePath(settings.value, baseEnv);
      const customHome =
        settings.value.homePath.trim().length > 0 ||
        (baseEnv.CLAUDE_CONFIG_DIR?.trim().length ?? 0) > 0;
      return Option.some<Subscription>({
        ...base,
        driver: "claudeAgent",
        configHome,
        env,
        binary: expandHomePath(settings.value.binaryPath, home) || "claude",
        skillsDirs: [path.join(configHome, "skills")],
        accountConfigPath: yield* claudeAccountConfigPath(customHome ? configHome : undefined),
        capabilities: {
          mcp: true,
          mcpSignIn: true,
          mcpSetEnabled: false,
          plugins: true,
          skills: true,
        },
      });
    }
    if (config.driver === CODEX) {
      const settings = decodeCodexSettings(config.config ?? {});
      if (Option.isNone(settings)) return Option.none<Subscription>();
      const processEnv = yield* mergeProviderInstanceEnvironment(
        config.environment,
        hostEnvironment,
      );
      const environmentHome = processEnv.CODEX_HOME;
      const layout = yield* resolveCodexHomeLayout(
        !settings.value.homePath.trim() && environmentHome?.trim()
          ? { ...settings.value, homePath: environmentHome }
          : settings.value,
      );
      // config.toml and skills/ live in the shared home, which auth-overlay homes link to.
      const configHome = layout.sharedHomePath;
      return Option.some<Subscription>({
        ...base,
        driver: "codex",
        configHome,
        env: { ...processEnv, CODEX_HOME: configHome },
        binary: expandHomePath(settings.value.binaryPath, home) || "codex",
        skillsDirs: [path.join(configHome, "skills")],
        capabilities: {
          mcp: true,
          mcpSignIn: true,
          mcpSetEnabled: false,
          plugins: false,
          skills: true,
        },
      });
    }
    const settings = decodeAntigravitySettings(config.config ?? {});
    if (Option.isNone(settings)) return Option.none<Subscription>();
    const processEnv = yield* mergeProviderInstanceEnvironment(config.environment, hostEnvironment);
    const directories = yield* resolveAntigravityInstanceDirectories(stateDir, instanceId).pipe(
      Effect.provideService(Digest.Digest, digest),
    );
    // The profile's skill folders link to the real ~/.gemini ones, which every Antigravity
    // instance and the agy CLI share, so they are listed but not changed from here.
    const userHome = resolveAntigravityUserHome(platform, processEnv, home);
    return Option.some<Subscription>({
      ...base,
      driver: "antigravity",
      configHome: directories.profile,
      env: processEnv,
      binary: "agy",
      skillsDirs: antigravityUserSkillDirectories(path, path.join(userHome, ".gemini")),
      mcpConfigPath: path.join(directories.profile, "config", "mcp_config.json"),
      capabilities: {
        mcp: true,
        mcpSignIn: false,
        mcpSetEnabled: true,
        plugins: false,
        skills: false,
      },
    });
  });

  const resolveSubscriptions = Effect.fn("ExtensionsService.resolveSubscriptions")(function* () {
    const instances = yield* configuredInstances();
    const resolved = yield* Effect.forEach(instances, ({ instanceId, config }) =>
      withServices(resolveSubscription(instanceId, config)),
    );
    return resolved.flatMap((subscription) => Option.toArray(subscription));
  });

  // MCP reads

  const readClaudeMcp = Effect.fn("ExtensionsService.readClaudeMcp")(function* (
    subscription: Extract<Subscription, { driver: "claudeAgent" }>,
    checkHealth: boolean,
  ) {
    const issues: Array<ExtensionsReadIssue> = [];
    const text = yield* readOptionalFile(subscription.accountConfigPath);
    const configured = readClaudeUserMcpServers(text);
    if (configured === undefined) {
      return {
        servers: [],
        issues: [
          {
            kind: "mcp",
            message: `${displayPath(subscription.accountConfigPath)} isn't valid JSON.`,
          },
        ],
      } as const;
    }
    if (configured.skipped.length > 0) {
      issues.push({
        kind: "mcp",
        message: `Skipped servers with an unsupported transport: ${configured.skipped.join(", ")}.`,
      });
    }
    if (!checkHealth) return { servers: configured.servers, issues } as const;
    const health = yield* runCli(subscription, ["mcp", "list"], { timeout: HEALTH_TIMEOUT }).pipe(
      Effect.map((output) =>
        output.code === 0
          ? Option.some(parseClaudeMcpList(output.stdout))
          : (issues.push({
              kind: "mcp",
              message: `Health check failed: ${cliFailure(output, [])}`,
            }),
            Option.none()),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          issues.push({ kind: "mcp", message: `Health check failed: ${error.message}` });
          return Option.none();
        }),
      ),
    );
    return {
      servers: Option.match(health, {
        onNone: () => configured.servers,
        onSome: (listed) => withClaudeHealth(configured.servers, listed),
      }),
      issues,
    } as const;
  });

  const readCodexMcp = Effect.fn("ExtensionsService.readCodexMcp")(function* (
    subscription: Subscription,
  ) {
    const output = yield* runCli(subscription, [
      ...CODEX_USER_CONFIG_ONLY_ARGS,
      "mcp",
      "list",
      "--json",
    ]);
    if (output.code !== 0) return yield* Effect.fail(cliFailure(output, []));
    const servers = parseCodexMcpList(output.stdout);
    if (servers === undefined)
      return yield* Effect.fail("`codex mcp list --json` printed no JSON.");
    return { servers, issues: [] as ReadonlyArray<ExtensionsReadIssue> };
  });

  const readAntigravityMcp = Effect.fn("ExtensionsService.readAntigravityMcp")(function* (
    subscription: Extract<Subscription, { driver: "antigravity" }>,
  ) {
    const read = readAntigravityMcpServers(yield* readOptionalFile(subscription.mcpConfigPath));
    if (read === undefined) {
      return yield* Effect.fail(`${displayPath(subscription.mcpConfigPath)} isn't valid JSON.`);
    }
    return { servers: read.servers, issues: [] as ReadonlyArray<ExtensionsReadIssue> };
  });

  const readMcp = (subscription: Subscription, checkHealth: boolean) => {
    const read: Effect.Effect<
      {
        readonly servers: ReadonlyArray<ExtensionMcpServer>;
        readonly issues: ReadonlyArray<ExtensionsReadIssue>;
      },
      string | { readonly message: string }
    > =
      subscription.driver === "claudeAgent"
        ? readClaudeMcp(subscription, checkHealth)
        : subscription.driver === "codex"
          ? readCodexMcp(subscription)
          : readAntigravityMcp(subscription);
    return read.pipe(
      Effect.catch((error) =>
        Effect.succeed({
          servers: [] as ReadonlyArray<ExtensionMcpServer>,
          issues: [
            {
              kind: "mcp",
              message: typeof error === "string" ? error : error.message,
            } satisfies ExtensionsReadIssue,
          ],
        }),
      ),
    );
  };

  const readPlugins = Effect.fn("ExtensionsService.readPlugins")(function* (
    subscription: Subscription,
  ) {
    if (!subscription.capabilities.plugins) {
      return {
        plugins: [] as ReadonlyArray<ExtensionPlugin>,
        issues: [] as ReadonlyArray<ExtensionsReadIssue>,
      };
    }
    const failed = (message: string) => ({
      plugins: [] as ReadonlyArray<ExtensionPlugin>,
      issues: [{ kind: "plugin", message } satisfies ExtensionsReadIssue],
    });
    return yield* runCli(subscription, ["plugin", "list", "--json"]).pipe(
      Effect.map((output) => {
        if (output.code !== 0) return failed(cliFailure(output, []));
        const plugins = parseClaudePluginList(output.stdout);
        return plugins === undefined
          ? failed("`claude plugin list --json` printed no JSON.")
          : { plugins, issues: [] as ReadonlyArray<ExtensionsReadIssue> };
      }),
      Effect.catch((error) => Effect.succeed(failed(error.message))),
    );
  });

  const readSkills = Effect.fn("ExtensionsService.readSkills")(function* (
    subscription: Subscription,
  ) {
    return yield* Effect.forEach(subscription.skillsDirs, (skillsDir) =>
      withServices(discoverSkills({ skillsDir, libraryDir, displayPath })),
    ).pipe(
      Effect.map((lists) => ({
        skills: lists.flat() as ReadonlyArray<ExtensionSkill>,
        issues: [] as ReadonlyArray<ExtensionsReadIssue>,
      })),
      Effect.catch((error) =>
        Effect.succeed({
          skills: [] as ReadonlyArray<ExtensionSkill>,
          issues: [{ kind: "skill", message: error.message } satisfies ExtensionsReadIssue],
        }),
      ),
    );
  });

  const readSubscription = Effect.fn("ExtensionsService.readSubscription")(function* (
    subscription: Subscription,
    checkHealth: boolean,
  ) {
    const [mcp, plugins, skills] = yield* Effect.all(
      [readMcp(subscription, checkHealth), readPlugins(subscription), readSkills(subscription)],
      { concurrency: "unbounded" },
    );
    return {
      instanceId: subscription.instanceId,
      driver: ProviderDriverKind.make(subscription.driver),
      displayName: subscription.displayName,
      accentColor: subscription.accentColor,
      configHome: displayPath(subscription.configHome),
      capabilities: subscription.capabilities,
      mcpServers: mcp.servers,
      plugins: plugins.plugins,
      skills: skills.skills,
      issues: [...mcp.issues, ...plugins.issues, ...skills.issues],
    } satisfies ExtensionsSubscription;
  });

  const list: ExtensionsService["Service"]["list"] = Effect.fn("ExtensionsService.list")(
    function* (input) {
      const subscriptions = yield* resolveSubscriptions();
      const [read, librarySkills] = yield* Effect.all(
        [
          Effect.forEach(
            subscriptions,
            (subscription) => readSubscription(subscription, input.checkHealth),
            { concurrency: READ_CONCURRENCY },
          ),
          withServices(listLibrarySkills(libraryDir)).pipe(Effect.orElseSucceed(() => [])),
        ],
        { concurrency: "unbounded" },
      );
      return {
        subscriptions: read,
        library: { path: displayPath(libraryDir), skills: librarySkills },
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        healthChecked: input.checkHealth,
      };
    },
  );

  // Mutations

  const requireSubscriptions = Effect.fn("ExtensionsService.requireSubscriptions")(function* (
    instanceIds: ReadonlyArray<ProviderInstanceId>,
    capability: Capability,
  ) {
    const subscriptions = yield* resolveSubscriptions();
    const required: Array<Subscription> = [];
    for (const instanceId of new Set(instanceIds)) {
      const subscription = subscriptions.find((candidate) => candidate.instanceId === instanceId);
      if (subscription === undefined) {
        return yield* new ExtensionsError({
          message: `"${instanceId}" isn't an enabled Claude, Codex or Antigravity subscription.`,
        });
      }
      if (!subscription.capabilities[capability]) {
        return yield* new ExtensionsError({
          message: `${subscription.displayName} doesn't support ${CAPABILITY_LABELS[capability]} here.`,
        });
      }
      required.push(subscription);
    }
    if (required.length === 0) {
      return yield* new ExtensionsError({ message: "Choose at least one subscription." });
    }
    return required;
  });

  const requireCliName = (name: string, what: string) =>
    name.startsWith("-") || name.includes("\0")
      ? Effect.fail(new ExtensionsError({ message: `That ${what} name isn't valid.` }))
      : Effect.void;

  const invalidate = (instanceId: ProviderInstanceId) =>
    registry
      .getInstance(instanceId)
      .pipe(Effect.flatMap((instance) => instance?.invalidateCaches ?? Effect.void));

  const forEachSubscription = (
    subscriptions: ReadonlyArray<Subscription>,
    apply: (subscription: Subscription) => Effect.Effect<ExtensionsMutationOutcome>,
  ) =>
    // One at a time: subscriptions can share a config home, so concurrent edits could race.
    Effect.forEach(subscriptions, (subscription) =>
      apply(subscription).pipe(
        Effect.tap((result) => (result.ok ? invalidate(subscription.instanceId) : Effect.void)),
      ),
    ).pipe(Effect.map((outcomes) => ({ outcomes })));

  const editAntigravity = (
    subscription: Extract<Subscription, { driver: "antigravity" }>,
    edit: (text: string) => AntigravityEditResult,
  ) =>
    readOptionalFile(subscription.mcpConfigPath).pipe(
      Effect.flatMap((text) => {
        const result = edit(text);
        return result._tag === "refused"
          ? Effect.succeed(outcome(subscription.instanceId, false, result.message))
          : writeFileAtomically(subscription.mcpConfigPath, result.text).pipe(
              Effect.as(outcome(subscription.instanceId, true)),
            );
      }),
      Effect.catch((error) =>
        Effect.succeed(outcome(subscription.instanceId, false, error.message)),
      ),
    );

  const secretValuesOf = (spec: ExtensionMcpServerSpec) =>
    Object.values(spec._tag === "stdio" ? spec.env : spec.headers);

  const codexHasServer = (subscription: Subscription, name: string) =>
    runCli(subscription, [...CODEX_USER_CONFIG_ONLY_ARGS, "mcp", "get", name, "--json"]).pipe(
      Effect.map((output) => output.code === 0),
      Effect.orElseSucceed(() => false),
    );

  const addMcp = (
    subscription: Subscription,
    name: string,
    spec: ExtensionMcpServerSpec,
    notCopied: ReadonlyArray<string> = [],
  ): Effect.Effect<ExtensionsMutationOutcome> => {
    const secrets = secretValuesOf(spec);
    const withNotes = (result: ExtensionsMutationOutcome, notSet: ReadonlyArray<string>) =>
      result.ok && notSet.length > 0
        ? {
            ...result,
            message: `Added without ${notSet.join(", ")}. Set ${notSet.length === 1 ? "it" : "them"} again in ${subscription.displayName}.`,
          }
        : result;
    switch (subscription.driver) {
      case "claudeAgent":
        return runCliOutcome(subscription, ["mcp", "add-json", "-s", "user", name, "-"], {
          stdin: claudeAddJson(spec),
          secrets,
        }).pipe(Effect.map((result) => withNotes(result, notCopied)));
      case "codex": {
        const plan = codexAddPlan(name, spec);
        if (plan._tag === "unsupported") {
          return Effect.succeed(outcome(subscription.instanceId, false, plan.message));
        }
        return codexHasServer(subscription, name).pipe(
          Effect.flatMap((exists) =>
            exists
              ? Effect.succeed(
                  outcome(
                    subscription.instanceId,
                    false,
                    `A server named "${name}" already exists.`,
                  ),
                )
              : runCliOutcome(subscription, plan.args, { secrets }),
          ),
          Effect.map((result) => withNotes(result, [...notCopied, ...plan.notSet])),
        );
      }
      case "antigravity":
        return editAntigravity(subscription, (text) =>
          editAntigravityMcpConfig(text, { _tag: "add", name, spec }),
        ).pipe(Effect.map((result) => withNotes(result, notCopied)));
    }
  };

  const readSpec = Effect.fn("ExtensionsService.readSpec")(function* (
    subscription: Subscription,
    name: string,
  ) {
    switch (subscription.driver) {
      case "claudeAgent": {
        const spec = readClaudeUserMcpServers(
          yield* readOptionalFile(subscription.accountConfigPath),
        )?.specs.get(name);
        return spec ? Option.some<CopiedSpec>({ spec, notCopied: [] }) : Option.none<CopiedSpec>();
      }
      case "codex": {
        const output = yield* runCli(subscription, [
          ...CODEX_USER_CONFIG_ONLY_ARGS,
          "mcp",
          "get",
          name,
          "--json",
        ]);
        return output.code === 0
          ? Option.fromNullishOr(codexSpecFromGet(output.stdout))
          : Option.none<CopiedSpec>();
      }
      case "antigravity": {
        const spec = readAntigravityMcpServers(
          yield* readOptionalFile(subscription.mcpConfigPath),
        )?.specs.get(name);
        return spec ? Option.some<CopiedSpec>({ spec, notCopied: [] }) : Option.none<CopiedSpec>();
      }
    }
  });

  const copyMcp = Effect.fn("ExtensionsService.copyMcp")(function* (
    mutation: Extract<ExtensionsMutation, { _tag: "McpCopy" }>,
  ) {
    const [source] = yield* requireSubscriptions([mutation.fromInstanceId], "mcp");
    const targets = yield* requireSubscriptions(mutation.toInstanceIds, "mcp");
    if (source === undefined) return { outcomes: [] };
    const copied = yield* readSpec(source, mutation.name).pipe(
      Effect.orElseSucceed(() => Option.none<CopiedSpec>()),
    );
    if (Option.isNone(copied)) {
      return {
        outcomes: targets.map((target) =>
          outcome(
            target.instanceId,
            false,
            `Couldn't read "${mutation.name}" from ${source.displayName}.`,
          ),
        ),
      };
    }
    return yield* forEachSubscription(targets, (target) =>
      target.instanceId === source.instanceId
        ? Effect.succeed(outcome(target.instanceId, false, "That's the server's own subscription."))
        : addMcp(target, mutation.name, copied.value.spec, copied.value.notCopied),
    );
  });

  const removeMcp = (subscription: Subscription, name: string) => {
    if (name.startsWith(CLAUDE_CONNECTOR_PREFIX) && subscription.driver === "claudeAgent") {
      return Effect.succeed(
        outcome(subscription.instanceId, false, "claude.ai connectors are managed on claude.ai."),
      );
    }
    switch (subscription.driver) {
      case "claudeAgent":
        return runCliOutcome(subscription, ["mcp", "remove", "-s", "user", name]);
      case "codex":
        return runCliOutcome(subscription, ["mcp", "remove", name]);
      case "antigravity":
        return editAntigravity(subscription, (text) =>
          editAntigravityMcpConfig(text, { _tag: "remove", name }),
        );
    }
  };

  const setMcpEnabled = (subscription: Subscription, name: string, enabled: boolean) =>
    subscription.driver === "antigravity"
      ? editAntigravity(subscription, (text) =>
          editAntigravityMcpConfig(text, { _tag: "setEnabled", name, enabled }),
        )
      : // Neither CLI can turn a user-scope server off, and their config keys aren't ours to invent.
        Effect.succeed(
          outcome(
            subscription.instanceId,
            false,
            `${subscription.displayName} can't turn a user MCP server ${enabled ? "on" : "off"} from its CLI. Remove it instead, or edit its config.`,
          ),
        );

  const skillOutcome = (
    subscription: Subscription,
    apply: Effect.Effect<SkillOutcome, never, FileSystem.FileSystem | Path.Path>,
  ) =>
    withServices(apply).pipe(
      Effect.map((result) => outcome(subscription.instanceId, result.ok, result.message)),
    );

  const skillInput = (subscription: Subscription, name: string) => ({
    skillsDir: subscription.skillsDirs[0] ?? path.join(subscription.configHome, "skills"),
    libraryDir,
    name,
  });

  const requireSkillName = (name: string) =>
    isSafeSkillName(name)
      ? Effect.void
      : Effect.fail(new ExtensionsError({ message: "That skill name isn't valid." }));

  const mutate: ExtensionsService["Service"]["mutate"] = Effect.fn("ExtensionsService.mutate")(
    function* (mutation) {
      yield* Effect.annotateCurrentSpan("extensions.mutation", mutation._tag);
      switch (mutation._tag) {
        case "McpAdd": {
          yield* requireCliName(mutation.name, "server");
          const targets = yield* requireSubscriptions(mutation.instanceIds, "mcp");
          return yield* forEachSubscription(targets, (target) =>
            addMcp(target, mutation.name, mutation.spec),
          );
        }
        case "McpCopy":
          yield* requireCliName(mutation.name, "server");
          return yield* copyMcp(mutation);
        case "McpRemove": {
          yield* requireCliName(mutation.name, "server");
          const targets = yield* requireSubscriptions([mutation.instanceId], "mcp");
          return yield* forEachSubscription(targets, (target) => removeMcp(target, mutation.name));
        }
        case "McpSetEnabled": {
          yield* requireCliName(mutation.name, "server");
          const targets = yield* requireSubscriptions([mutation.instanceId], "mcpSetEnabled");
          return yield* forEachSubscription(targets, (target) =>
            setMcpEnabled(target, mutation.name, mutation.enabled),
          );
        }
        case "McpSignIn": {
          yield* requireCliName(mutation.name, "server");
          const targets = yield* requireSubscriptions([mutation.instanceId], "mcpSignIn");
          return yield* forEachSubscription(targets, (target) =>
            runCliOutcome(target, ["mcp", "login", mutation.name], { timeout: SIGN_IN_TIMEOUT }),
          );
        }
        case "PluginInstall": {
          yield* requireCliName(mutation.pluginId, "plugin");
          const targets = yield* requireSubscriptions(mutation.instanceIds, "plugins");
          // No `-y`: a plugin that installs by running a marketplace command needs a person's yes.
          return yield* forEachSubscription(targets, (target) =>
            runCliOutcome(target, ["plugin", "install", mutation.pluginId, "-s", "user"], {
              timeout: HEALTH_TIMEOUT,
            }),
          );
        }
        case "PluginSetEnabled": {
          yield* requireCliName(mutation.pluginId, "plugin");
          const targets = yield* requireSubscriptions([mutation.instanceId], "plugins");
          return yield* forEachSubscription(targets, (target) =>
            runCliOutcome(target, [
              "plugin",
              mutation.enabled ? "enable" : "disable",
              mutation.pluginId,
              "-s",
              "user",
            ]),
          );
        }
        case "PluginUninstall": {
          yield* requireCliName(mutation.pluginId, "plugin");
          const targets = yield* requireSubscriptions([mutation.instanceId], "plugins");
          return yield* forEachSubscription(targets, (target) =>
            runCliOutcome(target, ["plugin", "uninstall", mutation.pluginId, "-s", "user"]),
          );
        }
        case "SkillLink": {
          yield* requireSkillName(mutation.name);
          const targets = yield* requireSubscriptions(mutation.instanceIds, "skills");
          return yield* forEachSubscription(targets, (target) =>
            skillOutcome(target, linkSkill(skillInput(target, mutation.name))),
          );
        }
        case "SkillUnlink": {
          yield* requireSkillName(mutation.name);
          const targets = yield* requireSubscriptions([mutation.instanceId], "skills");
          return yield* forEachSubscription(targets, (target) =>
            skillOutcome(target, unlinkSkill(skillInput(target, mutation.name))),
          );
        }
        case "SkillMoveToLibrary": {
          yield* requireSkillName(mutation.name);
          const targets = yield* requireSubscriptions([mutation.instanceId], "skills");
          return yield* forEachSubscription(targets, (target) =>
            skillOutcome(target, moveSkillToLibrary(skillInput(target, mutation.name))),
          );
        }
      }
    },
  );

  return ExtensionsService.of({ list, mutate });
});

export const layer = Layer.effect(ExtensionsService, make).pipe(Layer.provide(ProcessRunner.layer));
