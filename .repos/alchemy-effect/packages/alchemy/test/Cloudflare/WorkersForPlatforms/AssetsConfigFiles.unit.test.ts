import {
  mergeAssetsConfigFiles,
  readAssetsConfigFiles,
} from "@/Cloudflare/Workers/Assets.ts";
import { PutDispatchNamespaceScriptRequest } from "@distilled.cloud/cloudflare/workers-for-platforms";
import { buildRequest } from "@distilled.cloud/core/protocol-http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";

const directory = pathe.resolve(import.meta.dirname, "fixtures/assets-config");

layer(NodeServices.layer)(
  "dispatch asset configuration serialization",
  (it) => {
    for (const keepAssets of [false, true]) {
      it.effect(`preserves file rules with keepAssets=${keepAssets}`, () =>
        Effect.gen(function* () {
          const files = yield* readAssetsConfigFiles(directory);
          const config = mergeAssetsConfigFiles(undefined, files);
          const input: PutDispatchNamespaceScriptRequest = {
            accountId: "account",
            dispatchNamespace: "namespace",
            scriptName: "script",
            metadata: {
              mainModule: "index.js",
              keepAssets,
              assets: {
                ...(!keepAssets ? { jwt: "upload-token" } : {}),
                config,
              },
            },
          };
          const request = buildRequest({
            input,
            inputAst: PutDispatchNamespaceScriptRequest.ast,
            baseUrl: "https://api.cloudflare.com/client/v4",
          });
          const form = (request.body as { formData: FormData }).formData;
          expect(JSON.parse(form.get("metadata") as string)).toEqual({
            main_module: "index.js",
            keep_assets: keepAssets,
            assets: {
              ...(!keepAssets ? { jwt: "upload-token" } : {}),
              config: {
                _headers: "/*\n  Cache-Control: public, max-age=3600\n",
                _redirects: "/old-path /index.html 301\n",
              },
            },
          });
        }),
      );
    }
  },
);
