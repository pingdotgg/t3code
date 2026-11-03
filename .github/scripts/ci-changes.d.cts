interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly hasTest: boolean;
  readonly deps: ReadonlyArray<string>;
}

export function readWorkspace(): Array<WorkspacePackage>;

export function decide(
  files: ReadonlyArray<string> | null,
  packages: ReadonlyArray<WorkspacePackage>,
  full: boolean,
): {
  affected: Array<string>;
  outputs: {
    typecheck: boolean;
    build: boolean;
    test: boolean;
    test_packages: string;
    test_web: boolean;
    test_server: boolean;
    rust: boolean;
    release_smoke: boolean;
    mobile_native: boolean;
  };
};
