import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import { GroupName, PackageName, type Manifest } from "../src/Manifest.ts";
import { manifestArtifactName, tarballUrl } from "../src/Protocol.ts";
import { Policy } from "../src/Registry.ts";
import {
  installTag,
  parseInstallPath,
  tagsFor,
} from "../src/Registry/Handler.ts";
import {
  selectPackages,
  dependencyLevels,
  expandBraces,
  Group,
  rewriteDependencies,
  tarballFile,
} from "../src/cli/pack.ts";
import { publish } from "../src/cli/publish.ts";

describe("registry", () => {
  const run = {
    repo: "alchemy-run/alchemy",
    runId: 1,
    attempt: 1,
    headSha: "abcdef0123456789abcdef0123456789abcdef01",
    headBranch: "feat/x",
    headRepo: "alchemy-run/alchemy",
    pr: 7,
  };

  test("runs on the repository's own commits get every tag", () => {
    expect(tagsFor(run)).toEqual([
      run.headSha,
      "abcdef0",
      "pr:7",
      "pr:7:abcdef0",
      "branch:feat/x",
    ]);
    expect(tagsFor({ ...run, pr: null, headBranch: "main" })).toEqual([
      run.headSha,
      "abcdef0",
      "branch:main",
    ]);
    expect(installTag(run)).toBe("pr:7:abcdef0");
    expect(installTag({ ...run, pr: null, headBranch: "main" })).toBe(
      "abcdef0",
    );
  });

  test("runs from forks get only their pull request revision tag", () => {
    const fork = { ...run, headRepo: "someone/alchemy" };
    expect(tagsFor(fork)).toEqual(["pr:7:abcdef0"]);
    expect(installTag(fork)).toBe("pr:7:abcdef0");
    expect(tagsFor({ ...fork, pr: null })).toEqual([]);
  });

  test("install paths", () => {
    expect(parseInstallPath("/alchemy/pr:7:abcdef0", undefined)).toEqual({
      kind: "tag",
      name: "alchemy",
      tag: "pr:7:abcdef0",
    });
    expect(
      parseInstallPath("/@alchemy.run/pkg/branch:feat/x", undefined),
    ).toEqual({ kind: "tag", name: "@alchemy.run/pkg", tag: "branch:feat/x" });
    expect(parseInstallPath("/core/abc1234", "@distilled.cloud")).toEqual({
      kind: "tag",
      name: "@distilled.cloud/core",
      tag: "abc1234",
    });
    expect(
      parseInstallPath(`/alchemy/-/${"a".repeat(64)}.tgz`, undefined),
    ).toEqual({ kind: "tarball", name: "alchemy", sha256: "a".repeat(64) });
    for (const path of ["/", "/alchemy", "/alchemy/", "/alchemy/%E0%A4%A"]) {
      expect(parseInstallPath(path, undefined)).toBeUndefined();
    }
  });

  test("tarball file names never collide", () => {
    expect(tarballFile("alchemy")).toBe("alchemy.tgz");
    expect(tarballFile("@a/b-c")).toBe("a+b-c.tgz");
    expect(tarballFile("@a-b/c")).toBe("a-b+c.tgz");
  });
});

describe("Policy", () => {
  const policy = {
    repos: ["alchemy-run/alchemy", "alchemy-run/distilled"],
    ttl: Duration.weeks(1),
  };

  test("round-trips through its JSON encoding", () => {
    const encoded = Schema.encodeSync(Policy)(policy);
    expect(encoded.ttl).toBe(7 * 24 * 60 * 60 * 1000);
    expect(Schema.decodeUnknownSync(Policy)(encoded)).toEqual(policy);
  });
});

