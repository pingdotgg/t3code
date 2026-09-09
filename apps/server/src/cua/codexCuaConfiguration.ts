import { Predicate } from "effect";
import { parse as parseToml } from "smol-toml";

const parsedConfigHasCuaDriver = (config: unknown): boolean =>
  Predicate.isObject(config) &&
  Predicate.isObject(config.mcp_servers) &&
  Object.hasOwn(config.mcp_servers, "cua-driver");

const overrideHasCuaDriver = (override: string): boolean => {
  try {
    return parsedConfigHasCuaDriver(parseToml(override));
  } catch {
    // Codex also accepts unquoted string values. Parse only the key in that case.
    const assignmentIndex = override.indexOf("=");
    if (assignmentIndex === -1) return true;
    try {
      const keyConfig = parseToml(`${override.slice(0, assignmentIndex)} = true`);
      // An unparseable replacement of the entire MCP table is ambiguous.
      return parsedConfigHasCuaDriver(keyConfig) || keyConfig.mcp_servers === true;
    } catch {
      return true;
    }
  }
};

/** Invalid configuration suppresses automatic injection so user configuration always wins. */
export const hasConfiguredCuaDriver = (
  argv: readonly string[],
  configToml: string | undefined,
): boolean => {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") break;
    if (argument === "-c" || argument === "--config") {
      const override = argv[index + 1];
      if (override === undefined || override.startsWith("-")) continue;
      if (overrideHasCuaDriver(override)) return true;
      index++;
    } else if (argument?.startsWith("--config=") || argument?.startsWith("-c=")) {
      if (overrideHasCuaDriver(argument.slice(argument.indexOf("=") + 1))) return true;
    } else if (argument?.startsWith("-c") && argument.length > 2) {
      if (overrideHasCuaDriver(argument.slice(2))) return true;
    }
  }

  if (configToml === undefined) return false;
  try {
    return parsedConfigHasCuaDriver(parseToml(configToml));
  } catch {
    return true;
  }
};

const tomlString = (value: string): string => JSON.stringify(value).replace(/\u007f/g, "\\u007f");

/** Returns argv directly; the inline table keeps environment keys out of Codex's dotted-key path. */
export const buildCuaDriverAppServerArgs = (descriptor: {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: readonly { readonly name: string; readonly value: string }[];
}): readonly string[] => {
  const args = descriptor.args.map(tomlString).join(", ");
  const environment = descriptor.environment
    .map(({ name, value }) => `${tomlString(name)} = ${tomlString(value)}`)
    .join(", ");
  return [
    "-c",
    `mcp_servers.cua-driver = { command = ${tomlString(descriptor.command)}, args = [${args}], env = { ${environment} } }`,
  ];
};
