// Regenerate after changing Swift packages or the vendored Ghostty framework.
// Ghostty dependencies match cf8edc23f3a6a87a96e41a90013e89e987d34980,
// src/build/SharedDeps.zig, its package pins, and the iOS archive members.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const app = new URL("../", import.meta.url);
const output = new URL("Resources/NativeLicenses.json", app);
const resolved = JSON.parse(
  await NodeFSP.readFile(
    new URL("T3Code.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved", app),
    "utf8",
  ),
);
const bundled = [
  {
    name: "GhosttyKit",
    version: "cf8edc23f3a6a87a96e41a90013e89e987d34980",
    url: "https://raw.githubusercontent.com/Yash-Singh1/ghostty/cf8edc23f3a6a87a96e41a90013e89e987d34980/LICENSE",
  },
  {
    name: "FreeType",
    version: "2.13.2",
    url: "https://deps.files.ghostty.org/freetype-1220b81f6ecfb3fd222f76cf9106fecfa6554ab07ec7fdc4124b9bb063ae2adf969d.tar.gz",
    files: ["LICENSE.TXT", "docs/FTL.TXT", "src/bdf/README", "src/pcf/README"],
    preamble: "This software is based in part on the work of the FreeType Team.",
  },
  {
    name: "libpng",
    version: "1.6.43",
    url: "https://deps.files.ghostty.org/libpng-1220aa013f0c83da3fb64ea6d327f9173fa008d10e28bc9349eac3463457723b1c66.tar.gz",
    files: ["LICENSE"],
  },
  {
    name: "zlib",
    version: "1.3.1",
    url: "https://deps.files.ghostty.org/zlib-1220fed0c74e1019b3ee29edae2051788b080cd96e90d56836eea857b0b966742efb.tar.gz",
    files: ["LICENSE"],
  },
  {
    name: "oniguruma",
    version: "6.9.9",
    url: "https://deps.files.ghostty.org/oniguruma-1220c15e72eadd0d9085a8af134904d9a0f5dfcbed5f606ad60edc60ebeccd9706bb.tar.gz",
    files: ["COPYING"],
  },
  {
    name: "glslang",
    version: "14.2.0",
    url: "https://deps.files.ghostty.org/glslang-12201278a1a05c0ce0b6eb6026c65cd3e9247aa041b1c260324bf29cee559dd23ba1.tar.gz",
    files: ["LICENSE.txt"],
  },
  {
    name: "spirv-cross",
    version: "476f384eb7d9e48613c45179e502a15ab95b6b49",
    url: "https://deps.files.ghostty.org/spirv_cross-1220fb3b5586e8be67bc3feb34cbe749cf42a60d628d2953632c2f8141302748c8da.tar.gz",
    files: ["LICENSE"],
  },
  {
    name: "sentry",
    version: "0.7.8",
    url: "https://deps.files.ghostty.org/sentry-1220446be831adcca918167647c06c7b825849fa3fba5f22da394667974537a9c77e.tar.gz",
    files: ["LICENSE"],
  },
  {
    name: "breakpad",
    version: "b99f444ba5f6b98cac261cbb391d8766b34a5918",
    url: "https://deps.files.ghostty.org/breakpad-b99f444ba5f6b98cac261cbb391d8766b34a5918.tar.gz",
    files: ["LICENSE"],
  },
  {
    name: "highway",
    version: "66486a10623fa0d72fe91260f96c892e41aceb06",
    url: "https://deps.files.ghostty.org/highway-66486a10623fa0d72fe91260f96c892e41aceb06.tar.gz",
    files: ["LICENSE"],
  },
  {
    name: "libintl",
    version: "0.24",
    url: "https://deps.files.ghostty.org/gettext-0.24.tar.gz",
    files: ["gettext-runtime/intl/COPYING.LIB"],
  },
  {
    name: "Dear ImGui",
    version: "1.92.5-docking",
    url: "https://deps.files.ghostty.org/N-V-__8AAEbOfQBnvcFcCX2W5z7tDaN8vaNZGamEQtNOe0UI.tar.gz",
    files: ["LICENSE.txt"],
  },
  {
    name: "Dear Bindings",
    version: "0.17",
    url: "https://raw.githubusercontent.com/dearimgui/dear_bindings/v0.17/LICENSE.txt",
  },
  {
    name: "Wuffs",
    version: "7411f488fe2e2c205c3d3b3d28638b7356522930",
    url: "https://deps.files.ghostty.org/wuffs-7411f488fe2e2c205c3d3b3d28638b7356522930.tar.gz",
    files: ["LICENSE"],
  },
  {
    name: "pixels",
    version: "d843c2714d32e15b48b8d7eeb480295af537f877",
    url: "https://deps.files.ghostty.org/pixels-12207ff340169c7d40c570b4b6a97db614fe47e0d83b5801a932dcd44917424c8806.tar.gz",
    files: ["LICENSE"],
  },
  {
    name: "simdutf",
    version: "9.0.0",
    url: "https://raw.githubusercontent.com/simdutf/simdutf/v9.0.0/LICENSE-MIT",
  },
  {
    name: "libxev",
    version: "9ce8e8e6ff89e583258a7f8e7adeeeaeae8611bf",
    url: "https://raw.githubusercontent.com/mitchellh/libxev/9ce8e8e6ff89e583258a7f8e7adeeeaeae8611bf/LICENSE",
  },
  {
    name: "libvaxis",
    version: "1dbbe575dff4586fe51e3217aa5c3fecdcbb6089",
    url: "https://raw.githubusercontent.com/rockorager/libvaxis/1dbbe575dff4586fe51e3217aa5c3fecdcbb6089/LICENSE",
  },
  {
    name: "z2d",
    version: "7dbae85c81784dba9988320bf9543ed9a81350c8",
    url: "https://raw.githubusercontent.com/vancluever/z2d/7dbae85c81784dba9988320bf9543ed9a81350c8/LICENSE",
  },
  {
    name: "zig-objc",
    version: "c8de82ff80281215ad92900866dab7103a8efa8b",
    url: "https://raw.githubusercontent.com/mitchellh/zig-objc/c8de82ff80281215ad92900866dab7103a8efa8b/LICENSE",
  },
  {
    name: "uucode",
    version: "2826a37a4562284fdacd8fa029d49509cc9bffcd",
    url: "https://raw.githubusercontent.com/jacobsandlund/uucode/2826a37a4562284fdacd8fa029d49509cc9bffcd/LICENSE.md",
  },
  {
    name: "zf",
    version: "c35c421f84895193246db06c40683c1a30e616ef",
    url: "https://raw.githubusercontent.com/natecraddock/zf/c35c421f84895193246db06c40683c1a30e616ef/LICENSE",
  },
  {
    name: "JetBrains Mono",
    version: "2.304",
    url: "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/OFL.txt",
  },
  {
    name: "Symbols Nerd Font",
    version: "3.4.0",
    url: "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/v3.4.0/patched-fonts/NerdFontsSymbolsOnly/LICENSE",
  },
  {
    name: "Zig runtime",
    version: "0.16.0",
    url: "https://codeberg.org/ziglang/zig/raw/tag/0.16.0/LICENSE",
  },
  {
    name: "stb_image",
    version: "Ghostty cf8edc23f3a6",
    url: "https://raw.githubusercontent.com/Yash-Singh1/ghostty/cf8edc23f3a6a87a96e41a90013e89e987d34980/src/stb/stb_image.h",
    start: "ALTERNATIVE A - MIT License",
    end: "ALTERNATIVE B - Public Domain",
  },
  {
    name: "stb_image_resize",
    version: "Ghostty cf8edc23f3a6",
    url: "https://raw.githubusercontent.com/Yash-Singh1/ghostty/cf8edc23f3a6a87a96e41a90013e89e987d34980/src/stb/stb_image_resize.h",
    start: "ALTERNATIVE A - MIT License",
    end: "ALTERNATIVE B - Public Domain",
  },
  {
    name: "MPack",
    version: "Sentry 0.7.8",
    url: "https://deps.files.ghostty.org/sentry-1220446be831adcca918167647c06c7b825849fa3fba5f22da394667974537a9c77e.tar.gz",
    files: ["vendor/mpack.c"],
    start: "Copyright",
    end: "*/",
  },
  {
    name: "Unicode data",
    version: "uucode 2826a37a4562",
    url: "https://raw.githubusercontent.com/jacobsandlund/uucode/2826a37a4562284fdacd8fa029d49509cc9bffcd/licenses/LICENSE_unicode",
  },
  {
    name: "UTF-8 decoder",
    version: "uucode 2826a37a4562",
    url: "https://raw.githubusercontent.com/jacobsandlund/uucode/2826a37a4562284fdacd8fa029d49509cc9bffcd/licenses/LICENSE_Bjoern_Hoehrmann",
  },
  {
    name: "simdutf portability code",
    version: "Ghostty cf8edc23f3a6",
    url: "https://raw.githubusercontent.com/Yash-Singh1/ghostty/cf8edc23f3a6a87a96e41a90013e89e987d34980/pkg/simdutf/vendor/simdutf.h",
    start: "Copyright (c) 2016-",
    end: "*/",
  },
  {
    name: "libphonenumber metadata",
    version: "PhoneNumberKit 4.3.0",
    url: "https://raw.githubusercontent.com/google/libphonenumber/v9.0.17/LICENSE",
    preamble: "Copyright (C) 2009 The Libphonenumber Authors",
  },
];

