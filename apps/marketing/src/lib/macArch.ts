const INTEL_GPU_PATTERN = /intel|amd|radeon|nvidia|geforce/i;
const APPLE_SILICON_GPU_PATTERN = /\bapple\s+(?:m\d|gpu)\b/i;

export function macArchFromGpuRenderer(renderer: string): "arm64" | "x64" {
  if (INTEL_GPU_PATTERN.test(renderer)) {
    return "x64";
  }
  if (APPLE_SILICON_GPU_PATTERN.test(renderer)) {
    return "arm64";
  }

  // Keep the fallback compatible with Intel Macs when WebGL is unavailable.
  return "x64";
}
