import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as CuaDriverInstallation from "./CuaDriverInstallation.ts";

// Python tarfile (USTAR + gzip) and zipfile (DEFLATE) fixtures. File contents equal
// their names. TAR links target cua-driver: tar itself accepts them, so rejection
// must come from the installer. Traversal entries target ../../../outside/sentinel.
const archives = {
  tarComplete:
    "H4sIAAAAAAACA+3ZPVKDQACGYY6SC4Twk4VWZ0xp4wUym7AzoLA4uyB6e1HHImthIwTW92mSVBQvH4RkkG+11MW2VPWzMrtgCtEoF+LzdeS+/nwfR1kWBxsRzKC3nTTj4YP/abjsP1TaqHNnb8693F2vf5rGEf3nMHbeFqZ6UWa6Y/zaP06ccyHPExFsIvp70R/L7n/ujW3NtitVo66y/8S9/sfRPmP/vvTHctXVaTwFjl+3gKMtnkLbzr//vbv/PEvYvy/9sejr/3d83RbqaHrdVY0KPz7Mtv/U3X8qopz9+9Ifq+gvT1VYLub7P/v3pj+Wy/n9t9LjHOo6tOWc+09jZ/9JlkXs35f+WE3/i/9/GtXJQnYyfLStnnL/wt2/4Pnfo/5YZ3/12iltq1aPJ8Ck93/hfv8X3P896o/V9H843N7dH8KmmPX5P3X3n8Tpnv370h8AAAAAAAAAAAAAAAAAAAB/5x055e7oAFAAAA==",
  tarMissing:
    "H4sIAAAAAAACA+2YPXKEIBhAPcpeYFl+RNpkZrdMkws47MKMJIoZwJjcPiSZFEuKVLJKvteglcX7HoqzfO+lVftO9y/aHaolwBHB+dcaSdff1wQ3Dal2vMrA5IN08fHV/2S+9j8b6/Ql+LvLJA+3888YweA/B9HzXjnzqt1yz/jTP6HJLAhBebXD4L8I/8B66c05jkD7PQKtV8/Ij9n7p3Wy/xPRUOi/FP/Aqvf/H/l2VLp1kw1m0OjzJlv/LO2fcSyg/1L8A5vwL88GdTf5/qfp+Y/gGvovxj+wmf8/xsYc+h75Lmf/jCT906bB0H8p/oHN+L/6/zvoIJUMEj350S7ZP0/753D+L8g/sE3/+i1o681o4wAs+v7n6fc/h/d/Qf6Bzfh/PN0fH05oUFnP/yztnxJWQ/+l+AcAAADWxweiMlbaACgAAA==",
  tarTraversal:
    "H4sIAAAAAAACA+3Zz06DMAAGcB5lL7DSPytcNXFHL77A0q1NqEIxbXH69qKLB+vBizCo3y8kwInD16+lcFZvrXJ625j22fiymAId1VJ+nkfp+ec1o1XFio0sZjCEqPz4+OJ/On/P/2ydN6cYbk6DKq+XvxCMIv85jDlvtbcvxk/3jF/zZzwZC3XNZbGhyD+L/GHZ+Z8GH3q/jY3pzFX6z9P5n9Fdhf7nkj8sV2uP4xA4XJaAQ9BPJPTz93+X9r+uOPqfS/6w6Pn/K3zXa3Pwg4u2M+TjZrb+i7T/QtIa/c8lf1hF/upoSbOY93/0P5v8YbmS77/WjXVoWxKaOfsvWNJ/XlUU/c8lf1hN/t/+/3QmKq2iIo+hd1P2X6b9l9j/Z5Q/rDN/8xqNC7Z34wCYdP2X6fu/xPqfUf6wmvwf9rd393vS6Vn3/yLtP2dih/7nkj8sFyHl5eiHGKw2ZTAuWmfa6+7/KRfofy75AwAAAAAAAAAAAAAAAAAAAAAAwN97B09jsQgAUAAA",
  tarSymlink:
    "H4sIAAAAAAACA+3aTXKDIAAFYI+SC8QAim7bmWbZTS+QIYEZaRQ7gLW9fWk7XYQuOl1olLxvo65cPB74wyjeW2HktlHti7K7bAokqDn/Ogbx8fc5JVVFsw3PZjA4L2y4fXabxsv8R22sOnl3dxrE7nr5FwUlyH8OIeettPpV2enu8Wf+lEVjoa4ZzzYE+SeRPyw7/9NgXW+3vlGdukr/WTz/U1JW6H8q+cNytfoYhsDhewk4OHnOXT9//8u4/3XF0P9U8odFz/8/4ZteqoMdjNedyj8vZut/Efe/4KRG/1PJH1aRvzjqvFnM8z/6n0z+sFzR919tQh3aNnfNnP0vaNR/VlUE/U8lf1hN/hf/fzrlhRRe5M+uN1P2n8f953j/Tyh/WGf+6s0r43RvwgCYdP3n8fM/x/qfUP6wmvyf9vcPj/u8k7O+/xdx/xktSvQ/lfxhuVptzkpOuwXk//u/WElC/9kcm1NuvP8AAAAAAAAAAAAAAAAAAAAAAACwTh+G8+vWAFAAAA==",
  tarHardlink:
    "H4sIAAAAAAACA+3aTVKDMAAFYI7SC5Tmh8BWZ+zSjRfopE1miIXgJCB6e6OOi8aF4wIK6fs2wIrFy0v4ySjfG2nVttbNi3a7bAokqIT4Ogbx8fc5JWVJs43IZjD4Xrpw++w2jZf5j8Y6fer93WmQu+vlzzklyH8OIeetcuZVu+nu8Wf+lEVjoaqYyDYE+SeRPyw7/9PgfOe2fa1bfZX+s3j+p6Qo0f9U8oflaswxDIHD9xJw8Oqc+27+/hdx/6uSof+p5A+Lnv9/wred0gc32N60Ov+8mK3/PO4/F6RC/1PJH1aRvzyavF7M8z/6n0z+sFzR919jQx2aJvf1nP3nNOo/K0uC/qeSP6wm/4v/P63upZK9zJ99Z6fsv4j7L/D+n1D+sM789VuvrTedDQNg0vVfxM//Aut/QvnDavJ/2t8/PO7zVs36/s/j/jPKC/Q/lfxhuRpjz1pNuwXk//u/WEF4tqFzbE658f4DAAAAAAAAAAAAAAAAAAAAAADAOn0ALza7RQBQAAA=",
  zipComplete:
    "UEsDBBQAAAAIAAAAIVxkdYIxEAAAAA4AAAAOAAAAY3VhLWRyaXZlci5leGVLLk3UTSnKLEst0kutSAUAUEsDBBQAAAAIAAAAIVw8tMWfFAAAABIAAAASAAAAY3VhLWRyaXZlci11aWEuZXhlSy5N1E0pyixLLdItzUzUS61IBQBQSwMEFAAAAAgAAAAhXJdWRtQWAAAAFAAAABQAAABjdWEtY3Vyc29yLXRoZW1lLmV4ZUsuTdRNLi0qzi/SLclIzU3VS61IBQBQSwMEFAAAAAgAAAAhXG9yJBwUAAAAEgAAABIAAABjdWFfZHJpdmVyX3Nkay5kbGxLLk2MTynKLEstii9OydZLyckBAFBLAwQUAAAACAAAACFcx8Y50BsAAAAcAAAAHAAAAGN1YV9kcml2ZXJfbm9kZV9ydW50aW1lLm5vZGVLLk2MTynKLEstis/LT0mNLyrNK8nMTdUDcQBQSwECFAMUAAAACAAAACFcZHWCMRAAAAAOAAAADgAAAAAAAAAAAAAA7YEAAAAAY3VhLWRyaXZlci5leGVQSwECFAMUAAAACAAAACFcPLTFnxQAAAASAAAAEgAAAAAAAAAAAAAA7YE8AAAAY3VhLWRyaXZlci11aWEuZXhlUEsBAhQDFAAAAAgAAAAhXJdWRtQWAAAAFAAAABQAAAAAAAAAAAAAAO2BgAAAAGN1YS1jdXJzb3ItdGhlbWUuZXhlUEsBAhQDFAAAAAgAAAAhXG9yJBwUAAAAEgAAABIAAAAAAAAAAAAAAO2ByAAAAGN1YV9kcml2ZXJfc2RrLmRsbFBLAQIUAxQAAAAIAAAAIVzHxjnQGwAAABwAAAAcAAAAAAAAAAAAAADtgQwBAABjdWFfZHJpdmVyX25vZGVfcnVudGltZS5ub2RlUEsFBgAAAAAFAAUASAEAAGEBAAAAAA==",
  zipMissing:
    "UEsDBBQAAAAIAAAAIVxkdYIxEAAAAA4AAAAOAAAAY3VhLWRyaXZlci5leGVLLk3UTSnKLEst0kutSAUAUEsDBBQAAAAIAAAAIVyXVkbUFgAAABQAAAAUAAAAY3VhLWN1cnNvci10aGVtZS5leGVLLk3UTS4tKs4v0i3JSM1N1UutSAUAUEsDBBQAAAAIAAAAIVxvciQcFAAAABIAAAASAAAAY3VhX2RyaXZlcl9zZGsuZGxsSy5NjE8pyixLLYovTsnWS8nJAQBQSwMEFAAAAAgAAAAhXMfGOdAbAAAAHAAAABwAAABjdWFfZHJpdmVyX25vZGVfcnVudGltZS5ub2RlSy5NjE8pyixLLYrPy09JjS8qzSvJzE3VA3EAUEsBAhQDFAAAAAgAAAAhXGR1gjEQAAAADgAAAA4AAAAAAAAAAAAAAO2BAAAAAGN1YS1kcml2ZXIuZXhlUEsBAhQDFAAAAAgAAAAhXJdWRtQWAAAAFAAAABQAAAAAAAAAAAAAAO2BPAAAAGN1YS1jdXJzb3ItdGhlbWUuZXhlUEsBAhQDFAAAAAgAAAAhXG9yJBwUAAAAEgAAABIAAAAAAAAAAAAAAO2BhAAAAGN1YV9kcml2ZXJfc2RrLmRsbFBLAQIUAxQAAAAIAAAAIVzHxjnQGwAAABwAAAAcAAAAAAAAAAAAAADtgcgAAABjdWFfZHJpdmVyX25vZGVfcnVudGltZS5ub2RlUEsFBgAAAAAEAAQACAEAAB0BAAAAAA==",
  zipTraversal:
    "UEsDBBQAAAAIAAAAIVxkdYIxEAAAAA4AAAAOAAAAY3VhLWRyaXZlci5leGVLLk3UTSnKLEst0kutSAUAUEsDBBQAAAAIAAAAIVw8tMWfFAAAABIAAAASAAAAY3VhLWRyaXZlci11aWEuZXhlSy5N1E0pyixLLdItzUzUS61IBQBQSwMEFAAAAAgAAAAhXJdWRtQWAAAAFAAAABQAAABjdWEtY3Vyc29yLXRoZW1lLmV4ZUsuTdRNLi0qzi/SLclIzU3VS61IBQBQSwMEFAAAAAgAAAAhXG9yJBwUAAAAEgAAABIAAABjdWFfZHJpdmVyX3Nkay5kbGxLLk2MTynKLEstii9OydZLyckBAFBLAwQUAAAACAAAACFcx8Y50BsAAAAcAAAAHAAAAGN1YV9kcml2ZXJfbm9kZV9ydW50aW1lLm5vZGVLLk2MTynKLEstis/LT0mNLyrNK8nMTdUDcQBQSwMEFAAAAAgAAAAhXB52IV0XAAAAGQAAABkAAAAuLi8uLi8uLi9vdXRzaWRlL3NlbnRpbmVs09PT1wOj/NKS4syUVP3i1LySzLzUHABQSwECFAMUAAAACAAAACFcZHWCMRAAAAAOAAAADgAAAAAAAAAAAAAA7YEAAAAAY3VhLWRyaXZlci5leGVQSwECFAMUAAAACAAAACFcPLTFnxQAAAASAAAAEgAAAAAAAAAAAAAA7YE8AAAAY3VhLWRyaXZlci11aWEuZXhlUEsBAhQDFAAAAAgAAAAhXJdWRtQWAAAAFAAAABQAAAAAAAAAAAAAAO2BgAAAAGN1YS1jdXJzb3ItdGhlbWUuZXhlUEsBAhQDFAAAAAgAAAAhXG9yJBwUAAAAEgAAABIAAAAAAAAAAAAAAO2ByAAAAGN1YV9kcml2ZXJfc2RrLmRsbFBLAQIUAxQAAAAIAAAAIVzHxjnQGwAAABwAAAAcAAAAAAAAAAAAAADtgQwBAABjdWFfZHJpdmVyX25vZGVfcnVudGltZS5ub2RlUEsBAhQDFAAAAAgAAAAhXB52IV0XAAAAGQAAABkAAAAAAAAAAAAAAO2BYQEAAC4uLy4uLy4uL291dHNpZGUvc2VudGluZWxQSwUGAAAAAAYABgCPAQAArwEAAAAA",
};

