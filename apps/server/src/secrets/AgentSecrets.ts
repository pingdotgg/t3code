import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Settings from "../serverSettings.ts";
import { runSecretProcess, type ProcessResult } from "./secretProcess.ts";

export class AgentSecretError extends Schema.TaggedError<AgentSecretError>()("AgentSecretError", {
  reason: Schema.Literals([
    "unshared_vault",
    "invalid_reference",
    "invalid_environment",
    "missing_token",
    "missing_binary",
    "op_failed",
    "invalid_output",
    "process_failed",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unshared_vault":
        return "Vault not shared with agents on this environment. Call secret_list for the shared vaults, or ask the user to add this one in Settings → Secrets → Agent vaults (Secret providers do not apply).";
      case "invalid_reference":
        return "Use an op://vault/item/field reference from secret_list (optionally /section/field).";
      case "invalid_environment":
        return "Use ordinary environment variable names, not OP_*, SSH_*, PATH, HOME, SHELL, USER, or PWD. Values must not contain NUL.";
      case "missing_token":
        return "This vault has no service-account token on this environment. Ask the user to set it in Settings → Secrets → Agent vaults; an op sign-in or Secret provider does not substitute.";
      case "missing_binary":
        return "Required executable missing on this environment's PATH. Ask the user to install the 1Password CLI (op) on this machine; no op sign-in or desktop app is needed. SSH keys also need ssh-agent and ssh-add.";
      case "op_failed":
        return "1Password could not read this vault or item. Check the reference with secret_list, then ask the user to check the vault's service-account token, read permissions, and network in Settings → Secrets → Agent vaults. Raw diagnostics withheld.";
      case "invalid_output":
        return "1Password returned invalid or oversized output. Raw output withheld.";
      case "process_failed":
        return "Could not run the command. Check the thread working directory and the server shell.";
    }
  }
}

const Field = Schema.Struct({
  label: Schema.optional(Schema.String),
  reference: Schema.optional(Schema.String),
  purpose: Schema.optional(Schema.String),
});
const Item = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.optional(Schema.String),
});
const decodeItems = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Item)));
const Detail = Schema.Struct({ fields: Schema.optional(Schema.Array(Field)) });
const decodeDetail = Schema.decodeEffect(Schema.fromJsonString(Detail));
export const SecretItem = Schema.Struct({
  vault: Schema.String,
  title: Schema.String,
  category: Schema.String,
  fields: Schema.Array(Schema.Struct({ label: Schema.String, reference: Schema.String })),
});
export const SecretRunResult = Schema.Struct({
  code: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
  stderr: Schema.String,
  timedOut: Schema.Boolean,
});

interface RunInput {
  readonly command: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly ssh_keys?: ReadonlyArray<string> | undefined;
  readonly timeout?: number | undefined;
}

export class AgentSecrets extends Context.Service<
  AgentSecrets,
  {
    readonly list: (
      vault?: string,
    ) => Effect.Effect<ReadonlyArray<typeof SecretItem.Type>, AgentSecretError>;
    readonly run: (input: RunInput) => Effect.Effect<ProcessResult, AgentSecretError>;
  }
>()("t3/secrets/AgentSecrets") {}

