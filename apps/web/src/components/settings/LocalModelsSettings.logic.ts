import type { OllamaHardware, OllamaInstallEvent, OllamaStatus } from "@t3tools/contracts";

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function progressPercent(completed: number | null, total: number | null): number | null {
  if (completed === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export function ollamaStatusSummary(status: OllamaStatus): string {
  const where = status.baseUrl.replace(/^https?:\/\//, "");
  if (status.reachable) {
    const version = status.version ? ` ${status.version}` : "";
    return status.runtime === "managed"
      ? `Ollama${version} is running at ${where}, installed and started by Continuum.`
      : `Ollama${version} is running at ${where}.`;
  }
  if (status.managedInstalled) return "Ollama is installed but not running.";
  return status.canInstall
    ? "Ollama is not installed. Continuum can download and run it for you, no admin rights needed."
    : "Ollama is not available for this system. Install it from ollama.com, then reopen this page.";
}

export function installStageLabel(event: OllamaInstallEvent | null): string {
  if (event === null || event.type === "complete") return "Installing…";
  switch (event.stage) {
    case "downloading":
      return "Downloading Ollama";
    case "extracting":
      return "Unpacking";
    case "starting":
      return "Starting Ollama";
  }
}

export function hardwareSummary(hardware: OllamaHardware): string {
  const memory = `${formatBytes(hardware.totalMemoryBytes)} memory`;
  const gpus = hardware.gpus
    .map((gpu) =>
      gpu.memoryBytes === null ? gpu.name : `${gpu.name} (${formatBytes(gpu.memoryBytes)})`,
    )
    .join(", ");
  return [`${hardware.cpuCount} CPU threads`, memory, gpus || "no supported GPU detected"].join(
    " · ",
  );
}
