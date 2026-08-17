const INTEL_GPU_PATTERN = /intel|amd|radeon|nvidia|geforce/i;
const APPLE_SILICON_GPU_PATTERN = /\bapple\s+m\d/i;

export function macArchFromGpuRenderer(renderer: string): "arm64" | "x64" {
  if (INTEL_GPU_PATTERN.test(renderer)) {
    return "x64";
  }
  if (APPLE_SILICON_GPU_PATTERN.test(renderer)) {
    return "arm64";
  }

  // Generic "Apple GPU" renderers are ambiguous on Safari. x64 is the safe
  // fallback because Apple Silicon can run it through Rosetta, while Intel
  // Macs cannot run an arm64 build.
  return "x64";
}
