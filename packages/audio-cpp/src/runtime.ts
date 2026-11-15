export const AUDIO_CPP_VERSION = "v0.9.4";

export type AudioCppRuntime = {
  readonly filename: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  /** The real library file inside the archive, not a version symlink. */
  readonly library: string;
  /** The session backend the build accelerates; every build can also run on the CPU. */
  readonly backend: "metal" | "vulkan" | "cpu";
  /** The oldest glibc the build loads on, from the versions its symbols require. */
  readonly minimumGlibc?: string;
};

const runtime = (
  name: string,
  size: number,
  sha256: string,
  library: string,
  backend: AudioCppRuntime["backend"],
  minimumGlibc?: string,
): AudioCppRuntime => {
  const filename = `audio-${AUDIO_CPP_VERSION}-lib-${name}`;
  return {
    filename,
    url: `https://github.com/0xShug0/audio.cpp/releases/download/${AUDIO_CPP_VERSION}/${filename}`,
    size,
    sha256,
    library,
    backend,
    ...(minimumGlibc ? { minimumGlibc } : {}),
  };
};

// Upstream publishes no Linux arm64 library. The portable Linux build loads Vulkan as a plugin and
// otherwise runs on the CPU. The Windows Vulkan build links vulkan-1.dll and fails to load without
// a GPU driver, so the CPU build is installed beside it as the fallback.
const RUNTIMES: Readonly<Record<string, readonly AudioCppRuntime[]>> = {
  "darwin-arm64": [
    runtime(
      "macos-arm64-metal.tar.gz",
      14_422_864,
      "bb1141185d15891d1c6b53f05cd55b0b93614804b340289799cff497fe87cf5b",
      "libs/libaudiocpp.0.1.0.dylib",
      "metal",
    ),
  ],
  "darwin-x64": [
    runtime(
      "macos-x64-metal.tar.gz",
      15_509_881,
      "f0b6c392be9ca933ee2b813d036484c03a15838c55345e08472ec14251a64ad8",
      "libs/libaudiocpp.0.1.0.dylib",
      "metal",
    ),
  ],
  "linux-x64": [
    runtime(
      "ubuntu-x64-vulkan-portable.tar.gz",
      47_415_047,
      "d5dfe390c78acadd153fdb6b8c448cca1ce2d1255fc7998d99ec3df0c29fddfb",
      "libs/libaudiocpp.so.0.1.0",
      "vulkan",
      "2.43",
    ),
  ],
  "win32-x64": [
    runtime(
      "windows-x64-vulkan.zip",
      30_751_615,
      "cf2fabd8630050491a92c002d7bdfd29eca722c31fb3b8cb0ba9b9c5e6e9ff3d",
      "libs/audiocpp.dll",
      "vulkan",
    ),
    runtime(
      "windows-x64-cpu.zip",
      13_542_870,
      "41f779687dc20e36900797f43d6762a9542c593931d4b3f3f5e877b0db9baa5e",
      "libs/audiocpp.dll",
      "cpu",
    ),
  ],
};

/** All builds a host installs, in preference order: the first that loads is used. */
export const audioCppRuntimes = (platform: string, architecture: string) =>
  RUNTIMES[`${platform}-${architecture}`] ?? [];
