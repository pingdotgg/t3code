/** A release of github.com/pingdotgg/audio.cpp, whose `T3 release` workflow builds these libraries. */
export const AUDIO_CPP_VERSION = "t3-2026.11.15";

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
    url: `https://github.com/pingdotgg/audio.cpp/releases/download/${AUDIO_CPP_VERSION}/${filename}`,
    size,
    sha256,
    library,
    backend,
    ...(minimumGlibc ? { minimumGlibc } : {}),
  };
};

// Linux and Windows load Vulkan as a plugin and otherwise run on the CPU. Intel Macs build
// without Metal, as upstream's do.
const RUNTIMES: Readonly<Record<string, AudioCppRuntime>> = {
  "darwin-arm64": runtime(
    "macos-arm64-metal.tar.gz",
    15_050_502,
    "d310a03ec334c9eca108afddc155285d415c4a9de7de6f1f11852792dea4ef40",
    "libs/libaudiocpp.0.1.0.dylib",
    "metal",
  ),
  "darwin-x64": runtime(
    "macos-x64-cpu.tar.gz",
    16_205_264,
    "e28f38d904ca2f62582e30b66daf223a102c49d72dfc4de6652ebc49d560b497",
    "libs/libaudiocpp.0.1.0.dylib",
    "cpu",
  ),
  "linux-x64": runtime(
    "linux-x64-vulkan.tar.gz",
    46_480_833,
    "bfb156d9803a9d72321edf2618132f5c253d62774d87b8a84404c908bcb14c8d",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "linux-arm64": runtime(
    "linux-arm64-vulkan.tar.gz",
    40_185_095,
    "5dcf0ca69930cb326228379d21c357a9474e5fb414b7fbbdbad8d59dc6be9eb8",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "win32-x64": runtime(
    "windows-x64-vulkan.zip",
    34_389_751,
    "80c98ef7ccb2ebdb343838727cfce20cceefbf35eeeda6a0ffae4a344f06a613",
    "libs/audiocpp.dll",
    "vulkan",
  ),
};

export const audioCppRuntime = (platform: string, architecture: string) =>
  RUNTIMES[`${platform}-${architecture}`];
