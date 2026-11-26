// Fork: moves a backdrop upload in and out of a theme file. Uploads live in this device's
// IndexedDB, so a theme only carries its image when the user exports it "with image".
import type { KaluwaStudioImage } from "../../kaluwa/kaluwaStudio";
import type { BackdropUpload } from "../kaluwaBackdrop/backdropUploads";

export function uploadToStudioImage(upload: BackdropUpload): Promise<KaluwaStudioImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve({ name: upload.name, dataUrl: reader.result })
        : reject(new Error("The image could not be read."));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(upload.blob);
  });
}

export function studioImageToFile(image: KaluwaStudioImage): File {
  const [header, data = ""] = image.dataUrl.split(",", 2);
  const type = /^data:([^;]+);/.exec(header ?? "")?.[1] ?? "image/png";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], image.name || "Image", { type });
}
