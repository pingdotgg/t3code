import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle, resolveMainPath } from "../../Bundle/TempRoot.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { zipFiles } from "../../Util/zip.ts";

/**
 * Bundles an Effect-native `GCP.CloudFunctions.Function` `main` into a
 * Node.js source archive and uploads it through `generateUploadUrl`.
 *
 * The archive holds the bundled `index.mjs` (the generated entry around
 * `main`) and a `package.json` declaring the Functions Framework, which
 * the Node.js buildpack runs with `--target=handler`.
 *
 * NOT exported from `index.ts`.
 */

export const FUNCTION_ENTRY_POINT = "handler";
export const DEFAULT_NODE_RUNTIME = "nodejs22";

export class FunctionSourceUploadFailed extends Data.TaggedError(
  "GCP.CloudFunctions.FunctionSourceUploadFailed",
)<{ status: number; message: string }> {}

/**
 * Generated entry for an Effect-native Cloud Function: imports only
 * `alchemy/Runtime/Bootstrap/CloudFunction` plus the user's `main`, and
 * exports the Functions Framework target. The runtime flag is raised
 * before the user's module evaluates.
 */
export const makeFunctionBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { makeHandler } from "alchemy/Runtime/Bootstrap/CloudFunction";

globalThis.__ALCHEMY_RUNTIME__ = true;
const { ${handler}: entrypoint } = await import(${JSON.stringify(importPath)});

export const ${FUNCTION_ENTRY_POINT} = makeHandler(entrypoint);
`;

const packageJson = `${JSON.stringify(
  {
    private: true,
    type: "module",
    main: "index.mjs",
    dependencies: { "@google-cloud/functions-framework": "^3.4.0" },
  },
  null,
  2,
)}\n`;

export const makeFunctionSource = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  /** Bundle `main` and hash the archive's content (no upload). */
  const bundle = Effect.fn(function* (options: {
    main: string;
    handler?: string;
    build?: Bundle.BundleConfig;
    isExternal?: boolean;
  }) {
    const realMain = yield* resolveMainPath(options.main);
    const cwd = yield* findCwdForBundle(realMain);
    const bootstrap = makeFunctionBootstrap(options.handler ?? "default");
    const output = yield* Bundle.build(
      {
        ...options.build?.input,
        input: realMain,
        cwd,
        platform: "node",
        resolve: {
          conditionNames: ["node", "import", "module", "default"],
          ...options.build?.input?.resolve,
        },
        plugins: [
          options.build?.input?.plugins,
          options.isExternal ? undefined : virtualEntryPlugin(bootstrap),
        ],
      },
      {
        ...options.build?.output,
        format: "esm",
        sourcemap: options.build?.output?.sourcemap ?? false,
        minify: options.build?.output?.minify ?? false,
        entryFileNames: "index.mjs",
      },
      options.build,
    );
    const files = [
      ...output.files.map((file) => ({
        path: file.path,
        content:
          typeof file.content === "string"
            ? new TextEncoder().encode(file.content)
            : file.content,
      })),
      { path: "package.json", content: packageJson },
    ];
    const codeHash = (yield* sha256Object({
      bundle: output.hash,
      packageJson,
    })).slice(0, 16);
    return { files, codeHash };
  });

  /** Zip and upload the bundle; returns the `storageSource` to build from. */
  const upload = Effect.fn(function* (options: {
    parent: string;
    files: ReadonlyArray<{ path: string; content: string | Uint8Array }>;
    kmsKeyName?: string;
  }) {
    const archive = yield* zipFiles(options.files);
    const target =
      yield* cloudfunctions.generateUploadUrlProjectsLocationsFunctions({
        parent: options.parent,
        body: {
          environment: "GEN_2",
          ...(options.kmsKeyName ? { kmsKeyName: options.kmsKeyName } : {}),
        },
      });
    if (target.uploadUrl === undefined || target.storageSource === undefined) {
      return yield* new FunctionSourceUploadFailed({
        status: 0,
        message: "generateUploadUrl returned no uploadUrl/storageSource",
      });
    }
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.put(target.uploadUrl).pipe(
          HttpClientRequest.bodyUint8Array(
            new Uint8Array(archive),
            "application/zip",
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new FunctionSourceUploadFailed({
              status: 0,
              message: String(cause),
            }),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new FunctionSourceUploadFailed({
        status: response.status,
        message: text.slice(0, 500),
      });
    }
    return target.storageSource;
  });

  return { bundle, upload };
});
