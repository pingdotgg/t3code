import { createContext, useContext } from "react";
import type { FilePreviewItem, FilePreviewSource } from "./FilePreviewModal.types";
import { filePreviewGallery } from "../lib/filePreviewGallery";

export const FilePreviewGallery = createContext<readonly FilePreviewItem[]>([]);

export function useFilePreviewGallery() {
  const group = useContext(FilePreviewGallery);
  return (source: FilePreviewSource): FilePreviewSource =>
    group.length === 0
      ? source
      : {
          ...source,
          gallery: filePreviewGallery(source, group),
        };
}
