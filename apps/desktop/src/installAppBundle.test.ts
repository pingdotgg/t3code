import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

afterEach(() => {
  for (const path of fixtures.splice(0)) {
    FS.rmSync(path, { recursive: true, force: true });
  }
});

describe("Dev app bundle installation", () => {
  it("preserves the current install when staging copy fails", () => {
    const fixture = makeFixture();
    const result = install(fixture, { DITTO_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(readInstall(fixture.destination)).toBe("previous");
    expect(stagingDirectories(fixture.parent)).toEqual([]);
  });

  it("restores the current install when moving it to backup reports failure", () => {
    const fixture = makeFixture();
    const result = install(fixture, { FAIL_BACKUP_MOVE_AFTER_MOVE: "1" });

    expect(result.status).not.toBe(0);
    expect(readInstall(fixture.destination)).toBe("previous");
    expect(stagingDirectories(fixture.parent)).toEqual([]);
    expect(previousDirectories(fixture.parent)).toEqual([]);
  });

  it("restores the previous install when swapping the staged bundle fails", () => {
    const fixture = makeFixture();
    const result = install(fixture, { FAIL_STAGE_SWAP: "1" });

    expect(result.status).not.toBe(0);
    expect(readInstall(fixture.destination)).toBe("previous");
    expect(stagingDirectories(fixture.parent)).toEqual([]);
    expect(previousDirectories(fixture.parent)).toEqual([]);
  });

  it("rolls back when a failed swap leaves a partial destination", () => {
    const fixture = makeFixture();
    const result = install(fixture, { FAIL_STAGE_SWAP_AFTER_MOVE: "1" });

    expect(result.status).not.toBe(0);
    expect(readInstall(fixture.destination)).toBe("previous");
    expect(stagingDirectories(fixture.parent)).toEqual([]);
    expect(previousDirectories(fixture.parent)).toEqual([]);
  });

  it("replaces the install only after a valid staged bundle is ready", () => {
    const fixture = makeFixture();
    const result = install(fixture);

    expect(result.status).toBe(0);
    expect(readInstall(fixture.destination)).toBe("replacement");
    expect(stagingDirectories(fixture.parent)).toEqual([]);
    expect(previousDirectories(fixture.parent)).toEqual([]);
  });
});

function makeFixture(): { parent: string; source: string; destination: string; helper: string } {
  const parent = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3code-install-bundle-"));
  fixtures.push(parent);
  const source = Path.join(parent, "replacement.app");
  const destination = Path.join(parent, "T3 Code (Dev).app");
  const helper = Path.resolve(import.meta.dirname, "../../../scripts/install-app-bundle.sh");
  writeBundle(source, "replacement");
  writeBundle(destination, "previous");
  return { parent, source, destination, helper };
}

function writeBundle(bundle: string, version: string): void {
  const contents = Path.join(bundle, "Contents");
  FS.mkdirSync(Path.join(contents, "MacOS"), { recursive: true });
  FS.writeFileSync(Path.join(contents, "Info.plist"), `<plist>${version}</plist>\n`);
  FS.writeFileSync(Path.join(contents, "MacOS", "T3 Code"), version, { mode: 0o755 });
}

function install(
  fixture: ReturnType<typeof makeFixture>,
  extraEnvironment: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const command = `
    source "$HELPER"
    mv() {
      if [[ "\${FAIL_STAGE_SWAP:-}" == 1 && "$1" == *".staging."* && "$2" == "$DESTINATION" ]]; then
        return 29
      fi
      if [[ "\${FAIL_STAGE_SWAP_AFTER_MOVE:-}" == 1 && "$1" == *".staging."* && "$2" == "$DESTINATION" ]]; then
        command mv "$@" || return $?
        return 29
      fi
      if [[ "\${FAIL_BACKUP_MOVE_AFTER_MOVE:-}" == 1 && "$1" == "$DESTINATION" && "$2" == *".previous."* ]]; then
        command mv "$@" || return $?
        return 29
      fi
      command mv "$@"
    }
    staged="$(stage_app_bundle "$SOURCE" "$DESTINATION")" || exit $?
    replace_staged_app_bundle "$staged" "$DESTINATION"
  `;
  const stubDirectory = Path.join(fixture.parent, "bin");
  FS.mkdirSync(stubDirectory);
  FS.writeFileSync(
    Path.join(stubDirectory, "ditto"),
    '#!/bin/bash\n[[ "${DITTO_FAIL:-}" != 1 ]] || exit 23\ncp -R "$1"/. "$2"/\n',
    { mode: 0o755 },
  );
  try {
    const stdout = execFileSync("bash", ["-c", command], {
      cwd: fixture.parent,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${stubDirectory}:${process.env.PATH ?? ""}`,
        HELPER: fixture.helper,
        SOURCE: fixture.source,
        DESTINATION: fixture.destination,
        ...extraEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      status: failure.status ?? 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
}

function readInstall(destination: string): string {
  return (
    FS.readFileSync(Path.join(destination, "Contents", "Info.plist"), "utf8").match(
      /<plist>(.*?)<\/plist>/,
    )?.[1] ?? ""
  );
}

function stagingDirectories(parent: string): string[] {
  return FS.readdirSync(parent).filter((name) => name.includes(".staging."));
}

function previousDirectories(parent: string): string[] {
  return FS.readdirSync(parent).filter((name) => name.includes(".previous."));
}