describe("names", () => {
  test("package names follow npm's rules for new packages", () => {
    const decode = Schema.decodeUnknownSync(PackageName);
    for (const name of ["alchemy", "@alchemy.run/pkg", "a-b_c.d~e"]) {
      expect(decode(name)).toBe(name);
    }
    for (const name of [
      "Alchemy",
      "@Scope/pkg",
      ".hidden",
      "_private",
      "a b",
      "a`b",
      "a\nb",
      "@scope",
      "a/b",
      "x".repeat(215),
    ]) {
      expect(() => decode(name)).toThrow();
    }
  });

  test("group names are plain labels", () => {
    const decode = Schema.decodeUnknownSync(GroupName);
    expect(decode("Alchemy")).toBe("Alchemy");
    expect(decode("@alchemy.run")).toBe("@alchemy.run");
    expect(decode("Distilled SDKs v2")).toBe("Distilled SDKs v2");
    for (const name of ["", " lead", "a`b", "a\nb", "###", "x".repeat(65)]) {
      expect(() => decode(name)).toThrow();
    }
  });
});

describe("workspace", () => {
  test("expandBraces", () => {
    expect(expandBraces("./packages/*")).toEqual(["./packages/*"]);
    expect(expandBraces("./packages/{alchemy, pkg}")).toEqual([
      "./packages/alchemy",
      "./packages/pkg",
    ]);
    expect(expandBraces("./{a,b}/packages/{x,y}")).toEqual([
      "./a/packages/x",
      "./a/packages/y",
      "./b/packages/x",
      "./b/packages/y",
    ]);
  });

  test("Group", () => {
    const decode = Schema.decodeUnknownSync(Group);
    const encode = Schema.encodeSync(Group);
    expect(decode("Alchemy=./packages/*")).toEqual({
      name: "Alchemy",
      pattern: "./packages/*",
      collapsed: false,
    });
    expect(decode("Distilled[Collapsed]=./submodules/*")).toEqual({
      name: "Distilled",
      pattern: "./submodules/*",
      collapsed: true,
    });
    expect(decode("@alchemy.run[Collapsed]=./packages/{a,b}")).toEqual({
      name: "@alchemy.run",
      pattern: "./packages/{a,b}",
      collapsed: true,
    });
    expect(
      encode({ name: "Distilled", pattern: "./submodules/*", collapsed: true }),
    ).toBe("Distilled[Collapsed]=./submodules/*");
    for (const spec of ["Distilled[Hidden]=./x", "=x", "Alchemy=", "Alchemy"]) {
      expect(() => decode(spec)).toThrow("NAME=GLOB or NAME[Collapsed]=GLOB");
    }
  });
});

describe("tarball", () => {
  test("tarballUrl strips trailing slashes and keeps scopes", () => {
    expect(tarballUrl("https://pkg.ing/", "@alchemy.run/pkg", "abc")).toBe(
      "https://pkg.ing/@alchemy.run/pkg/-/abc.tgz",
    );
  });

  test("dependencyLevels orders dependencies first and rejects cycles", async () => {
    const levels = await Effect.runPromise(
      dependencyLevels(
        new Map([
          ["alchemy", new Set(["core", "runtime", "outside"])],
          ["runtime", new Set(["utils"])],
          ["core", new Set()],
          ["utils", new Set()],
          ["better-auth", new Set(["alchemy"])],
        ]),
      ),
    );
    expect(levels).toEqual([
      ["core", "utils"],
      ["runtime"],
      ["alchemy"],
      ["better-auth"],
    ]);
    const cycle = await Effect.runPromise(
      Effect.result(
        dependencyLevels(
          new Map([
            ["a", new Set(["b"])],
            ["b", new Set(["a"])],
          ]),
        ),
      ),
    );
    expect(cycle._tag).toBe("Failure");
  });

  test("rewriteDependencies only touches published packages", async () => {
    const manifest = JSON.stringify({
      name: "alchemy",
      dependencies: {
        "@distilled.cloud/core": "1.0.0-rc.8",
        effect: "^4.0.0",
      },
      peerDependencies: { "@alchemy.run/frontend-frameworks": "2.0.0" },
      exports: { ".": "./src/index.ts" },
    });
    const links = new Map([
      [
        "@distilled.cloud/core",
        "https://pkg.ing/@distilled.cloud/core/-/aa.tgz",
      ],
      [
        "@alchemy.run/frontend-frameworks",
        "https://pkg.ing/@alchemy.run/frontend-frameworks/-/bb.tgz",
      ],
    ]);
    const result = await Effect.runPromise(
      rewriteDependencies(manifest, links),
    );
    const rewritten = JSON.parse(result.text);
    expect(Object.keys(rewritten)).toEqual(Object.keys(JSON.parse(manifest)));
    expect(rewritten.dependencies).toEqual({
      "@distilled.cloud/core": "https://pkg.ing/@distilled.cloud/core/-/aa.tgz",
      effect: "^4.0.0",
    });
    expect(rewritten.peerDependencies).toEqual({
      "@alchemy.run/frontend-frameworks":
        "https://pkg.ing/@alchemy.run/frontend-frameworks/-/bb.tgz",
    });
    expect(rewritten.exports).toEqual({ ".": "./src/index.ts" });
    expect(result.rewrites.map((r) => r.name).sort()).toEqual([
      "@alchemy.run/frontend-frameworks",
      "@distilled.cloud/core",
    ]);
  });
});

