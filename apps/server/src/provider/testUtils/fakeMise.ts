// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface FakeMiseInstall {
  readonly version: string;
  readonly install_path: string;
  readonly requested_version?: string;
  readonly active: boolean;
}

export interface FakeMiseCall {
  readonly dataDir: string;
  readonly args: string;
}

/**
 * A POSIX `mise` stand-in for maintenance tests. It answers `which <bin>`,
 * `ls`, `outdated`, and `tool --backend` with the given JSON, or raw text when given a string
 * (a missing answer exits 1), and
 * records each call with the `MISE_DATA_DIR` it ran with, so a test proves
 * which mise ran, with which arguments, in which environment.
 */
export function installFakeMise(
  misePath: string,
  answers: {
    readonly which?: Readonly<Record<string, string>>;
    readonly ls?: string | Readonly<Record<string, ReadonlyArray<FakeMiseInstall>>>;
    readonly outdated?: string | Readonly<Record<string, { readonly latest: string }>>;
    /** `mise tool --backend <tool>` answers, by tool name. */
    readonly backends?: Readonly<Record<string, string>>;
  },
) {
  const stateDir = `${misePath}.state`;
  NodeFS.mkdirSync(NodePath.dirname(misePath), { recursive: true });
  NodeFS.mkdirSync(stateDir, { recursive: true });
  for (const [bin, path] of Object.entries(answers.which ?? {})) {
    NodeFS.writeFileSync(NodePath.join(stateDir, `which-${bin}`), `${path}\n`);
  }
  for (const [tool, backend] of Object.entries(answers.backends ?? {})) {
    NodeFS.writeFileSync(NodePath.join(stateDir, `backend-${tool}`), `${backend}\n`);
  }
  for (const [name, answer] of [
    ["ls", answers.ls],
    ["outdated", answers.outdated],
  ] as const) {
    if (answer === undefined) continue;
    NodeFS.writeFileSync(
      NodePath.join(stateDir, name),
      typeof answer === "string" ? answer : JSON.stringify(answer),
    );
  }
  NodeFS.writeFileSync(
    misePath,
    [
      "#!/bin/sh",
      // Tests may run it with an empty PATH.
      "PATH=/usr/bin:/bin",
      `state='${stateDir}'`,
      `printf '%s\\t%s\\n' "\${MISE_DATA_DIR:-}" "$*" >> "$state/calls"`,
      'case "$1" in',
      // `which [--tool <spec>] <bin>`: the bin is the last argument.
      '  which) for bin; do :; done; answer="$state/which-$bin" ;;',
      '  ls) answer="$state/ls" ;;',
      '  tool) for tool; do :; done; answer="$state/backend-$tool" ;;',
      '  outdated) answer="$state/outdated" ;;',
      "  upgrade) exit 0 ;;",
      "  *) exit 2 ;;",
      "esac",
      '[ -f "$answer" ] || exit 1',
      'cat "$answer"',
      "",
    ].join("\n"),
  );
  NodeFS.chmodSync(misePath, 0o755);
  return {
    misePath,
    calls: (): ReadonlyArray<FakeMiseCall> => {
      const log = NodePath.join(stateDir, "calls");
      if (!NodeFS.existsSync(log)) return [];
      return NodeFS.readFileSync(log, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          const [dataDir = "", args = ""] = line.split("\t");
          return { dataDir, args };
        });
    },
  };
}
