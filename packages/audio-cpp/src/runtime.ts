/** A release of github.com/pingdotgg/audio.cpp, whose `T3 release` workflow builds these libraries. */
export const AUDIO_CPP_VERSION = "t3-2026.11.26";

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
    16_377_620,
    "8d61a9c1b6fe480819dd827e2d60e0fb1f2f619f75b098ef55b28791f873ab3f",
    "libs/libaudiocpp.0.1.0.dylib",
    "metal",
  ),
  "darwin-x64": runtime(
    "macos-x64-cpu.tar.gz",
    17_637_417,
    "a33c4d4844a2fbabebf537f08db92c0a68161c07944724a448350917d5a8f4a2",
    "libs/libaudiocpp.0.1.0.dylib",
    "cpu",
  ),
  "linux-x64": runtime(
    "linux-x64-vulkan.tar.gz",
    48_506_556,
    "5cf8880a10f932b6579435a24f280dacebf1b1987bb2bd624d58dcfabda91fd0",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "linux-arm64": runtime(
    "linux-arm64-vulkan.tar.gz",
    41_903_323,
    "8b43275d0ede50f172ef2ab2df42089d2bd42a1bf44672ccd518e872c245e110",
    "libs/libaudiocpp.so.0.1.0",
    "vulkan",
    "2.28",
  ),
  "win32-arm64": runtime(
    "windows-arm64-vulkan.zip",
    35_902_008,
    "2a02662c00384e8828e6517f4ab7bee753ac4ecde8477c5d171918b272122cef",
    "libs/audiocpp.dll",
    "vulkan",
  ),
  "win32-x64": runtime(
    "windows-x64-vulkan.zip",
    35_691_331,
    "a805c2e461f2ebc109dcfc498fd230ff17b1c747874800f629711c695598480c",
    "libs/audiocpp.dll",
    "vulkan",
  ),
};

/** eSpeak-ng's phoneme tables and dictionaries, for Kokoro, Piper, Kitten TTS, and Inflect. */
export const AUDIO_CPP_ESPEAK_DATA = {
  filename: `audio-${AUDIO_CPP_VERSION}-espeak-ng-data.bin`,
  url: `https://github.com/pingdotgg/audio.cpp/releases/download/${AUDIO_CPP_VERSION}/audio-${AUDIO_CPP_VERSION}-espeak-ng-data.bin`,
  size: 18_383_744,
  sha256: "8455c0cab72e2c0703dd6c3114a898579a5ff47766f4436d04772e486ed7facf",
};

export const audioCppRuntime = (platform: string, architecture: string) =>
  RUNTIMES[`${platform}-${architecture}`];
