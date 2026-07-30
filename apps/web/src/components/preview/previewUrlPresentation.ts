interface PreviewUrlPresentationInput {
  readonly url: string;
  readonly environmentLabel: string;
  readonly environmentHttpBaseUrl: string;
}

export function formatPreviewUrl(input: PreviewUrlPresentationInput): string | null {
  try {
    const url = new URL(input.url);
    const environmentUrl = new URL(input.environmentHttpBaseUrl);
    if (url.origin === environmentUrl.origin && url.pathname.startsWith("/api/assets/")) {
      const encodedFileName = url.pathname.split("/").at(-1);
      if (!encodedFileName) {
        return null;
      }
      const fileName = decodeURIComponent(encodedFileName);
      if (!fileName || fileName === "." || fileName === "..") {
        return null;
      }
      return `${input.environmentLabel} · ${fileName}`;
    }

    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}
