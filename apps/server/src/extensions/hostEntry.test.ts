// @effect-diagnostics nodeBuiltinImport:off -- Exercises emitted host resources with an ordinary Node subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

it.live(
  "materializes bundled workers outside app and server archives and repairs cached bytes",
  () =>
    Effect.promise(async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-extension-asar-"));
      const source = await NodeFSP.readFile(new URL("./hostEntry.ts", import.meta.url), "utf8");
      const run = NodeUtil.promisify(NodeChildProcess.execFile);
      try {
        for (const archive of ["app.asar", "server.asar"]) {
          const bundled = NodePath.join(directory, archive, "apps", "server", "dist");
          await NodeFSP.mkdir(bundled, { recursive: true });
          const entry = NodePath.join(bundled, "hostEntry.mjs");
          await NodeFSP.writeFile(entry, NodeModule.stripTypeScriptTypes(source));
          await NodeFSP.writeFile(
            NodePath.join(bundled, "hostMain.mjs"),
            'process.stdout.write("node-readable-worker");',
          );
          const cache = NodePath.join(directory, "hosts");
          const { stdout } = await run(process.execPath, [
            "--input-type=module",
            "-e",
            `
        import {execFileSync} from 'node:child_process';
        import assert from 'node:assert/strict';
        import {writeFile} from 'node:fs/promises';
        const {extensionHostEntry}=await import(process.argv[1]);
        const entry=await extensionHostEntry(process.argv[2]);
        assert(entry.startsWith(process.argv[2]), 'Bundled workers must be materialized outside the archive');
        const output=execFileSync(process.execPath,[entry],{encoding:'utf8'});
        await writeFile(entry,'corrupted');
        const restored=await extensionHostEntry(process.argv[2]);
        const repaired=execFileSync(process.execPath,[restored],{encoding:'utf8'});
        console.log(JSON.stringify({entry,restored,output,repaired}));
      `,
            NodeURL.pathToFileURL(entry).href,
            cache,
          ]);
          expect(JSON.parse(stdout)).toMatchObject({
            entry: expect.stringMatching(new RegExp(`^${cache.replaceAll("\\", "\\\\")}`)),
            output: "node-readable-worker",
            repaired: "node-readable-worker",
          });
        }
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    }),
);
