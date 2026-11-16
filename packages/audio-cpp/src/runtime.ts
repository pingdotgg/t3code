/** A release of github.com/pingdotgg/audio.cpp, whose `T3 release` workflow builds these libraries. */
export const AUDIO_CPP_VERSION = "t3-2026.11.16";

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
    15_050_495,
    "81ee4b878e26c8c7b3eb12f6c50c94e2db3e77916e2eadb180957e97838271e2",
    "libs/libaudiocpp.0.1.0.dylib",
    "metal",
  ),
  "darwin-x64": runtime(
    "macos-x64-cpu.tar.gz",
    16_205_261,
    "94465d3a325d776198821f7216a52caa6db1f4f11fb20b5490f2789f7e7e54a6",
    "libs/libaudiocpp.0.1.0.dylib",
    "cpu",
  ),
  "linux-x64": runtime(
    "linux-x64-vulkan.tar.gz",
    46_480_819,
    "d6774bc02102fa554db246e2dbf30c452cbec7dfe7d33844b89c399d758d8d01",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "linux-arm64": runtime(
    "linux-arm64-vulkan.tar.gz",
    40_185_132,
    "6b03aebe87eb85f433faf3a0cd4e54ed7d45dde2654cf98ae8ac0eebfa2163a3",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "win32-arm64": runtime(
    "windows-arm64-vulkan.zip",
    34_518_475,
    "576729077a80984c24a5b54c5ca237b388e5d0d8b90b394f8463314fd38b1bfc",
    "libs/audiocpp.dll",
    "vulkan",
  ),
  "win32-x64": runtime(
    "windows-x64-vulkan.zip",
    34_389_747,
    "91780513f8c374e4736c27850a988f4205526488388698e24eaa322682c16471",
    "libs/audiocpp.dll",
    "vulkan",
  ),
};

export const audioCppRuntime = (platform: string, architecture: string) =>
  RUNTIMES[`${platform}-${architecture}`];
