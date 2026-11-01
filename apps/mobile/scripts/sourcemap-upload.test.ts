import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildDsymUpload,
  buildSourceMapUpload,
  otaSourceMapUploads,
  uploadSourceMap,
} from "./sourcemap-upload.mts";

const directories: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sourcemap-upload-"));
  directories.push(dir);
  return dir;
};
const writeFile = (path: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
};

afterEach(() => {
  for (const dir of directories.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("uploadSourceMap", () => {
  it("PUTs each published update's map, only what the relay reads, under its update id", async () => {
    const dist = tempDir();
    writeFile(
      NodePath.join(dist, "metadata.json"),
      JSON.stringify({
        fileMetadata: {
          android: { bundle: "_expo/static/js/android/index-abc.hbc" },
          ios: { bundle: "_expo/static/js/ios/index-def.hbc" },
        },
      }),
    );
    writeFile(
      NodePath.join(dist, "eas-update-metadata.json"),
      JSON.stringify({
        updates: [
          { id: "update-android", platform: "android" },
          { id: "update-ios", platform: "ios" },
          { id: "update-web", platform: "web" },
        ],
      }),
    );
    for (const platform of ["android", "ios"]) {
      writeFile(
        NodePath.join(
          dist,
          `_expo/static/js/${platform}/index-${platform === "ios" ? "def" : "abc"}.hbc.map`,
        ),
        JSON.stringify({
          version: 3,
          sources: [`${platform}.ts`],
          sourcesContent: ["secret"],
          names: ["render"],
          x_facebook_sources: [[null]],
          mappings: "",
        }),
      );
    }

    const requests: Array<{ method?: string; url?: string; auth?: string; body: string }> = [];
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          url: request.url,
          auth: request.headers.authorization,
          body,
        });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as NodeNet.AddressInfo;
      const credentials = {
        endpoint: `http://127.0.0.1:${address.port}`,
        bucketName: "maps",
        accessKeyId: "key-id",
        secretAccessKey: "secret-key",
      };
      for (const upload of otaSourceMapUploads(dist)) {
        await uploadSourceMap(credentials, upload);
      }
      expect(requests).toEqual(
        ["android", "ios"].map((platform) => ({
          method: "PUT",
          url: `/maps/${platform}/ota/update-${platform}.map`,
          auth: expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=key-id\/\d{8}\/auto\/s3\//),
          body: JSON.stringify({ version: 3, sources: [`${platform}.ts`], mappings: "" }),
        })),
      );
    } finally {
      server.close();
    }
  });
});

describe("buildSourceMapUpload", () => {
  it("names the EAS build's embedded bundle map under its build id", () => {
    const project = tempDir();
    const androidMap = NodePath.join(
      project,
      "android/app/build/generated/sourcemaps/react/release/index.android.bundle.map",
    );
    writeFile(androidMap, "{}");
    expect(
      buildSourceMapUpload({ EAS_BUILD_PLATFORM: "android", EAS_BUILD_ID: "build-1" }, project),
    ).toEqual({ key: "android/build/build-1.map", path: androidMap });
    expect(
      buildSourceMapUpload(
        { EAS_BUILD_PLATFORM: "ios", EAS_BUILD_ID: "build-2", SOURCEMAP_FILE: "/tmp/main.map" },
        project,
      ),
    ).toEqual({ key: "ios/build/build-2.map", path: "/tmp/main.map" });
  });

  it("names an iOS build's dSYMs under its build id", () => {
    const project = tempDir();
    const dsym = NodePath.join(project, "ios/build/T3Code.app.dSYM.zip");
    writeFile(dsym, "zip");
    expect(
      buildDsymUpload({ EAS_BUILD_PLATFORM: "ios", EAS_BUILD_ID: "build-3" }, project),
    ).toEqual({ key: "ios/dsym/build-3.zip", path: dsym });
  });
});