const referenceVault = (reference: string) => {
  const match =
    /^op:\/\/([^/?\x00-\x1f]+)\/[^/?\x00-\x1f]+(?:\/[^/?\x00-\x1f]+){1,2}(?:\?[^\s]*)?$/.exec(
      reference,
    );
  return match?.[1];
};

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const cleanEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !key.startsWith("OP_") && !key.startsWith("PI_1PASSWORD_") && key !== "SSH_AUTH_SOCK",
    ),
  );
  const execute = Effect.fn("AgentSecrets.execute")(function* (
    input: Omit<Parameters<typeof runSecretProcess>[0], "signal" | "platform">,
  ) {
    return yield* Effect.tryPromise({
      try: (signal) => runSecretProcess({ ...input, signal, platform }),
      catch: (cause) =>
        new AgentSecretError({
          reason:
            cause instanceof Error && cause.message === "missing_binary"
              ? "missing_binary"
              : cause instanceof Error && cause.message === "output_limit"
                ? "invalid_output"
                : "process_failed",
        }),
    });
  });
  const op = Effect.fn("AgentSecrets.op")(function* (token: string, args: ReadonlyArray<string>) {
    const env: NodeJS.ProcessEnv = { OP_SERVICE_ACCOUNT_TOKEN: token };
    for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "USER"])
      if (environment[key]) env[key] = environment[key];
    const spawn = yield* resolveSpawnCommand("op", ["--cache=false", ...args], { env });
    const result = yield* execute({
      file: spawn.command,
      args: spawn.args,
      shell: spawn.shell,
      env,
      timeoutMs: 30_000,
    });
    if (result.code !== 0 || result.timedOut)
      return yield* new AgentSecretError({ reason: "op_failed" });
    return result.stdout;
  });
  const tokenFor = Effect.fn("AgentSecrets.tokenFor")(function* (vault: string) {
    const vaults = (yield* settings.getSettings.pipe(
      Effect.mapError(() => new AgentSecretError({ reason: "missing_token" })),
    )).agentSecretVaults;
    if (!Object.hasOwn(vaults, vault))
      return yield* new AgentSecretError({ reason: "unshared_vault" });
    const token = vaults[vault]?.token;
    if (!token) return yield* new AgentSecretError({ reason: "missing_token" });
    return token;
  });
  const read = Effect.fn("AgentSecrets.read")(function* (reference: string) {
    const vault = referenceVault(reference);
    if (vault === undefined) return yield* new AgentSecretError({ reason: "invalid_reference" });
    return yield* op(yield* tokenFor(vault), ["read", "--no-newline", reference]);
  });
  const list = Effect.fn("AgentSecrets.list")(function* (vault?: string) {
    const vaults =
      vault === undefined
        ? Object.keys(
            (yield* settings.getSettings.pipe(
              Effect.mapError(() => new AgentSecretError({ reason: "missing_token" })),
            )).agentSecretVaults,
          )
        : [vault];
    return (yield* Effect.forEach(vaults, (name) =>
      Effect.gen(function* () {
        const token = yield* tokenFor(name);
        const items = yield* decodeItems(
          yield* op(token, ["item", "list", "--vault", name, "--format", "json"]),
        ).pipe(Effect.mapError(() => new AgentSecretError({ reason: "invalid_output" })));
        return yield* Effect.forEach(
          items.slice(0, 200),
          (item) =>
            Effect.gen(function* () {
              const detail = yield* decodeDetail(
                yield* op(token, ["item", "get", item.id, "--vault", name, "--format", "json"]),
              ).pipe(Effect.mapError(() => new AgentSecretError({ reason: "invalid_output" })));
              return {
                vault: name,
                title: item.title,
                category: item.category ?? "",
                fields: (detail.fields ?? []).flatMap((field) =>
                  field.reference &&
                  field.purpose !== "NOTES" &&
                  referenceVault(field.reference) !== undefined
                    ? [
                        {
                          label: field.label ?? "",
                          reference: field.reference.replace(/^op:\/\/[^/]+\//, `op://${name}/`),
                        },
                      ]
                    : [],
                ),
              };
            }),
          { concurrency: 4 },
        );
      }),
    )).flat();
  });
  const run = Effect.fn("AgentSecrets.run")(function* (input: RunInput) {
    const env = { ...cleanEnvironment };
    const values: string[] = [];
    const entries = Object.entries(input.env ?? {});
    // Validate every reference before reading any secret.
    const references = [...entries.map(([, ref]) => ref), ...(input.ssh_keys ?? [])];
    for (const ref of references) {
      const vault = referenceVault(ref);
      if (vault === undefined) return yield* new AgentSecretError({ reason: "invalid_reference" });
      yield* tokenFor(vault);
    }
    for (const [name, ref] of entries) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
        /^(OP_|SSH_|PI_1PASSWORD_)/.test(name) ||
        ["PATH", "HOME", "SHELL", "USER", "PWD"].includes(name)
      )
        return yield* new AgentSecretError({ reason: "invalid_environment" });
      const value = yield* read(ref);
      if (value.includes("\0"))
        return yield* new AgentSecretError({ reason: "invalid_environment" });
      env[name] = value;
      values.push(value);
    }
    const timeoutMs = Math.min(1800, Math.max(1, input.timeout ?? 120)) * 1000;
    const keys = yield* Effect.forEach(input.ssh_keys ?? [], read);
    values.push(...keys);
    // ssh-agent's command mode owns its lifetime; keys travel over stdin, never files or argv.
    const ssh = keys.length > 0;
    if (ssh && platform === "win32")
      return yield* new AgentSecretError({ reason: "missing_binary" });
    const socketDir = ssh
      ? yield* fs
          .makeTempDirectoryScoped({ directory: "/tmp", prefix: "t3-op-" })
          .pipe(Effect.mapError(() => new AgentSecretError({ reason: "process_failed" })))
      : undefined;
    const bootstrap = `
key=
count=0
while IFS= read -r line; do
  key="$key$line
"
  if [ "$line" = "-----END OPENSSH PRIVATE KEY-----" ]; then
    printf '%s' "$key" | ssh-add -q - >/dev/null 2>&1 || { printf '%s\\n' 'ssh-add refused the private key; use an unencrypted OpenSSH key.' >&2; exit 125; }
    key=
    count=$((count + 1))
  fi
done
[ "$count" = "$2" ] && [ -z "$key" ] || { printf '%s\\n' 'Use unencrypted OpenSSH private keys.' >&2; exit 125; }
exec /bin/sh -c "$1"
`;
    return yield* execute({
      file: ssh ? "ssh-agent" : platform === "win32" ? "cmd.exe" : "/bin/sh",
      args: ssh
        ? [
            "-a",
            `${socketDir}/s`,
            "-t",
            String(Math.ceil(timeoutMs / 1000) + 60),
            "/bin/sh",
            "-c",
            bootstrap,
            "t3-secret-run",
            input.command,
            String(keys.length),
          ]
        : platform === "win32"
          ? ["/d", "/s", "/c", input.command]
          : ["-c", input.command],
      cwd: input.cwd,
      env,
      timeoutMs,
      mask: values,
      ...(ssh
        ? { stdin: keys.map((key) => (key.endsWith("\n") ? key : `${key}\n`)).join("") }
        : {}),
    });
  }, Effect.scoped);

  return AgentSecrets.of({ list, run });
});

export const layer = Layer.effect(AgentSecrets, make);