const releases = [
  {
    format: "tar.gz",
    platform: "linux",
    executable: "cua-driver",
    requiredFiles: ["cua-driver", "cua-cursor-theme", "wayland-helper/winrects@cua/extension.js"],
    files: [
      "cua-driver",
      "cua-cursor-theme",
      "libcua_driver_sdk.so",
      "cua_driver_node_runtime.node",
      "cua_driver_abi.h",
      "wayland-helper/install.sh",
      "wayland-helper/winrects@cua/metadata.json",
      "wayland-helper/winrects@cua/extension.js",
      "wayland-helper/README.md",
    ],
    complete: archives.tarComplete,
    missing: archives.tarMissing,
    traversal: archives.tarTraversal,
  },
  {
    format: "zip",
    platform: "win32",
    executable: "cua-driver.exe",
    requiredFiles: ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"],
    files: [
      "cua-driver.exe",
      "cua-driver-uia.exe",
      "cua-cursor-theme.exe",
      "cua_driver_sdk.dll",
      "cua_driver_node_runtime.node",
    ],
    complete: archives.zipComplete,
    missing: archives.zipMissing,
    traversal: archives.zipTraversal,
  },
] as const;

const makeHarness = Effect.fn("test.makeCuaDriverInstallation")(function* (
  fixture: (typeof releases)[number],
  options: { archive?: string; bytes?: number; sha256?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cua-install-test-" });
  const installRoot = path.join(baseDir, "tools", "cua-driver");
  const destination = path.join(installRoot, "0.34.1");
  const outside = path.join(baseDir, "tools", "outside");
  yield* fs.makeDirectory(outside, { recursive: true });
  yield* fs.writeFileString(path.join(outside, "sentinel"), "untouched");

  const archive = Buffer.from(options.archive ?? fixture.complete, "base64");
  const release = {
    version: "0.34.1",
    archiveName: `cua-driver-fixture.${fixture.format}`,
    format: fixture.format,
    url: `https://example.invalid/cua-driver-0.34.1.${fixture.format}`,
    bytes: options.bytes ?? archive.byteLength,
    sha256: options.sha256 ?? Hex.encode(yield* crypto.digest("SHA-256", archive)),
    executable: fixture.executable,
    requiredFiles: fixture.requiredFiles,
  };
  const requests: string[] = [];
  const publications: string[] = [];
  const trackedFs = FileSystem.FileSystem.of({
    ...fs,
    rename: (source, target) =>
      Effect.gen(function* () {
        if (target === destination) {
          expect(path.relative(installRoot, source)).not.toMatch(/^(?:\.\.|[/\\])/u);
          expect(yield* fs.exists(destination)).toBe(false);
          for (const file of fixture.files) {
            expect(yield* fs.readFileString(path.join(source, file))).toBe(file);
          }
          publications.push(target);
        }
        yield* fs.rename(source, target);
      }),
  });
  const makeInstallation = CuaDriverInstallation.makeCuaDriverInstallation({
    baseDir,
    release,
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, trackedFs),
    Effect.provideService(HostProcess.Platform, fixture.platform),
    Effect.provideService(HostProcess.Architecture, "x64"),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request.url);
          return Object.defineProperty(
            HttpClientResponse.fromWeb(request, new Response(null)),
            "stream",
            { value: Stream.make(archive.subarray(0, 31), archive.subarray(31)) },
          );
        }),
      ),
    ),
  );
  const installation = yield* makeInstallation;
  const expectUnpublished = Effect.gen(function* () {
    expect(publications).toEqual([]);
    expect(yield* fs.exists(destination)).toBe(false);
    expect(yield* fs.readDirectory(installRoot)).toEqual([]);
    expect(yield* fs.readFileString(path.join(outside, "sentinel"))).toBe("untouched");
    expect(yield* fs.readDirectory(outside)).toEqual(["sentinel"]);
    expect((yield* fs.readDirectory(path.join(baseDir, "tools"))).sort()).toEqual([
      "cua-driver",
      "outside",
    ]);
  });
  return {
    installation,
    makeInstallation,
    fs,
    path,
    installRoot,
    destination,
    release,
    requests,
    publications,
    expectUnpublished,
  };
});

