import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildSourceMapUpload,
  otaSourceMapUploads,
  parseCredentials,
  stripSourcesContent,
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

describe("otaSourceMapUploads", () => {
  it("pairs each published update with its platform bundle's map", () => {
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
    expect(otaSourceMapUploads(dist)).toEqual([
      {
        key: "android/ota/update-android.map",
        path: NodePath.join(dist, "_expo/static/js/android/index-abc.hbc.map"),
      },
      {
        key: "ios/ota/update-ios.map",
        path: NodePath.join(dist, "_expo/static/js/ios/index-def.hbc.map"),
      },
    ]);
  });
});

describe("buildSourceMapUpload", () => {
  it("finds Android's release map and iOS's SOURCEMAP_FILE", () => {
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

  it("explains a build without a release map, such as a development client", () => {
    expect(() =>
      buildSourceMapUpload({ EAS_BUILD_PLATFORM: "android", EAS_BUILD_ID: "b" }, tempDir()),
    ).toThrow(/No release source map/);
  });
});

describe("parseCredentials", () => {
  it("treats an unset secret as no credentials and rejects incomplete ones", () => {
    expect(parseCredentials(undefined)).toBeUndefined();
    expect(parseCredentials("  ")).toBeUndefined();
    expect(() => parseCredentials('{"endpoint":"https://r2.test"}')).toThrow(/bucketName/);
  });
});

describe("uploadSourceMap", () => {
  it("PUTs the map without sources to its key, signed for R2", async () => {
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
      const path = NodePath.join(tempDir(), "index.map");
      writeFile(
        path,
        JSON.stringify({ version: 3, sources: ["a.ts"], sourcesContent: ["secret"], mappings: "" }),
      );
      await uploadSourceMap(
        {
          endpoint: `http://127.0.0.1:${address.port}`,
          bucketName: "maps",
          accessKeyId: "key-id",
          secretAccessKey: "secret-key",
        },
        { key: "ios/ota/u1.map", path },
      );
      expect(requests).toEqual([
        {
          method: "PUT",
          url: "/maps/ios/ota/u1.map",
          auth: expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=key-id\/\d{8}\/auto\/s3\//),
          body: JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "" }),
        },
      ]);
    } finally {
      server.close();
    }
  });

  it("strips only sourcesContent", () => {
    expect(stripSourcesContent('{"version":3,"sourcesContent":["x"],"names":["n"]}')).toBe(
      '{"version":3,"names":["n"]}',
    );
  });
});
