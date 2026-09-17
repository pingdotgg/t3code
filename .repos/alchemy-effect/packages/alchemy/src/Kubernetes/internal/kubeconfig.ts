/**
 * Internal kubeconfig resolution for the built-in cluster adapters: parse a
 * kubeconfig file, resolve a context to (cluster, user), and turn its auth
 * stanza — static token, client certificate, or `exec` credential plugin —
 * into a {@link ClusterTransport}. This is the "anything kubectl can reach"
 * path: AKS/GKE/EKS CLI-managed contexts work through their exec plugins
 * (`kubelogin`, `gke-gcloud-auth-plugin`, `aws eks get-token`).
 */
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as YAML from "yaml";

/** A kubeconfig file could not be read, parsed, or resolved. */
export class KubeConfigError extends Data.TaggedError(
  "Kubernetes.KubeConfigError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** An exec credential plugin invocation failed or answered malformed. */
export class ExecCredentialError extends Data.TaggedError(
  "Kubernetes.ExecCredentialError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface KubeConfigFile {
  "current-context"?: string;
  clusters?: {
    name?: string;
    cluster?: {
      server?: string;
      "certificate-authority"?: string;
      "certificate-authority-data"?: string;
      "insecure-skip-tls-verify"?: boolean;
    };
  }[];
  users?: {
    name?: string;
    user?: KubeConfigUser;
  }[];
  contexts?: {
    name?: string;
    context?: { cluster?: string; user?: string };
  }[];
}

interface KubeConfigUser {
  token?: string;
  tokenFile?: string;
  "client-certificate"?: string;
  "client-certificate-data"?: string;
  "client-key"?: string;
  "client-key-data"?: string;
  exec?: {
    command?: string;
    args?: string[];
    env?: { name?: string; value?: string }[];
    apiVersion?: string;
  };
}

/** The resolved connection material for one kubeconfig context. */
export interface ResolvedKubeContext {
  endpoint: string;
  certificateAuthorityData?: string;
  insecureSkipTlsVerify?: boolean;
  user: KubeConfigUser;
}

const decodeBase64 = (value: string) =>
  Buffer.from(value, "base64").toString("utf8");

const expandHome = Effect.fn(function* (input: string) {
  if (!input.startsWith("~")) return input;
  const home = yield* Effect.sync(
    () => process.env.HOME ?? process.env.USERPROFILE,
  );
  if (!home) {
    return yield* Effect.fail(
      new KubeConfigError({
        message: `Cannot expand '${input}': no HOME environment variable`,
      }),
    );
  }
  const path = yield* Path.Path;
  return path.join(home, input.slice(1));
});

/** Resolve the kubeconfig file path: explicit → `$KUBECONFIG` → default. */
export const resolveKubeConfigPath = Effect.fn(function* (
  explicit: string | undefined,
) {
  if (explicit) return yield* expandHome(explicit);
  const fromEnv = yield* Config.string("KUBECONFIG").pipe(
    Effect.orElseSucceed(() => undefined),
  );
  // $KUBECONFIG may be a path list; use the first entry like kubectl's
  // effective-config merge order.
  const candidate = fromEnv?.split(":")[0];
  if (candidate) return yield* expandHome(candidate);
  return yield* expandHome("~/.kube/config");
});

/** Load a kubeconfig file and resolve one context to its cluster + user. */
export const resolveKubeContext = Effect.fn(function* (options: {
  path?: string;
  context?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const configPath = yield* resolveKubeConfigPath(options.path);

  const raw = yield* fs.readFileString(configPath).pipe(
    Effect.mapError(
      (cause) =>
        new KubeConfigError({
          message: `Failed to read kubeconfig at '${configPath}'`,
          cause,
        }),
    ),
  );

  const parsed = yield* Effect.try({
    try: () => YAML.parse(raw) as KubeConfigFile,
    catch: (cause) =>
      new KubeConfigError({
        message: `Failed to parse kubeconfig at '${configPath}'`,
        cause,
      }),
  });

  const contextName = options.context ?? parsed["current-context"];
  if (!contextName) {
    return yield* Effect.fail(
      new KubeConfigError({
        message: `Kubeconfig '${configPath}' has no current-context — pass an explicit context`,
      }),
    );
  }

  const context = parsed.contexts?.find(
    (entry) => entry.name === contextName,
  )?.context;
  if (!context?.cluster) {
    return yield* Effect.fail(
      new KubeConfigError({
        message: `Context '${contextName}' not found in kubeconfig '${configPath}'`,
      }),
    );
  }

  const cluster = parsed.clusters?.find(
    (entry) => entry.name === context.cluster,
  )?.cluster;
  if (!cluster?.server) {
    return yield* Effect.fail(
      new KubeConfigError({
        message: `Cluster '${context.cluster}' (context '${contextName}') has no server in kubeconfig '${configPath}'`,
      }),
    );
  }

  const user =
    parsed.users?.find((entry) => entry.name === context.user)?.user ?? {};

  let certificateAuthorityData = cluster["certificate-authority-data"];
  if (!certificateAuthorityData && cluster["certificate-authority"]) {
    const caPath = yield* expandHome(cluster["certificate-authority"]);
    const pem = yield* fs.readFileString(caPath).pipe(
      Effect.mapError(
        (cause) =>
          new KubeConfigError({
            message: `Failed to read certificate authority file '${caPath}'`,
            cause,
          }),
      ),
    );
    certificateAuthorityData = Buffer.from(pem, "utf8").toString("base64");
  }

  return {
    endpoint: cluster.server,
    certificateAuthorityData,
    insecureSkipTlsVerify: cluster["insecure-skip-tls-verify"],
    user,
  } satisfies ResolvedKubeContext;
});

interface ExecCredentialStatus {
  token?: string;
  clientCertificateData?: string;
  clientKeyData?: string;
  expirationTimestamp?: string;
}

/** Credentials minted by a user's auth stanza for one request. */
export interface MintedCredentials {
  token?: string;
  clientCert?: { certificate: string; key: string };
}

// Exec plugin invocations are cached per (command, args) until their
// expirationTimestamp (or briefly, when the plugin doesn't declare one).
// Plain cached values, no finalizers — module scope is safe.
const execCache = new Map<
  string,
  { credentials: MintedCredentials; expiresAt: number }
>();

/**
 * Run a kubeconfig-style exec credential plugin and parse its
 * ExecCredential response.
 */
export const runExecCredential = Effect.fn(function* (options: {
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
}) {
  const cacheKey = JSON.stringify([
    options.command,
    options.args ?? [],
    options.env ?? {},
  ]);
  const cached = execCache.get(cacheKey);
  const now = yield* Effect.sync(() => Date.now());
  if (cached && cached.expiresAt > now) {
    return cached.credentials;
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The child process is scoped to this invocation: spawn, drain stdio,
  // and close the scope when the plugin exits.
  const result = yield* ChildProcess.make(options.command, options.args ?? [], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: false,
    extendEnv: true,
    env: options.env,
  }).pipe(
    spawner.spawn,
    Effect.flatMap((child) =>
      Effect.all(
        {
          exitCode: child.exitCode,
          stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
        },
        { concurrency: "unbounded" },
      ),
    ),
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.fail(
        new ExecCredentialError({
          message: `Failed to run exec credential plugin '${options.command}': ${String(cause)}`,
        }),
      ),
    ),
  );

  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new ExecCredentialError({
        message:
          `Exec credential plugin '${options.command} ${(options.args ?? []).join(" ")}' ` +
          `exited with code ${String(result.exitCode)}: ${result.stderr.trim()}`,
      }),
    );
  }

  const status = yield* Effect.try({
    try: () =>
      (JSON.parse(result.stdout) as { status?: ExecCredentialStatus }).status,
    catch: (cause) =>
      new ExecCredentialError({
        message: `Exec credential plugin '${options.command}' answered malformed JSON`,
        cause,
      }),
  });

  if (
    !status ||
    (!status.token && !(status.clientCertificateData && status.clientKeyData))
  ) {
    return yield* Effect.fail(
      new ExecCredentialError({
        message: `Exec credential plugin '${options.command}' returned no token or client certificate`,
      }),
    );
  }

  const credentials: MintedCredentials = {
    token: status.token,
    clientCert:
      status.clientCertificateData && status.clientKeyData
        ? {
            certificate: status.clientCertificateData,
            key: status.clientKeyData,
          }
        : undefined,
  };

  const expiresAt = status.expirationTimestamp
    ? // Re-mint 30s before the declared expiry.
      new Date(status.expirationTimestamp).getTime() - 30_000
    : // No declared expiry: cache briefly so bursts of requests share one
      // plugin invocation without holding a stale credential for long.
      now + 60_000;
  execCache.set(cacheKey, { credentials, expiresAt });

  return credentials;
});

