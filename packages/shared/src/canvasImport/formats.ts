export const CANVAS_IMPORT_ACCEPT = ".pen,.fig,.figma,.zip,.json,.svg,.png,.jpg,.jpeg,.webp,.gif";
export const IMAGE_EXTENSIONS = new Set(["svg", "png", "jpg", "jpeg", "webp", "gif"]);

export const extensionOf = (path: string) => {
  const leaf = path.split(/[\\/]/).pop() ?? path;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : "";
};

/** Lightweight metadata shared by the chooser and import worker. */
export function unsupportedCanvasFileMessage(fileName: string): string | null {
  const extension = extensionOf(fileName);
  if (["pen", "fig", "figma", "zip", "json"].includes(extension) || IMAGE_EXTENSIONS.has(extension))
    return null;
  if (extension === "paper")
    return "Paper's native project format is not supported. Export SVG or PNG from Paper for an image layer; editable HTML/CSS import is not available yet.";
  if (extension === "framer")
    return "Framer projects need a connected project API, which is not available here yet. Export PNG or JPG from Framer to import its appearance as an image layer.";
  if (["html", "htm", "jsx", "tsx"].includes(extension))
    return "HTML, CSS and React import is not available yet. Export SVG or PNG for an image layer; editable Paper and Framer integration requires a source connection.";
  return `.${extension || "unknown"} import is not supported. Use .pen, .fig, SVG, PNG, JPEG, WebP, GIF, or a ZIP containing supported files. Export Sketch, PDF, PSD, AI and other designs as SVG or PNG first.`;
}
