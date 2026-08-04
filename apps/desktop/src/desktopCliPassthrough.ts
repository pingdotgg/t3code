import * as Path from "node:path";

export interface DesktopCliPassthrough {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}

export function resolveDesktopCliPassthrough(input: {
  readonly argv: ReadonlyArray<string>;
  readonly backendEntry: string;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
}): DesktopCliPassthrough | null {
  const resolvedBackendEntry = Path.resolve(input.backendEntry);
  const entryIndex = input.argv.findIndex(
    (argument, index) => index > 0 && Path.resolve(argument) === resolvedBackendEntry,
  );
  if (entryIndex === -1) {
    return null;
  }

  return {
    command: input.execPath,
    args: input.argv.slice(entryIndex),
    env: {
      ...input.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}
