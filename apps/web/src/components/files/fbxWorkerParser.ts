import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { packModel } from "./modelTransfer";
import { deferredModelTextures } from "./deferredModelTextures";

/** Worker-only texture adapter: record references; DOM image loading stays in the viewer. */
export async function parseFbxForTransfer(
  bytes: ArrayBuffer,
  basePath: string,
  revision: string | null = null,
) {
  const { manager, imageUrls, pendingImages } = deferredModelTextures(basePath, revision);
  const model = new FBXLoader(manager).parse(bytes, basePath);
  await Promise.all(pendingImages);
  return packModel(model, imageUrls);
}
