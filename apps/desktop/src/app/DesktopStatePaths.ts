import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  if (Option.isSome(input.t3Home)) {
    const trimmed = input.t3Home.value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return input.joinPath(input.homeDirectory, ".t3");
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
}): string {
  return input.joinPath(input.baseDir, input.isDevelopment ? "dev" : "userdata");
}
