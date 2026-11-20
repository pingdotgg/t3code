import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { WS_METHODS } from "@t3tools/contracts";

import type { ProbeContext } from "./connection.ts";
import { clip, rootCause } from "./format.ts";
import { createProject, launchThread, threadIdOf } from "./helpers.ts";

export async function checkF(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const project = await createProject(ctx, "check-f");
  const outside = NodePath.join(ctx.runDir, "outside-workspace");
  const inside = NodePath.join(project.root, "docs");
  for (const directory of [outside, inside]) {
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(directory, "f-probe.txt"), `file in ${directory}\n`);
  }
  const attempt = async (label: string, run: () => Promise<string>) => {
    try {
      evidence(`${label}: ok ${await run()}`);
      return true;
    } catch (error) {
      evidence(
        `${label}: error ${clip(rootCause(error instanceof Error ? error : new Error(String(error))), 300)}`,
      );
      return false;
    }
  };
  const readFile = (where: string, directory: string) =>
    attempt(
      `projects.readFile ${where} relativePath=${NodePath.join(directory, "f-probe.txt")}`,
      async () => {
        const result = await ctx.rpc.run((client) =>
          client[WS_METHODS.projectsReadFile]({
            cwd: project.root,
            relativePath: NodePath.join(directory, "f-probe.txt"),
          }),
        );
        return `contents ${JSON.stringify(result.contents)} byteLength ${result.byteLength}`;
      },
    );
  const listEntries = (where: string, directory: string) =>
    attempt(`projects.listEntries ${where} directoryPath=${directory}`, async () => {
      const result = await ctx.rpc.run((client) =>
        client[WS_METHODS.projectsListEntries]({
          cwd: project.root,
          directoryPath: directory,
        }),
      );
      return `entries ${JSON.stringify(result.entries.map((entry) => entry.path))}`;
    });
  const results = [
    await readFile("outside the project", outside),
    await readFile("inside the project", inside),
    await listEntries("outside the project", outside),
    await listEntries("inside the project", inside),
  ];
  // Informational: the forms a board would use instead, which the verdict does not gate on.
  await attempt('control projects.listEntries cwd=<project> directoryPath="docs"', async () => {
    const result = await ctx.rpc.run((client) =>
      client[WS_METHODS.projectsListEntries]({ cwd: project.root, directoryPath: "docs" }),
    );
    return `entries ${JSON.stringify(result.entries.map((entry) => entry.path))}`;
  });
  await attempt(`control projects.listEntries cwd=${outside} with no directoryPath`, async () => {
    const result = await ctx.rpc.run((client) =>
      client[WS_METHODS.projectsListEntries]({ cwd: outside }),
    );
    return `entries ${JSON.stringify(result.entries.map((entry) => entry.path))}`;
  });
  return results.every(Boolean);
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export async function checkG(
  ctx: ProbeContext,
  evidence: (line: string) => void,
): Promise<boolean> {
  const project = await createProject(ctx, "check-g");
  const threadId = await launchThread(ctx, project, { title: "probe G" });
  const outside = NodePath.join(ctx.runDir, "outside-workspace");
  NodeFS.mkdirSync(outside, { recursive: true });
  const file = NodePath.join(outside, "g-probe.png");
  NodeFS.writeFileSync(file, PNG_1X1);
  const created = await ctx.rpc.run((client) =>
    client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "media-file", threadId: threadIdOf(threadId), path: file },
    }),
  );
  evidence(
    `assets.createUrl media-file ${file} -> ${created.relativeUrl.replace(/^\/api\/assets\/[^/]+\//, "/api/assets/<signed>/")}`,
  );
  const plain = await fetch(`${ctx.origin}${created.relativeUrl}`);
  const body = Buffer.from(await plain.arrayBuffer());
  evidence(
    `GET without an Authorization header: HTTP ${plain.status}, ${plain.headers.get("content-type") ?? "no content-type"}, ${body.length} bytes, identical ${body.equals(PNG_1X1)}`,
  );
  const tampered = await fetch(
    `${ctx.origin}${created.relativeUrl.replace(/.$/, (last) => (last === "0" ? "1" : "0"))}`,
  );
  evidence(`GET with the last character of the URL changed: HTTP ${tampered.status}`);
  return plain.status === 200 && body.equals(PNG_1X1);
}
