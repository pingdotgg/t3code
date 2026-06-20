export interface UrlDiagnostics {
  readonly inputLength: number;
  readonly protocol?: string;
  readonly hostname?: string;
}

export function getUrlDiagnostics(input: string): UrlDiagnostics {
  const inputLength = input.length;
  try {
    const url = new URL(input);
    return {
      inputLength,
      protocol: url.protocol,
      hostname: url.hostname,
    };
  } catch {
    return { inputLength };
  }
}