describe("Api", () => {
  test("manifest artifact name carries the manifest hash", () => {
    expect(manifestArtifactName("ab".repeat(32))).toBe(
      `pkg-manifest-${"ab".repeat(32)}`,
    );
  });
});

const env = {
  GITHUB_REPOSITORY: "alchemy-run/alchemy",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
};
const previous = Object.fromEntries(
  Object.keys(env).map((key) => [key, process.env[key]]),
);
beforeAll(() => Object.assign(process.env, env));
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const manifest: Manifest = {
  version: 1,
  groups: [{ name: "Alchemy", collapsed: false }],
  registry: "https://pkg.ing",
  head: "abcdef0123456789",
  packages: ["alchemy", "@alchemy.run/pkg"].map((name, index) => ({
    name,
    version: "1.0.0",
    group: "Alchemy",
    dir: `packages/${index}`,
    file: `${index}.tgz`,
    sha256: String(index).repeat(64),
    size: 3,
  })),
};
const missing = {
  _tag: "MissingTarballs",
  missing: [
    { name: manifest.packages[1]!.name, sha256: manifest.packages[1]!.sha256 },
  ],
};
const published = {
  packages: manifest.packages.map(({ name, group }) => ({
    name,
    group,
    url: `https://pkg.ing/${name}/abcdef0`,
    tags: ["abcdef0"],
  })),
};

for (const scenario of [
  "already present",
  "upload",
  "still missing",
  "rejected",
] as const) {
  test(`publish: ${scenario}`, async () => {
    const requests: string[] = [];
    const reads: string[] = [];
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const query = UrlParams.toString(request.urlParams);
        requests.push(
          `${request.method} ${request.url}${query ? `?${query}` : ""}`,
        );
        if (request.method === "PUT") {
          expect(request.headers["content-length"]).toBe("3");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              ...manifest.packages[1],
              uploaded: true,
            }),
          );
        }
        attempts++;
        const response =
          scenario === "rejected"
            ? Response.json(
                { _tag: "RunNotInProgress", message: "run is not in progress" },
                { status: 409 },
              )
            : scenario === "still missing" ||
                (scenario === "upload" && attempts === 1)
              ? Response.json(missing, { status: 409 })
              : Response.json(published);
        return HttpClientResponse.fromWeb(request, response);
      }),
    );
    const result = await Effect.runPromise(
      publish({
        cwd: "/workspace",
        dir: ".pkg",
        registry: "https://pkg.ing/",
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: () => Effect.succeed(JSON.stringify(manifest)),
            readFile: (path) =>
              Effect.sync(() => {
                reads.push(path);
                return new Uint8Array([1, 2, 3]);
              }),
          }),
        ),
        Effect.provide(Path.layer),
        Effect.result,
      ),
    );
    const uploads = scenario === "upload" || scenario === "still missing";
    expect(attempts).toBe(uploads ? 2 : 1);
    expect(reads).toEqual(uploads ? ["/workspace/.pkg/1.tgz"] : []);
    expect(requests).toEqual(
      uploads
        ? [
            "POST https://pkg.ing/api/publish",
            `PUT https://pkg.ing/api/tarballs/%40alchemy.run%2Fpkg/${"1".repeat(64)}?repo=alchemy-run%2Falchemy&runId=123&attempt=2`,
            "POST https://pkg.ing/api/publish",
          ]
        : ["POST https://pkg.ing/api/publish"],
    );
    if (scenario === "still missing" || scenario === "rejected") {
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("PublishError");
        expect(String(result.failure)).toContain(
          scenario === "rejected"
            ? "run is not in progress"
            : "registry still reports missing tarballs after upload",
        );
      }
    } else {
      expect(Result.getOrThrow(result)).toEqual(published);
    }
  });
}

