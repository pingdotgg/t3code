import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DurableObjectNamespace from "../../bindings/DurableObjectNamespace.ts";
import { docker } from "../helpers/docker.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const script = `
import { DurableObject } from "cloudflare:workers";
export class Sandbox extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    const path = new URL(request.url).pathname;
    if (path === "/images") return Response.json(container.images);
    if (path === "/stdin") {
      const process = await container.exec(["cat"], { stdin: "pipe" });
      const writer = process.stdin.getWriter();
      const [, output] = await Promise.all([
        writer.write(new TextEncoder().encode("input".repeat(65536))).then(() => writer.close()),
        process.output(),
      ]);
      return new Response(output.stdout);
    }
    if (path === "/snapshot") {
      const write = await container.exec(["sh", "-c", "printf persisted > /workspace-file"]);
      await write.output();
      const snapshot = await container.snapshotContainer({ name: "workspace" });
      await container.destroy();
      container.start({ containerSnapshot: snapshot, entrypoint: ["sleep", "infinity"], enableInternet: false });
      const restored = await (await container.exec(["cat", "/workspace-file"])).output();
      return new Response(restored.stdout);
    }
    await container.destroy();
    container.start({ image: path === "/builtin" ? "cloudflare/debian-trixie" : container.images[path.slice(1)], entrypoint: ["sleep", "infinity"], enableInternet: false });
    const process = await container.exec(["sh", "-c", "printf hello; printf error >&2; exit 7"]);
    const output = await process.output();
    return Response.json({ stdout: new TextDecoder().decode(output.stdout), stderr: new TextDecoder().decode(output.stderr), exitCode: output.exitCode });
  }
}
export default { fetch(request, env) { return env.SANDBOX.getByName("workspace").fetch(request); } };
`;

const dockerLines = (...args: string[]) =>
  docker(...args).pipe(
    Effect.map((stdout) => stdout.split("\n").filter((line) => line.trim() !== "")),
  );
const workerContainers = dockerLines(
  "ps",
  "--all",
  "--format",
  "{{.Names}}",
  "--filter",
  "name=^workerd-native-container-",
);
const snapshotImages = dockerLines(
  "images",
  "--quiet",
  "--filter",
  "reference=workerd-container-snap-*",
);

it.live(
  "native container images: selects named images, executes processes, restores a snapshot, and removes every container on shutdown",
  () =>
    Effect.gen(function* () {
      const snapshotsBefore = new Set(yield* snapshotImages);
      yield* Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "native-container-images",
          compatibilityDate: "2026-09-18",
          compatibilityFlags: [],
          bindings: [
            DurableObjectNamespace.local({
              binding: "SANDBOX",
              className: "Sandbox",
            }),
          ],
          modules: [{ name: "main.js", type: "ESModule", content: script }],
          durableObjectNamespaces: [
            {
              className: "Sandbox",
              sql: true,
              container: {
                images: {
                  alpine: { imageUri: "alpine:3.21" },
                  "alpine:3.21": { imageUri: "alpine:3.21" },
                },
              },
            },
          ],
        });
        const images = yield* worker.fetchJson<Record<string, string>>("/images");
        expect(Object.keys(images).sort()).toEqual(["alpine", "alpine:3.21"]);
        for (const name of ["alpine", "alpine:3.21"]) {
          expect(yield* worker.fetchJson(`/${name}`)).toEqual({
            stdout: "hello",
            stderr: "error",
            exitCode: 7,
          });
        }
        expect(yield* worker.fetchText("/snapshot")).toBe("persisted");
        expect(yield* worker.fetchText("/stdin")).toBe("input".repeat(65536));
        const builtin = yield* startTestWorker({
          name: "native-container-no-images",
          compatibilityDate: "2026-09-18",
          compatibilityFlags: [],
          bindings: [
            DurableObjectNamespace.local({
              binding: "SANDBOX",
              className: "Sandbox",
            }),
          ],
          modules: [{ name: "main.js", type: "ESModule", content: script }],
          durableObjectNamespaces: [{ className: "Sandbox", sql: true, container: { images: {} } }],
        });
        expect(yield* builtin.fetchJson("/images")).toEqual({});
        expect(yield* builtin.fetchJson("/builtin")).toEqual({
          stdout: "hello",
          stderr: "error",
          exitCode: 7,
        });
      }).pipe(Effect.provide(localRuntimeLayer), Effect.scoped);
      // Snapshot restores and managed images start containers from images the
      // runtime never prepared; shutdown must still remove all of them.
      expect(yield* workerContainers).toEqual([]);
      const created = (yield* snapshotImages).filter((id) => !snapshotsBefore.has(id));
      if (created.length > 0) yield* docker("rmi", "--force", ...new Set(created));
    }),
  { timeout: 120_000 },
);