it.layer(NodeServices.layer)("CuaDriverInstallation", (it) => {
  it.effect.each(releases)(
    "publishes a complete $format release in T3 home and reuses it across installer instances",
    (fixture) =>
      Effect.gen(function* () {
        const h = yield* makeHarness(fixture);

        const executable = yield* h.installation.executable;

        expect(executable).toBe(h.path.join(h.destination, fixture.executable));
        for (const file of fixture.files) {
          expect(yield* h.fs.readFileString(h.path.join(h.destination, file))).toBe(file);
        }
        expect(h.publications).toEqual([h.destination]);
        expect(yield* h.fs.readDirectory(h.installRoot)).toEqual(["0.34.1"]);
        expect(yield* h.installation.executable).toBe(executable);
        const freshInstallation = yield* h.makeInstallation;
        expect(yield* freshInstallation.executable).toBe(executable);
        expect(h.requests).toEqual([h.release.url]);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects short, oversized, and wrong-SHA downloads without publishing", () =>
    Effect.gen(function* () {
      const fixture = releases[0];
      const bytes = Buffer.from(fixture.complete, "base64").byteLength;
      for (const options of [
        { bytes: bytes + 1 },
        { bytes: bytes - 1 },
        { sha256: "0".repeat(64) },
      ]) {
        const h = yield* makeHarness(fixture, options);

        const error = yield* Effect.flip(h.installation.executable);

        expect(error._tag).toBe("CuaDriverInstallError");
        expect(h.requests).toHaveLength(1);
        yield* h.expectUnpublished;
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects TAR and ZIP traversal entries without overwriting outside files", () =>
    Effect.gen(function* () {
      for (const fixture of releases) {
        const h = yield* makeHarness(fixture, { archive: fixture.traversal });

        const error = yield* Effect.flip(h.installation.executable);

        expect(error._tag).toBe("CuaDriverInstallError");
        yield* h.expectUnpublished;
      }
    }).pipe(Effect.scoped),
  );

  it.effect("rejects TAR symlinks and hardlinks even when their targets are in the archive", () =>
    Effect.gen(function* () {
      for (const archive of [archives.tarSymlink, archives.tarHardlink]) {
        const h = yield* makeHarness(releases[0], { archive });

        const error = yield* Effect.flip(h.installation.executable);

        expect(error._tag).toBe("CuaDriverInstallError");
        yield* h.expectUnpublished;
      }
    }).pipe(Effect.scoped),
  );

  it.effect("does not publish a verified archive missing a required companion", () =>
    Effect.gen(function* () {
      for (const fixture of releases) {
        const h = yield* makeHarness(fixture, { archive: fixture.missing });

        const error = yield* Effect.flip(h.installation.executable);

        expect(error._tag).toBe("CuaDriverInstallError");
        yield* h.expectUnpublished;
      }
    }).pipe(Effect.scoped),
  );
});
