// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
//
// Local Sharp mock for `cf.image` fetches (`fetch(url, { cf: { image } })`),
// ported from Miniflare's `cfImageLocalFetcher`
// (`workers-sdk/packages/miniflare/src/plugins/images/fetcher.ts`). Follows
// production `cf.image` semantics at low fidelity: resize, rotate and format
// conversion only.
import type * as NodeHttp from "node:http";
import type { RequestInitCfPropertiesImage } from "@cloudflare/workers-types/experimental";
import type { FitEnum, Sharp } from "sharp";
import { readNodeRequest } from "../bindings/images/Images.ts";
import type * as LoopbackServer from "./LoopbackServer.ts";

const NAMED_QUALITIES: Record<string, number> = {
  low: 35,
  "medium-low": 50,
  "medium-high": 70,
  high: 90,
};

const resolveQuality = (quality: RequestInitCfPropertiesImage["quality"]): number | undefined => {
  if (typeof quality === "number") {
    return Math.min(100, Math.max(1, Math.round(quality)));
  }
  if (typeof quality === "string" && quality in NAMED_QUALITIES) {
    return NAMED_QUALITIES[quality];
  }
  return undefined;
};

// `contain` shrinks to fit within the box preserving aspect ratio (no
// padding), the same as `scale-down` but allowed to enlarge.
const resolveFit = (
  fit: RequestInitCfPropertiesImage["fit"],
): { fit: keyof FitEnum; withoutEnlargement?: boolean } => {
  switch (fit) {
    case "contain":
      return { fit: "inside" };
    case "cover":
      return { fit: "cover" };
    case "crop":
      return { fit: "cover", withoutEnlargement: true };
    case "pad":
      return { fit: "contain" };
    case "squeeze":
      return { fit: "fill" };
    default:
      return { fit: "inside", withoutEnlargement: true };
  }
};

const resolveGravity = (gravity: RequestInitCfPropertiesImage["gravity"]): string | undefined => {
  switch (gravity) {
    case "left":
    case "right":
    case "top":
    case "bottom":
      return gravity;
    case "center":
      return "centre";
    default:
      return undefined;
  }
};

const formatToMime = (format: string | undefined): string | null => {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    // libvips reports AVIF under the `heif` container format.
    case "heif":
      return "image/avif";
    default:
      return null;
  }
};

const applyTransforms = (transformer: Sharp, options: RequestInitCfPropertiesImage) => {
  if (typeof options.rotate === "number") {
    transformer.rotate(options.rotate);
  }
  const dpr = typeof options.dpr === "number" && options.dpr > 0 ? options.dpr : 1;
  const width = typeof options.width === "number" ? Math.round(options.width * dpr) : undefined;
  const height = typeof options.height === "number" ? Math.round(options.height * dpr) : undefined;
  if (width !== undefined || height !== undefined) {
    const { fit, withoutEnlargement } = resolveFit(options.fit);
    transformer.resize(width ?? null, height ?? null, {
      fit,
      withoutEnlargement,
      position: resolveGravity(options.gravity),
      background: options.background ?? (options.fit === "pad" ? "#ffffff" : undefined),
    });
  }
};

// A 422 never reaches the user: the interceptor falls back to the origin image.
const cfImageError = (message: string): Response =>
  new Response(`cf.image local transform error: ${message}`, {
    status: 422,
    headers: { "content-type": "text/plain" },
  });

export async function cfImageLocalFetcher(request: Request): Promise<Response> {
  let sharp;
  try {
    const { default: importedSharp } = await import("sharp");
    sharp = importedSharp;
  } catch {
    return cfImageError(
      "The Sharp library is not available, check your version of Node is compatible",
    );
  }

  let body: unknown;
  let options: RequestInitCfPropertiesImage;
  try {
    const data = await request.formData();
    body = data.get("image");
    const optionsJson = data.get("options");
    options =
      typeof optionsJson === "string"
        ? (JSON.parse(optionsJson) as RequestInitCfPropertiesImage)
        : {};
  } catch {
    return cfImageError("Could not parse cf.image transform request");
  }
  if (!(body instanceof Blob)) {
    return cfImageError("Expected an image in the cf.image transform request");
  }

  const source = await body.arrayBuffer();
  try {
    const metadata = await sharp(source).metadata();
    if (metadata.format === "svg") {
      return cfImageError("SVG inputs are not transformed in local mode");
    }
    if (options.format === "json") {
      const jsonTransformer = sharp(source, { autoOrient: true });
      applyTransforms(jsonTransformer, options);
      const { info } = await jsonTransformer.toBuffer({ resolveWithObject: true });
      return Response.json({
        width: info.width,
        height: info.height,
        original: {
          file_size: metadata.size ?? source.byteLength,
          width: metadata.width,
          height: metadata.height,
          format: formatToMime(metadata.format) ?? "application/octet-stream",
        },
      });
    }
    // Production applies EXIF orientation before any transform.
    const transformer = sharp(source, { autoOrient: true });
    applyTransforms(transformer, options);
    const quality = resolveQuality(options.quality);
    let contentType: string;
    switch (options.format) {
      case "avif":
        transformer.avif(quality !== undefined ? { quality } : {});
        contentType = "image/avif";
        break;
      case "webp":
        transformer.webp(quality !== undefined ? { quality } : {});
        contentType = "image/webp";
        break;
      case "jpeg":
      case "baseline-jpeg":
        transformer.jpeg(quality !== undefined ? { quality } : {});
        contentType = "image/jpeg";
        break;
      case "png":
      case "png-force":
        transformer.png();
        contentType = "image/png";
        break;
      default:
        contentType = formatToMime(metadata.format) ?? "image/jpeg";
        break;
    }
    const output = await transformer.toBuffer();
    return new Response(new Uint8Array(output), {
      headers: { "content-type": contentType, "cf-resized": "internal=ok/m" },
    });
  } catch {
    return cfImageError("Sharp failed to transform the image");
  }
}

/** Node-side loopback route the outbound interceptor sends `cf.image` fetches to. */
export const cfImageHandler: LoopbackServer.RawHandler = async (
  req: NodeHttp.IncomingMessage,
  res: NodeHttp.ServerResponse,
) => {
  const response = await cfImageLocalFetcher(
    await readNodeRequest(req, new URL(req.url ?? "/", "http://localhost")),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
};
