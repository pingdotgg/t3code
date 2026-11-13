// Effect-free so the service launcher shares the pre-lock owner identity check with server startup.

export const legacyOwnerStartTimeCommand = (pid: number, platform: NodeJS.Platform) => {
  const windows = platform === "win32";
  return {
    command: windows ? "powershell.exe" : "ps",
    args: windows
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ]
      : ["-p", String(pid), "-o", "lstart="],
    env: { LC_ALL: "C", TZ: "UTC" },
  };
};

// ps reports whole seconds. Unknown identity (no output) stays conservative.
export const legacyOwnerStartedBeforeRecord = (
  output: string | undefined,
  recordedAt: number,
  platform: NodeJS.Platform,
): boolean => {
  if (output === undefined) return true;
  const trimmed = output.trim();
  const startedAt = Date.parse(platform === "win32" ? trimmed : `${trimmed} UTC`);
  return !Number.isFinite(startedAt) || startedAt <= recordedAt + 1_000;
};
