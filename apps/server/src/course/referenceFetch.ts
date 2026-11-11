// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off globalTimers:off schemaClassMissingBrand:off
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeModule from "node:module";
import type * as Undici from "undici";
import { isPublicFaviconHost } from "@t3tools/shared/hostClassification";
import { auditDownload, type DownloadAuditContext } from "./downloadAudit.ts";

// undici is external to the CLI bundle; Node single-executables can load it from disk only with require.
const undici = () => NodeModule.createRequire(import.meta.url)("undici") as typeof Undici;
export { encodeGrayscalePng } from "./course-pdf-worker.ts";

export class CourseReferenceFetchError extends Schema.TaggedError<CourseReferenceFetchError>()(
  "CourseReferenceFetchError",
  { message: Schema.String },
) {}

class ReferenceBlockedError extends Schema.TaggedError<ReferenceBlockedError>()(
  "ReferenceBlockedError",
  { reason: Schema.String },
) {}
const isReferenceBlockedError = Schema.is(ReferenceBlockedError);

export interface ReferenceImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
}

export interface ReferenceFetchResult {
  readonly url: string;
  readonly title?: string;
  readonly text?: string;
  readonly links?: ReadonlyArray<{ readonly text: string; readonly href: string }>;
  readonly pageCount?: number;
  readonly pages?: ReadonlyArray<{ readonly page: number; readonly text: string }>;
  readonly images?: ReadonlyArray<ReferenceImage>;
}

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const PDF_TIMEOUT_MS = 30_000;

const validateUrl = (raw: string | URL) => {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    throw new ReferenceBlockedError({
      reason: "Only public http(s) URLs without userinfo are allowed.",
    });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
    throw new ReferenceBlockedError({
      reason: "Only public http(s) URLs without userinfo are allowed.",
    });
  if (!isPublicFaviconHost(url.hostname))
    throw new ReferenceBlockedError({ reason: "The URL host is not public." });
  return url;
};

type DispatcherLookup = (
  host: string,
  options: { readonly all?: boolean },
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | ReadonlyArray<{ address: string; family: number }>,
    family?: number,
  ) => void,
) => void;

export const checkedDispatcher = async (
  hostname: string,
  lookup: typeof NodeDnsPromises.lookup = NodeDnsPromises.lookup,
) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const blocked =
    !addresses.length || addresses.some(({ address }) => !isPublicFaviconHost(address));
  const address = addresses[0]!;
  const pinnedLookup: DispatcherLookup = (_host, options, callback) =>
    options?.all
      ? callback(
          null,
          addresses.map(({ address: value, family }) => ({ address: value, family })),
        )
      : callback(null, address.address, address.family);
  return {
    ips: addresses.map(({ address }) => address),
    connectLookup: pinnedLookup,
    dispatcher: blocked
      ? undefined
      : new (undici().Agent)({
          connect: { lookup: pinnedLookup as never },
        }),
    blocked,
  };
};

