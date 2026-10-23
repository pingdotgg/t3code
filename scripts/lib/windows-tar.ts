export function windowsSystemTar(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}
