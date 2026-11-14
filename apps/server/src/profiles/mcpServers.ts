import {
  isSecretReference,
  type ProfileMcpServer,
  type ProfileMcpValue,
  type SecretReference,
} from "@t3tools/contracts";
import type { ProfileMcpServerLaunch } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Drivers that can add a profile's MCP servers to one session. */
export const PROFILE_MCP_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * The servers a session opens with, secrets read. Fails with a message for the user rather than
 * starting a server without its credentials or running a command this machine has not allowed.
 */
export const resolveProfileMcpServers = Effect.fn("Profiles.resolveMcpServers")(function* (input: {
  readonly servers: Readonly<Record<string, ProfileMcpServer>>;
  readonly allowCommands: boolean;
  readonly resolver: Option.Option<SecretResolver.SecretResolver["Service"]>;
}) {
  const entries = Object.entries(input.servers);
  const commands = entries.flatMap(([name, server]) => ("command" in server ? [name] : []));
  if (commands.length > 0 && !input.allowCommands)
    return yield* Effect.fail(
      `This profile runs MCP commands (${commands.join(", ")}). Turn on Allow MCP commands in Settings → Profiles on this machine, or remove them from the profile.`,
    );
  const references: SecretReference[] = [];
  const owners: string[] = [];
  for (const [name, server] of entries)
    for (const value of Object.values(
      "command" in server ? (server.env ?? {}) : (server.headers ?? {}),
    ))
      if (isSecretReference(value)) {
        references.push(value);
        owners.push(name);
      }
  const values =
    references.length === 0
      ? []
      : Option.isSome(input.resolver)
        ? yield* input.resolver.value.read(references)
        : references.map(() => undefined);
  const secrets = new Map<SecretReference, string>();
  for (const [index, reference] of references.entries()) {
    const value = values[index];
    if (value === undefined || value.trim() === "") {
      const provider = Option.isSome(input.resolver)
        ? yield* input.resolver.value.label(reference.provider)
        : reference.provider;
      return yield* Effect.fail(
        `MCP server ${owners[index]} could not read its credential from the secret provider "${provider}". Unlock or fix it in Settings, then try again.`,
      );
    }
    secrets.set(reference, value);
  }
  const literal = (values: Readonly<Record<string, ProfileMcpValue>> | undefined) =>
    Object.fromEntries(
      Object.entries(values ?? {}).map(([key, value]) => [
        key,
        isSecretReference(value) ? secrets.get(value)! : value,
      ]),
    );
  return Object.fromEntries(
    entries.map(([name, server]): [string, ProfileMcpServerLaunch] => [
      name,
      "command" in server
        ? {
            type: "stdio",
            command: server.command,
            args: server.args ?? [],
            env: literal(server.env),
          }
        : { type: "http", url: server.url, headers: literal(server.headers) },
    ]),
  );
});
