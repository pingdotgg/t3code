import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as AssetSigner from "../../assets/AssetSigner.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../../auth/utils.ts";
import * as ServerConfig from "../../config.ts";
import * as HostFiles from "./HostFiles.ts";

const layerTest = AssetSigner.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-host-files-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const tree = Effect.fn("HostFilesTest.tree")(function* (
  files: Readonly<Record<string, string | Uint8Array>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-host-files-" }),
  );
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(base, ...name.split("/"));
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* typeof content === "string"
      ? fileSystem.writeFileString(file, content)
      : fileSystem.writeFile(file, content);
  }
  const roots = [HostFiles.toFileRoot(path, base)];
  return {
    base,
    roots,
    policy: yield* HostFiles.makePolicy(roots),
    at: (name: string) => path.join(base, ...name.split("/")),
  };
});

const summary = (target: HostFiles.GrantTarget) =>
  target._tag === "File" ? { path: target.path, kind: target.kind } : target;

const NOT_FOUND = { _tag: "NotFound" };

describe("host file grants", () => {
  it.effect(
    "a folder grant reads visible files at or below the report's folder, and nothing else",
    () =>
      Effect.gen(function* () {
        const { policy, at } = yield* tree({
          "reports/report.html": "<img src=fig.png>",
          "reports/fig.png": PNG,
          "reports/figure.bmp": PNG,
          "reports/style.css": "body{}",
          "reports/sub/deep.png": PNG,
          "reports/.private.png": PNG,
          "other/a.png": PNG,
        });
        const { token, fileName } = yield* HostFiles.mintGrant(policy, at("reports/report.html"));
        const open = (rawPath: string) =>
          HostFiles.openGrantPath(policy, token, rawPath).pipe(Effect.map(summary));

        expect(fileName).toBe("report.html");
        expect(yield* open("report.html")).toEqual({
          path: at("reports/report.html"),
          kind: { _tag: "Html" },
        });
        expect(yield* open("fig.png")).toEqual({
          path: at("reports/fig.png"),
          kind: { _tag: "Typed", mimeType: "image/png" },
        });
        expect(yield* open("figure.bmp")).toEqual({
          path: at("reports/figure.bmp"),
          kind: { _tag: "Typed", mimeType: "image/bmp" },
        });
        expect(yield* open("style.css")).toEqual({
          path: at("reports/style.css"),
          kind: { _tag: "Typed", mimeType: "text/css; charset=utf-8" },
        });
        expect(yield* open("sub/deep.png")).toMatchObject({ path: at("reports/sub/deep.png") });
        expect(yield* open("sub")).toEqual({ _tag: "AddSlash", location: "./sub/" });
        expect(yield* open("sub/")).toEqual(NOT_FOUND);
        expect(yield* open(".private.png")).toEqual(NOT_FOUND);
        expect(yield* open("%2e%2e/other/a.png")).toEqual(NOT_FOUND);
        expect(yield* open("..%2Fother%2Fa.png")).toEqual(NOT_FOUND);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "grants refuse links to hidden files, T3's state, out of the folder, and a swapped exact file",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const { policy, at } = yield* tree({
          "reports/report.html": "",
          "reports/.private/key.png": PNG,
          "other/a.png": PNG,
          "top.html": "",
          "taxes.pdf": "%PDF",
          "home/top.html": "",
          "home/fig.png": PNG,
        });
        yield* fileSystem.writeFileString(path.join(config.stateDir, "settings.json"), "{}");
        yield* fileSystem.symlink(at("reports/.private/key.png"), at("reports/key.png"));
        yield* fileSystem.symlink(config.stateDir, at("reports/state"));
        yield* fileSystem.symlink(at("other/a.png"), at("reports/a.png"));
        yield* fileSystem.symlink(at("home"), at("home-link"));
        const { token } = yield* HostFiles.mintGrant(policy, at("reports/report.html"));
        const exact = yield* HostFiles.mintGrant(policy, at("top.html"));
        yield* fileSystem.remove(at("top.html"));
        yield* fileSystem.symlink(at("taxes.pdf"), at("top.html"));
        // As if startup had kept only the linked path of this root.
        const linkedRoot = yield* HostFiles.makePolicy([
          HostFiles.toFileRoot(path, at("home-link")),
        ]);
        const inLinkedRoot = yield* HostFiles.mintGrant(linkedRoot, at("home/top.html"));

        expect(yield* HostFiles.openGrantPath(policy, token, "key.png")).toEqual(NOT_FOUND);
        expect(yield* HostFiles.openGrantPath(policy, token, "state/settings.json")).toEqual(
          NOT_FOUND,
        );
        expect(yield* HostFiles.openGrantPath(policy, token, "a.png")).toEqual(NOT_FOUND);
        expect(yield* HostFiles.openGrantPath(policy, exact.token, "top.html")).toEqual(NOT_FOUND);
        expect(
          (yield* HostFiles.openGrantPath(linkedRoot, inLinkedRoot.token, "top.html"))._tag,
        ).toBe("File");
        expect(yield* HostFiles.openGrantPath(linkedRoot, inLinkedRoot.token, "fig.png")).toEqual(
          NOT_FOUND,
        );
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("an open proof holds for one path for five minutes, and a grant for an hour", () =>
    Effect.gen(function* () {
      const { policy, at } = yield* tree({ "reports/report.html": "", "reports/fig.png": PNG });
      const { token } = yield* HostFiles.mintGrant(policy, at("reports/report.html"));
      const proof = yield* HostFiles.signOpenProof("/home/ana/report.html");

      yield* TestClock.adjust("4 minutes");
      expect(yield* HostFiles.verifyOpenProof("/home/ana/report.html", proof)).toBe(true);
      expect(yield* HostFiles.verifyOpenProof("/home/ana/other.html", proof)).toBe(false);
      yield* TestClock.adjust("2 minutes");
      expect(yield* HostFiles.verifyOpenProof("/home/ana/report.html", proof)).toBe(false);
      yield* TestClock.adjust("53 minutes");
      expect((yield* HostFiles.openGrantPath(policy, token, "fig.png"))._tag).toBe("File");
      yield* TestClock.adjust("2 minutes");
      expect(yield* HostFiles.openGrantPath(policy, token, "fig.png")).toEqual(NOT_FOUND);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a changed, re-signed or unsigned-domain token is refused", () =>
    Effect.gen(function* () {
      const signer = yield* AssetSigner.AssetSigner;
      const { policy, at } = yield* tree({ "top.html": "", "fig.png": PNG });
      const { token } = yield* HostFiles.mintGrant(policy, at("top.html"));
      const [payload = "", signature = ""] = token.split(".");
      const { file: _file, ...folderClaims } = JSON.parse(base64UrlDecodeUtf8(payload));
      const widened = base64UrlEncode(JSON.stringify(folderClaims));
      const [exp = ""] = (yield* HostFiles.signOpenProof("/r.html")).split(".");

      expect((yield* HostFiles.openGrantPath(policy, token, "top.html"))._tag).toBe("File");
      expect(yield* HostFiles.openGrantPath(policy, `${widened}.${signature}`, "fig.png")).toEqual(
        NOT_FOUND,
      );
      expect(
        yield* HostFiles.openGrantPath(
          policy,
          `${widened}.${yield* signer.sign(widened)}`,
          "fig.png",
        ),
      ).toEqual(NOT_FOUND);
      expect(
        yield* HostFiles.openGrantPath(policy, `${payload}.${signature.slice(1)}`, "top.html"),
      ).toEqual(NOT_FOUND);
      expect(yield* HostFiles.openGrantPath(policy, `${token}.x`, "top.html")).toEqual(NOT_FOUND);
      expect(
        yield* HostFiles.verifyOpenProof(
          "/r.html",
          `${exp}.${yield* signer.sign(`${exp}\n/r.html`)}`,
        ),
      ).toBe(false);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("replacing the granted folder ends the grant, also while a read is under way", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { policy, at } = yield* tree({ "reports/report.html": "", "reports/fig.png": PNG });
      const replace = (oldName: string) =>
        Effect.gen(function* () {
          yield* fileSystem.rename(at("reports"), at(oldName));
          yield* fileSystem.makeDirectory(at("reports"));
          yield* fileSystem.writeFile(at("reports/fig.png"), PNG);
        });
      const first = yield* HostFiles.mintGrant(policy, at("reports/report.html"));
      expect((yield* HostFiles.openGrantPath(policy, first.token, "fig.png"))._tag).toBe("File");

      yield* replace("reports-old");
      expect(yield* HostFiles.openGrantPath(policy, first.token, "fig.png")).toEqual(NOT_FOUND);

      const second = yield* HostFiles.mintGrant(policy, at("reports/report.html"));
      const replaced: Array<string> = [];
      // Swaps the folder when the read reaches the file, after any check made before the lookup.
      const racing = {
        ...fileSystem,
        stat: (file: string) =>
          file === at("reports/fig.png") && replaced.length === 0
            ? Effect.sync(() => replaced.push(file)).pipe(
                Effect.andThen(replace("reports-older")),
                Effect.andThen(fileSystem.stat(file)),
              )
            : fileSystem.stat(file),
      };
      const raced = yield* HostFiles.openGrantPath(policy, second.token, "fig.png").pipe(
        Effect.provideService(FileSystem.FileSystem, racing),
      );

      expect(replaced).toEqual([at("reports/fig.png")]);
      expect(raced).toEqual(NOT_FOUND);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a report in a root, or in a folder above one, gets a grant for itself only", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { base, policy, at } = yield* tree({ "top.html": "", "fig.png": PNG, "home/x": "" });
      const inRoot = yield* HostFiles.mintGrant(policy, at("top.html"));

      expect(summary(yield* HostFiles.openGrantPath(policy, inRoot.token, "top.html"))).toEqual({
        path: at("top.html"),
        kind: { _tag: "Html" },
      });
      expect(yield* HostFiles.openGrantPath(policy, inRoot.token, "fig.png")).toEqual(NOT_FOUND);
      expect(yield* HostFiles.openGrantPath(policy, inRoot.token, "top.html/")).toEqual(NOT_FOUND);

      const home = yield* HostFiles.makePolicy([
        HostFiles.toFileRoot(path, path.join(base, "home")),
      ]);
      const aboveRoot = yield* HostFiles.mintGrant(home, at("top.html"));
      expect(yield* HostFiles.openGrantPath(home, aboveRoot.token, "fig.png")).toEqual(NOT_FOUND);
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("file roots", () => {
  const rootsFor = (home: string, environment: NodeJS.ProcessEnv) =>
    HostFiles.fileRoots.pipe(
      Effect.map((roots) => roots.map((root) => root.directory)),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, environment),
      Effect.provideService(HostProcess.Platform, "linux"),
    );

  it.effect("keeps home and temp without a trailing slash, and drops what cannot be a route", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { at } = yield* tree({ "home/x": "" });
      const realTmp = yield* fileSystem.realPath("/tmp");
      const tmp = realTmp === "/tmp" ? ["/tmp"] : ["/tmp", realTmp];

      expect(yield* rootsFor(`${at("home")}/`, { TMPDIR: at("missing") })).toEqual([
        at("home"),
        at("missing"),
        ...tmp,
      ]);
      // A root named ":cache?" makes the router throw while adding its route.
      for (const name of [
        "a*b",
        "a#b",
        "a?b",
        ":cache?",
        "a;b",
        "a@b",
        "a&b",
        "a=b",
        "a+b",
        "a$b",
        "a,b",
        "a%41b",
      ]) {
        expect(yield* rootsFor("/", { TMPDIR: at(name) }), name).toEqual(tmp);
      }
      expect(yield* rootsFor("", { TMPDIR: "//server/share" })).toEqual(tmp);
      expect(yield* rootsFor(at("home"), { TMPDIR: at("home").toUpperCase() })).toEqual([
        at("home"),
        ...tmp,
      ]);
      expect(yield* rootsFor(at("home"), { TMP: `${at("home")}/` })).toEqual([at("home"), ...tmp]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)("adds the real path of a linked home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { at } = yield* tree({ "home/x": "" });
      yield* fileSystem.symlink(at("home"), at("link"));
      const realTmp = yield* fileSystem.realPath("/tmp");

      expect((yield* rootsFor(at("link"), {})).slice(0, 2)).toEqual([at("link"), at("home")]);
      expect(yield* rootsFor(at("link"), {})).toContain(realTmp);
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("request paths", () => {
  it.effect("decode once, stay below a root, and refuse hidden or ambiguous segments", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const roots = [
        HostFiles.toFileRoot(path, "/srv/home/ana"),
        HostFiles.toFileRoot(path, "/tmp"),
      ];
      const parse = (rawPath: string) => {
        const parsed = HostFiles.parseRequestPath(path, roots, rawPath);
        return (
          parsed && {
            root: parsed.root.directory,
            path: parsed.path,
            withoutLineSuffix: parsed.withoutLineSuffix,
            trailingSlash: parsed.trailingSlash,
          }
        );
      };

      expect(parse("/srv/home/ana/r/report.html")).toEqual({
        root: "/srv/home/ana",
        path: "/srv/home/ana/r/report.html",
        withoutLineSuffix: undefined,
        trailingSlash: false,
      });
      expect(parse("/srv/home/ana/src/app.ts:42:7")?.withoutLineSuffix).toBe(
        "/srv/home/ana/src/app.ts",
      );
      expect(parse("/srv/home/ana/src/app.ts:42")?.withoutLineSuffix).toBe(
        "/srv/home/ana/src/app.ts",
      );
      expect(parse("/srv/home/ana/My%20Files/r%C3%A9sum%C3%A9.txt")?.path).toBe(
        "/srv/home/ana/My Files/résumé.txt",
      );
      expect(parse("/srv/home/ana/dir/")).toMatchObject({
        path: "/srv/home/ana/dir",
        trailingSlash: true,
      });
      expect(parse("/srv/home/ana")).toMatchObject({ path: "/srv/home/ana", trailingSlash: false });
      expect(parse("/tmp/run/out.png")?.root).toBe("/tmp");
      for (const refused of [
        "/srv/home/ana/.env",
        "/srv/home/ana/a/.git/config",
        "/srv/home/ana/a/../b",
        "/srv/home/ana/%2e%2e/bob",
        "/srv/home/ana/a%2Fb",
        "/srv/home/ana/a%5Cb",
        "/srv/home/ana/a%00b",
        "/srv/home/ana/%E0%A4%A",
        "/srv/home/ana//x",
        "//srv/home/ana/x",
        "/srv/home/anabel/x",
        "/SRV/HOME/ANA/x",
      ]) {
        expect(parse(refused), refused).toBeNull();
      }
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );

  it.effect("on Windows a drive root keeps its colon and matches in any letter case", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const roots = yield* HostFiles.fileRoots.pipe(
        Effect.provideService(HostProcess.HomeDirectory, "C:\\Users\\ana"),
        Effect.provideService(HostProcess.Environment, { TEMP: "C:\\Temp\\a#b" }),
        Effect.provideService(HostProcess.Platform, "win32"),
      );

      expect(roots.map((root) => root.urlPrefix)).toEqual(["/C:/Users/ana"]);
      expect(HostFiles.parseRequestPath(path, roots, "/C:/Users/ana/r.html")?.path).toBe(
        "C:\\Users\\ana\\r.html",
      );
      expect(HostFiles.parseRequestPath(path, roots, "/c:/users/ana/r.html")?.path).toBe(
        "C:\\Users\\ana\\r.html",
      );
      expect(HostFiles.parseRequestPath(path, roots, "/C:/Users/ana/a%5C..%5Cx")).toBeNull();
    }).pipe(Effect.provide(NodePath.layerWin32)),
  );
});