const swiftPackages = resolved.pins.map((pin) => ({
  name:
    { "clerk-ios": "Clerk", nuke: "Nuke", phonenumberkit: "PhoneNumberKit" }[pin.identity] ??
    pin.identity,
  version: pin.state.version,
  revision: pin.state.revision,
  url:
    pin.location
      .replace("https://github.com/", "https://raw.githubusercontent.com/")
      .replace(/\.git$/, "") +
    "/" +
    pin.state.revision +
    "/LICENSE",
}));

const ghosttyNotice = await NodeFSP.readFile(
  new URL("../mobile/modules/t3-terminal/THIRD_PARTY_NOTICES.md", app),
  "utf8",
);
const ghosttyRevision = ghosttyNotice.match(/Vendored revision: `([a-f0-9]+)`/)?.[1];
if (bundled.find((source) => source.name === "GhosttyKit").version !== ghosttyRevision) {
  throw new Error("Review the native license sources after updating GhosttyKit.");
}
const phoneNumberVersion = resolved.pins.find((pin) => pin.identity === "phonenumberkit").state
  .version;
bundled.find((source) => source.name === "libphonenumber metadata").version =
  "PhoneNumberKit " + phoneNumberVersion;

if (process.argv.includes("--check")) {
  const saved = JSON.parse(await NodeFSP.readFile(output, "utf8"));
  for (const source of [...swiftPackages, ...bundled]) {
    const entry = saved.find((entry) => entry.name === source.name);
    if (!entry || entry.version !== source.version || entry.revision !== source.revision) {
      throw new Error("License snapshot is stale: " + source.name);
    }
  }
  if (saved.length !== swiftPackages.length + bundled.length) {
    throw new Error("License snapshot contains unexpected entries.");
  }
  console.log("Native license metadata matches the dependency pins.");
} else {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-native-licenses-"));
  const downloads = new Map();
  async function download(url) {
    if (!downloads.has(url)) {
      downloads.set(
        url,
        fetch(url).then(async (response) => {
          if (!response.ok) throw new Error(url + ": " + response.status);
          return Buffer.from(await response.arrayBuffer());
        }),
      );
    }
    return downloads.get(url);
  }
  async function notice(source) {
    const bytes = await download(source.url);
    const texts = [];
    if (source.files) {
      const archive = NodePath.join(directory, encodeURIComponent(source.name) + ".tar");
      await NodeFSP.writeFile(archive, bytes);
      const listing = (
        await run("tar", ["-tf", archive], { maxBuffer: 8 * 1024 * 1024 })
      ).stdout.split("\n");
      for (const suffix of source.files) {
        const matches = listing
          .filter((path) => path === suffix || path.endsWith("/" + suffix))
          .sort((a, b) => a.split("/").length - b.split("/").length);
        if (!matches[0]) throw new Error(source.name + " is missing " + suffix);
        const path = matches[0];
        texts.push({
          sourceURL: source.url + "#" + path,
          text: (await run("tar", ["-xOf", archive, path], { maxBuffer: 4 * 1024 * 1024 })).stdout,
        });
      }
    } else {
      texts.push({ sourceURL: source.url, text: bytes.toString("utf8") });
    }
    for (const notice of texts) {
      if (source.start) {
        const start = notice.text.indexOf(source.start);
        const end = notice.text.indexOf(source.end, start);
        if (start < 0 || end < 0) throw new Error("Missing license markers: " + source.name);
        notice.text = notice.text.slice(start, end);
      }
      if (source.preamble && notice === texts[0])
        notice.text = source.preamble + "\n\n" + notice.text;
      if (notice.text.trim().length < 100) throw new Error("Missing license text: " + source.name);
    }
    return {
      name: source.name,
      version: source.version,
      ...(source.revision ? { revision: source.revision } : {}),
      notices: texts,
    };
  }
  try {
    const result = [];
    const sources = [...swiftPackages, ...bundled];
    for (let index = 0; index < sources.length; index += 4) {
      result.push(...(await Promise.all(sources.slice(index, index + 4).map(notice))));
    }
    result.sort((a, b) => a.name.localeCompare(b.name, "en"));
    await NodeFSP.writeFile(output, JSON.stringify(result, null, 2) + "\n");
    console.log("Saved " + result.length + " native license notices.");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
