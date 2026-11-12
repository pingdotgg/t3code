import type * as Cloudflare from "@alchemy.run/cloudflare";
import { DurableObject } from "cloudflare:workers";
import type { NativeAsyncWorker } from "./stack.ts";

const SLEEP_FOREVER = ["sleep", "infinity"];
const SEED_FILE = ["sh", "-c", "printf writable > /redeploy-marker"];
const READ_RELEASE_AND_SEED = [
  "sh",
  "-c",
  "cat /etc/alpine-release; cat /redeploy-marker 2>/dev/null || true",
];

const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);

/**
 * Each Container bound to this class adds its image to
 * `ctx.container.images` under the Container's id (see stack.ts).
 */
const IMAGE_KEYS = { shell: "AsyncShell", tools: "AsyncTools", lint: "AsyncLint" } as const;
const imageKey = (name: string | null) =>
  name === "tools" ? IMAGE_KEYS.tools : name === "lint" ? IMAGE_KEYS.lint : IMAGE_KEYS.shell;

/**
 * The plain-JS twin of `NativeObject` (object.ts): the same routes, written
 * against `this.ctx.container` directly instead of the Effect client.
 */
export class NativeAsyncObject extends DurableObject<{
  IMAGE_REVISION: string;
}> {
  /** Changes whenever the runtime re-creates this object. */
  private readonly incarnation = crypto.randomUUID();

  async fetch(request: Request) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/metadata":
        return Response.json(await this.metadata());
      case "/evict":
        // Throws, terminating this request; the test observes the new
        // incarnation on its next request.
        this.ctx.abort("container image eviction probe");
        return new Response("evicted");
      case "/revision":
        return new Response(this.env.IMAGE_REVISION);
      case "/probe":
        return Response.json(
          await this.probe({
            seed: url.searchParams.has("seed"),
            restart: url.searchParams.has("restart"),
            image: imageKey(url.searchParams.get("image")),
          }),
        );
      default:
        return Response.json(await this.exec(url.pathname));
    }
  }

  private get container() {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("No container is attached to this Durable Object.");
    }
    return container;
  }

  private async storedMarker() {
    return (await this.ctx.storage.get<string>("marker")) ?? null;
  }

  private async metadata() {
    return {
      id: this.ctx.id.toString(),
      incarnation: this.incarnation,
      images: this.container.images,
      stored: await this.storedMarker(),
    };
  }

  /** Report which image is running and whether the seeded file survived. */
  private async probe(options: { seed: boolean; restart: boolean; image: string }) {
    const container = this.container;
    if (options.restart) await container.destroy();

    const wasRunning = container.running;
    if (!wasRunning) {
      container.start({
        image: container.images[options.image],
        entrypoint: SLEEP_FOREVER,
        enableInternet: false,
      });
    }
    if (options.seed) {
      await this.ctx.storage.put("marker", "durable");
      await (await container.exec(SEED_FILE)).output();
    }

    const output = await (await container.exec(READ_RELEASE_AND_SEED)).output();
    const [release, file] = decode(output.stdout).split("\n");
    return {
      wasRunning,
      configured: container.images[options.image],
      inspected: (await container.inspect())?.image,
      release,
      file,
      stored: await this.storedMarker(),
    };
  }

  /**
   * Start the container if needed and run one command:
   * - `/stdin` echoes piped stdin through `cat`
   * - anything else prints "native" and exits 7
   *
   * `/builtin*` starts the managed image and `/image/<name>` the `shell` or
   * `tools` Container's image; every other path uses the `shell` image.
   */
  private async exec(path: string) {
    const container = this.container;
    if (!container.running) {
      container.start({
        image: this.imageFor(path),
        entrypoint: SLEEP_FOREVER,
        enableInternet: false,
        instance: "lite",
      });
    }

    let output;
    if (path === "/stdin") {
      const child = await container.exec(["cat"], { stdin: "pipe" });
      const writeStdin = async () => {
        const writer = child.stdin!.getWriter();
        await writer.write(new TextEncoder().encode("native stdin"));
        await writer.close();
      };
      [, output] = await Promise.all([writeStdin(), child.output()]);
    } else {
      const child = await container.exec(["sh", "-c", "printf native; exit 7"]);
      output = await child.output();
    }
    const release = await (
      await container.exec(["sh", "-c", "cat /etc/alpine-release || true"])
    ).output();

    return {
      stdout: decode(output.stdout),
      exitCode: output.exitCode,
      release: decode(release.stdout).trim(),
      images: Object.keys(container.images).sort(),
    };
  }

  private imageFor(path: string) {
    if (path.startsWith("/builtin")) return "cloudflare/debian-trixie";
    const key = imageKey(path.startsWith("/image/") ? path.slice("/image/".length) : "shell");
    const image = this.container.images[key];
    if (!image) throw new Error(`The ${key} image is not configured.`);
    return image;
  }
}

/**
 * A second class sharing the `AsyncShell` Container with `NativeAsyncObject`
 * and adding `AsyncLint`; `?class=reviewer` routes to it.
 */
export class NativeAsyncReviewer extends NativeAsyncObject {}

/** Routes that inspect the long-lived probe object rather than a fresh one. */
const PROBE_ROUTES = new Set(["/probe", "/revision", "/metadata", "/evict"]);

export default {
  async fetch(request: Request, env: Cloudflare.InferEnv<typeof NativeAsyncWorker>) {
    const url = new URL(request.url);
    if (url.pathname === "/ready") return new Response("ready");

    // `?object=` picks a specific object; probe routes share one object;
    // every other path gets an object of its own.
    const objectName =
      url.searchParams.get("object") ?? (PROBE_ROUTES.has(url.pathname) ? "/probe" : url.pathname);
    try {
      const namespace = url.searchParams.get("class") === "reviewer" ? env.REVIEWER : env.SANDBOX;
      return await namespace.getByName(objectName).fetch(request);
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