const readBody = async (response: Response) => {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new Error("Response exceeds the 25 MB limit.");
  if (!response.body) throw new Error("Response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_BYTES) throw new Error("Response exceeds the 25 MB limit.");
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
};

const driveRewrite = (url: URL) => {
  const match = url.pathname.match(/^\/file\/d\/([^/]+)(?:\/|$)/);
  if (!match || !url.hostname.endsWith("google.com")) return url;
  return new URL(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(match[1]!)}`);
};

const workerScript = () =>
  import.meta.url.endsWith(".ts")
    ? NodePath.resolve(new URL("./course-pdf-worker.ts", import.meta.url).pathname)
    : // The server is bundled at dist/; the worker entry is emitted under dist/course/.
      NodePath.resolve(new URL("./course/course-pdf-worker.mjs", import.meta.url).pathname);

const childRssBytes = async (pid: number): Promise<number | undefined> => {
  // The watchdog is deliberately outside Effect so it can kill a blocked worker.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- inspect the host platform for RSS polling.
  if (process.platform === "linux") {
    try {
      const statm = await NodeFSP.readFile(`/proc/${pid}/statm`, "utf8");
      return Number(statm.trim().split(/\s+/)[1]) * 4096;
    } catch {
      return undefined;
    }
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- inspect the host platform for RSS polling.
  if (process.platform === "darwin") {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) =>
      execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) =>
        resolve(error ? undefined : Number(stdout.trim()) * 1024),
      ),
    );
  }
  // Windows has no portable RSS query here; its extraction guard is the timeout.
  return undefined;
};

const runPdfWorker = async (
  bytes: Uint8Array,
  requested: ReadonlyArray<number>,
  spawnImpl: typeof NodeChildProcess.spawn = NodeChildProcess.spawn,
  limits: {
    readonly timeoutMs?: number;
    readonly rssLimitBytes?: number;
    readonly pollMs?: number;
    readonly readRss?: (pid: number) => Promise<number | undefined>;
  } = {},
) => {
  // A single executable hosts the worker itself; a built server runs the sibling script.
  const args = import.meta.url.endsWith(".ts")
    ? ["--experimental-strip-types", workerScript()]
    : NodeSea.isSea()
      ? ["__course-pdf"]
      : [workerScript()];
  const child = spawnImpl(process.execPath, args, {
    // Unread stderr would fill and block the child on pdf.js warnings.
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const output: Buffer[] = [];
  child.stdout?.on("data", (value: Buffer) => output.push(value));
  // A child that dies before reading its input must fail this fetch, not the server.
  child.stdin?.on("error", () => {});
  child.stdin?.end(
    JSON.stringify({ bytes: Buffer.from(bytes).toString("base64"), pages: requested }),
  );
  let killed = false;
  const kill = () => {
    if (child.exitCode === null && !child.killed) {
      killed = true;
      child.kill("SIGKILL");
    }
  };
  const timer = setTimeout(kill, limits.timeoutMs ?? PDF_TIMEOUT_MS);
  const rssTimer = setInterval(() => {
    void (limits.readRss?.(child.pid ?? 0) ?? childRssBytes(child.pid ?? 0)).then((rss) => {
      if (rss !== undefined && rss > (limits.rssLimitBytes ?? 1.5 * 1024 * 1024 * 1024)) kill();
    });
  }, limits.pollMs ?? 200);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve(status));
    });
    if (killed || code !== 0) throw new Error("PDF too large or slow to read");
    return JSON.parse(Buffer.concat(output).toString("utf8")) as Omit<ReferenceFetchResult, "url">;
  } finally {
    clearTimeout(timer);
    clearInterval(rssTimer);
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
};

export const extractPdf = runPdfWorker;

export const fetchCourseReference = Effect.fn("course.fetchReference")(function* (input: {
  readonly url: string;
  readonly pages?: ReadonlyArray<number>;
  readonly fetchImpl?: typeof fetch;
  readonly lookup?: typeof NodeDnsPromises.lookup;
  readonly audit?: DownloadAuditContext;
}): Generator<
  Effect.Effect<ReferenceFetchResult, CourseReferenceFetchError>,
  ReferenceFetchResult,
  never
> {
  return yield* Effect.tryPromise({
    try: async () => {
      const fetchImpl: typeof fetch =
        input.fetchImpl ?? (undici().fetch as unknown as typeof fetch);
      let url = new URL("http://invalid.local/");
      let response: Response | undefined;
      const hops: { url: string; status: number | null; ips: string[] }[] = [];
      let body: Buffer | undefined;
      let failure: unknown;
      try {
        url = driveRewrite(validateUrl(input.url));
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
          const existingHop = hops.at(-1)?.url === url.toString() ? hops.at(-1) : undefined;
          const checked = await checkedDispatcher(
            url.hostname.replace(/^\[|\]$/g, ""),
            input.lookup,
          );
          const hopEntry = existingHop ?? { url: url.toString(), status: null, ips: checked.ips };
          hopEntry.ips = checked.ips;
          if (!existingHop) hops.push(hopEntry);
          if (checked.blocked)
            throw new ReferenceBlockedError({
              reason: "The URL resolves to a private network address.",
            });
          response = await fetchImpl(url.toString(), {
            redirect: "manual",
            dispatcher: checked.dispatcher,
            signal: AbortSignal.timeout(30_000),
          } as unknown as RequestInit);
          hopEntry.status = response.status;
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get("location");
          if (!location || hop === MAX_REDIRECTS) throw new Error("Too many redirects.");
          const target = new URL(location, url.toString());
          const targetText = target.toString();
          if (hops.at(-1)?.url !== targetText)
            hops.push({ url: targetText, status: null, ips: [] });
          url = driveRewrite(validateUrl(target));
        }
        if (!response) throw new Error("No response.");
        body = await readBody(response);
        if (response.status < 200 || response.status >= 300)
          throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (
          contentType.includes("pdf") ||
          url.pathname.toLowerCase().endsWith(".pdf") ||
          body.subarray(0, 5).toString("ascii") === "%PDF-"
        ) {
          const pages = [
            ...new Set(
              (input.pages?.length ? input.pages : [1, 2, 3, 4]).filter((page) => page >= 1),
            ),
          ].slice(0, 4);
          return { url: url.toString(), ...(await extractPdf(body, pages)) };
        }
        const html = body.toString("utf8");
        const title = html
          .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
          ?.replace(/\s+/g, " ")
          .trim();
        const text = html
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 20_000);
        const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
          .slice(0, 300)
          .map((match) =>
            URL.canParse(match[1]!, url.toString())
              ? {
                  href: new URL(match[1]!, url).toString(),
                  text: match[2]!
                    .replace(/<[^>]+>/g, "")
                    .replace(/\s+/g, " ")
                    .trim(),
                }
              : undefined,
          )
          .filter((link): link is { href: string; text: string } => link !== undefined);
        return { url: url.toString(), ...(title ? { title } : {}), text, links };
      } catch (cause) {
        failure = cause;
        throw cause;
      } finally {
        if (input.audit)
          await auditDownload(input.audit, {
            url: input.url,
            hops,
            status: response?.status ?? null,
            bytes: body?.byteLength ?? 0,
            contentType: response?.headers.get("content-type") ?? null,
            ...(body === undefined ? {} : { body }),
            ...(isReferenceBlockedError(failure) ? { blocked: failure.reason } : {}),
            ...(failure !== undefined && !isReferenceBlockedError(failure)
              ? { error: String(failure) }
              : {}),
          });
      }
    },
    catch: (cause) =>
      new CourseReferenceFetchError({
        message: isReferenceBlockedError(cause) ? cause.reason : String(cause),
      }),
  });
});
