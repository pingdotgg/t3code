import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseBuildOutput,
  readBuildOutput,
  sortServerModules,
  stringifyBuildOutput,
  toOutputFile,
  writeBuildOutput,
  type BuildOutput,
} from "../index.ts";
import { makeProject, run } from "./helpers.ts";

describe("toOutputFile", () => {
  it("hashes string content with sha256", async () => {
    const file = await run(toOutputFile("index.js", "export default {};"));
    expect(file.hash).toBe(
      // sha256("export default {};")
      "9f085b1079ab38f776bbb3930dfd067a838ca3e0483aff8625f88837e8ed964c",
    );
  });

  it("normalizes binary content to Buffer", async () => {
    const file = await run(toOutputFile("data.bin", new Uint8Array([1, 2, 3])));
    expect(Buffer.isBuffer(file.content)).toBe(true);
  });
});

describe("sortServerModules", () => {
  it("puts the entry first and sorts the rest", () => {
    const modules = [
      { name: "server/z.js", content: "", hash: "" },
      { name: "server/index.js", content: "", hash: "" },
      { name: "server/a.js", content: "", hash: "" },
    ];
    expect(
      sortServerModules(modules, "server/index.js").map(
        (module) => module.name,
      ),
    ).toEqual(["server/index.js", "server/a.js", "server/z.js"]);
  });
});

describe("build output persistence", () => {
  it("round-trips string and binary content and the workspaces Set", async () => {
    const root = await makeProject({});
    const path = NodePath.join(root, "build.json");
    const output: BuildOutput = {
      distDirectory: "/project/dist",
      clientDirectory: "/project/dist/client",
      serverModules: [
        await run(toOutputFile("server/index.js", "export default {};")),
        await run(
          toOutputFile("server/data.bin", new Uint8Array([0, 1, 2, 255])),
        ),
      ],
      externalWorkspaces: new Set(["/workspaces/b", "/workspaces/a"]),
    };
    await run(writeBuildOutput(path, output));
    const parsed = await run(readBuildOutput(path));
    expect(parsed.distDirectory).toBe(output.distDirectory);
    expect(parsed.clientDirectory).toBe(output.clientDirectory);
    expect(parsed.serverModules).toHaveLength(2);
    expect(parsed.serverModules![0]!.content).toBe("export default {};");
    const binary = parsed.serverModules![1]!;
    expect(Buffer.isBuffer(binary.content)).toBe(true);
    expect(Array.from(binary.content as Buffer)).toEqual([0, 1, 2, 255]);
    expect(binary.hash).toBe(output.serverModules![1]!.hash);
    expect(parsed.externalWorkspaces).toEqual(
      new Set(["/workspaces/a", "/workspaces/b"]),
    );
  });

  it("creates the target's parent directory when it does not exist", async () => {
    const root = await makeProject({});
    // Nested-root shape: the framework built into app/dist, so <root>/dist
    // does not exist when the harness persists build.json.
    const path = NodePath.join(root, "dist", "build.json");
    const output: BuildOutput = {
      clientDirectory: undefined,
      serverModules: undefined,
      externalWorkspaces: new Set(["/workspaces/lib"]),
    };
    await run(writeBuildOutput(path, output));
    const parsed = await run(readBuildOutput(path));
    expect(parsed.externalWorkspaces).toEqual(new Set(["/workspaces/lib"]));
  });

  it("serializes Sets as sorted arrays", () => {
    const json = stringifyBuildOutput({
      clientDirectory: undefined,
      serverModules: undefined,
      externalWorkspaces: new Set(["/b", "/a"]),
    });
    expect(JSON.parse(json).externalWorkspaces).toEqual(["/a", "/b"]);
  });

  it("tolerates the legacy `{}` externalWorkspaces serialization", () => {
    const parsed = parseBuildOutput(
      JSON.stringify({
        clientDirectory: "/dist/client",
        externalWorkspaces: {},
      }),
    );
    expect(parsed.externalWorkspaces).toEqual(new Set());
  });
});