/** Mint request credentials from a kubeconfig user's auth stanza. */
export const mintUserCredentials = Effect.fn(function* (user: KubeConfigUser) {
  if (user.exec?.command) {
    return yield* runExecCredential({
      command: user.exec.command,
      args: user.exec.args,
      env: user.exec.env
        ? Object.fromEntries(
            user.exec.env
              .filter(
                (entry): entry is { name: string; value: string } =>
                  typeof entry.name === "string" &&
                  typeof entry.value === "string",
              )
              .map((entry) => [entry.name, entry.value]),
          )
        : undefined,
    });
  }

  if (user.token) {
    return { token: user.token } satisfies MintedCredentials;
  }

  if (user.tokenFile) {
    const fs = yield* FileSystem.FileSystem;
    const tokenPath = yield* expandHome(user.tokenFile);
    const token = yield* fs.readFileString(tokenPath).pipe(
      Effect.mapError(
        (cause) =>
          new KubeConfigError({
            message: `Failed to read token file '${tokenPath}'`,
            cause,
          }),
      ),
    );
    return { token: token.trim() } satisfies MintedCredentials;
  }

  const certData = user["client-certificate-data"];
  const keyData = user["client-key-data"];
  if (certData && keyData) {
    return {
      clientCert: {
        certificate: decodeBase64(certData),
        key: decodeBase64(keyData),
      },
    } satisfies MintedCredentials;
  }

  const certPath = user["client-certificate"];
  const keyPath = user["client-key"];
  if (certPath && keyPath) {
    const fs = yield* FileSystem.FileSystem;
    const readPem = (file: string) =>
      expandHome(file).pipe(
        Effect.flatMap((resolved) =>
          fs.readFileString(resolved).pipe(
            Effect.mapError(
              (cause) =>
                new KubeConfigError({
                  message: `Failed to read credential file '${resolved}'`,
                  cause,
                }),
            ),
          ),
        ),
      );
    return {
      clientCert: {
        certificate: yield* readPem(certPath),
        key: yield* readPem(keyPath),
      },
    } satisfies MintedCredentials;
  }

  return yield* Effect.fail(
    new KubeConfigError({
      message:
        "Kubeconfig user has no supported auth stanza (token, tokenFile, " +
        "client certificate, or exec credential plugin)",
    }),
  );
});