describe("partial publication", () => {
  const packages = ["core", "aws", "cloudflare", "app", "unrelated"].map(
    (name) => ({
      name,
      version: "1.0.0",
      dir: `packages/${name}`,
      absDir: `/workspace/packages/${name}`,
      group: "SDKs",
    }),
  );
  const deps = new Map([
    ["core", new Set<string>()],
    ["aws", new Set(["core"])],
    ["cloudflare", new Set(["core"])],
    ["app", new Set(["cloudflare"])],
    ["unrelated", new Set<string>()],
  ]);
  const names = (files: string[], extra: string[] = []) =>
    selectPackages(packages, deps, files, extra).map((pkg) => pkg.name);

  test("includes transitive dependents and dependencies without unrelated siblings", () => {
    expect(names(["packages/cloudflare/src/r2.ts"])).toEqual([
      "core",
      "cloudflare",
      "app",
    ]);
    expect(
      names(["packages/aws/src/s3.ts", "packages/cloudflare/src/r2.ts"]),
    ).toEqual(["core", "aws", "cloudflare", "app"]);
    expect(names(["packages/core/src/index.ts"])).toEqual([
      "core",
      "aws",
      "cloudflare",
      "app",
    ]);
  });

  test("ignores unrelated paths and respects directory boundaries", () => {
    expect(names(["README.md", "packages/aws-other/index.ts"])).toEqual([]);
    expect(names([])).toEqual([]);
  });

  test("shared build inputs and configured prefixes select everything", () => {
    for (const file of [
      "pnpm-lock.yaml",
      "package.json",
      ".github/workflows/pkg.yml",
      "scripts/build.ts",
    ]) {
      expect(names([file], ["scripts/**"])).toEqual(
        packages.map((pkg) => pkg.name),
      );
    }
    expect(names(["scripts-other/build.ts"], ["scripts/**"])).toEqual([]);
  });

  test("submodule gitlink changes select contained packages", () => {
    expect(
      selectPackages(
        packages.map((pkg) => ({ ...pkg, dir: `submodules/sdk/${pkg.dir}` })),
        deps,
        ["submodules/sdk"],
      ).length,
    ).toBe(packages.length);
  });

  test("dependency cycles terminate selection and are rejected by packing order", async () => {
    const cycle = new Map([
      ["core", new Set(["aws"])],
      ["aws", new Set(["core"])],
    ]);
    expect(
      selectPackages(packages, cycle, ["packages/aws/index.ts"]).map(
        (pkg) => pkg.name,
      ),
    ).toEqual(["core", "aws"]);
    expect(
      (await Effect.runPromise(Effect.result(dependencyLevels(cycle))))._tag,
    ).toBe("Failure");
  });

  test("empty manifests do not contact the registry", async () => {
    const result = await Effect.runPromise(
      publish({
        cwd: "/workspace",
        dir: ".pkg",
        registry: manifest.registry,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected registry request")),
        ),
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: () =>
              Effect.succeed(JSON.stringify({ ...manifest, packages: [] })),
          }),
        ),
        Effect.provide(Path.layer),
      ),
    );
    expect(result).toEqual({ packages: [] });
  });
});
