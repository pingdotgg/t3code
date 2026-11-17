/** A release of github.com/pingdotgg/audio.cpp, whose `T3 release` workflow builds these libraries. */
export const AUDIO_CPP_VERSION = "t3-2026.11.17";

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
    15_293_898,
    "4f06e1d834e2e7a43fb9f257d561e946196a9e2459a8b4648cf36e24a0e5ac14",
    "libs/libaudiocpp.0.1.0.dylib",
    "metal",
  ),
  "darwin-x64": runtime(
    "macos-x64-cpu.tar.gz",
    16_460_460,
    "02066f1ee9a7cad1a601d65cc6be3349ad570d9b9268c65e17b7cf88b706f10b",
    "libs/libaudiocpp.0.1.0.dylib",
    "cpu",
  ),
  "linux-x64": runtime(
    "linux-x64-vulkan.tar.gz",
    46_783_748,
    "3b6ce18303f203eabc82997a2af14e6052f5aad2ea326e444973200a5fd908ca",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "linux-arm64": runtime(
    "linux-arm64-vulkan.tar.gz",
    40_477_068,
    "39c59b4ef06fe1ac8fd49fbdf14d3392515949d719ce1ebda5134a73a5c4fd10",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "win32-arm64": runtime(
    "windows-arm64-vulkan.zip",
    34_757_900,
    "2e3692e2eab320d58056e38492d8fa2dc8e0de9699e156d783addae3c789c50c",
    "libs/audiocpp.dll",
    "vulkan",
  ),
  "win32-x64": runtime(
    "windows-x64-vulkan.zip",
    34_618_677,
    "25b3516d94d0f56b284689b3bf358b3f90e4f1a8ec8398c41ef5fa3806abbb1c",
    "libs/audiocpp.dll",
    "vulkan",
  ),
};

/** eSpeak-ng's phoneme tables and dictionaries for Kokoro; every library links eSpeak itself. */
export const AUDIO_CPP_ESPEAK_DATA = {
  filename: `audio-${AUDIO_CPP_VERSION}-espeak-ng-data.bin`,
  url: `https://github.com/pingdotgg/audio.cpp/releases/download/${AUDIO_CPP_VERSION}/audio-${AUDIO_CPP_VERSION}-espeak-ng-data.bin`,
  size: 18_383_744,
  sha256: "59e581e5d0074112285592be38288da1e5e1f158b61ae236c99abbd6ed09e7c0",
};

export const audioCppRuntime = (platform: string, architecture: string) =>
  RUNTIMES[`${platform}-${architecture}`];
