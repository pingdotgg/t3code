/** Resolves web references without inheriting the desktop renderer's custom app scheme. */
export function resolveProtocolRelativeMediaUrl(src: string): string {
  if (!src.startsWith("//")) return src;
  const protocol =
    typeof window !== "undefined" && window.location.protocol === "http:" ? "http:" : "https:";
  return `${protocol}${src}`;
}

// Data URL escapes are raw bytes, not UTF-8, so `%89` must stay one byte.
function decodePercentBytes(payload: string) {
  const encoder = new TextEncoder();
  return Uint8Array.from(
    payload
      .split(/(%[0-9a-f]{2})/i)
      .flatMap((part) =>
        /^%[0-9a-f]{2}$/i.test(part)
          ? [Number.parseInt(part.slice(1), 16)]
          : [...encoder.encode(part)],
      ),
  );
}

/** Decodes inline media locally; desktop connect-src omits `data:`, so fetch() cannot read it. */
function readDataUrlBlob(src: string): Blob {
  // A fragment is never part of the payload; a literal `#` in data must be escaped as `%23`.
  const url = src.split("#", 1)[0] ?? src;
  const comma = url.indexOf(",");
  const [mimeType = "", ...parameters] = url.slice("data:".length, comma).split(";");
  const payload = url.slice(comma + 1);
  try {
    if (comma < 0) throw new Error("Missing data URL payload.");
    const isBase64 = parameters.some((parameter) => parameter.trim().toLowerCase() === "base64");
    // Base64 text is ASCII, so any escape that is not valid UTF-8 is malformed anyway.
    const bytes = isBase64
      ? Uint8Array.from(atob(decodeURIComponent(payload)), (char) => char.charCodeAt(0))
      : decodePercentBytes(payload);
    return new Blob([bytes], { type: mimeType || "text/plain" });
  } catch (cause) {
    throw new Error("This inline media could not be decoded.", { cause });
  }
}

async function readMediaBlob(src: string): Promise<Blob> {
  if (/^data:/i.test(src)) return readDataUrlBlob(src);
  let response: Response;
  try {
    response = await fetch(src);
  } catch (cause) {
    throw new Error(
      "The file could not be fetched. The host may block browser access (CORS), or the connection may be unavailable.",
      { cause },
    );
  }
  if (!response.ok) throw new Error(`The file could not be fetched (HTTP ${response.status}).`);
  const blob = await response.blob();
  if (blob.type.split(";", 1)[0] === "text/html") {
    throw new Error("This link returned a web page instead of media. Open the original URL.");
  }
  return blob;
}

export async function downloadMedia(src: string, name: string): Promise<void> {
  const url = URL.createObjectURL(await readMediaBlob(src));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function readMediaPng(src: string): Promise<Blob> {
  const blob = await readMediaBlob(src);
  if (blob.type.split(";", 1)[0] === "image/png") return blob;

  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    try {
      await image.decode();
    } catch (cause) {
      throw new Error(
        "The browser could not decode this image for copying. Try saving it instead.",
        {
          cause,
        },
      );
    }
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width <= 0 || height <= 0 || width * height > 64_000_000) {
      throw new Error(
        "This image is too large or has no usable dimensions. Try saving it instead.",
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image copying is unavailable in this browser.");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (png) =>
          png ? resolve(png) : reject(new Error("The image could not be converted to PNG.")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
