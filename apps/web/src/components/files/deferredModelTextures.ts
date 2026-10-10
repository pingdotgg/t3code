import { LoaderUtils, LoadingManager, Texture, TextureLoader } from "three";

/** Record texture sources in the worker; the viewer owns image decoding and blob URLs. */
export function deferredModelTextures(basePath: string, revision: string | null = null) {
  const imageUrls = new Map<string, string | Blob>();
  const pendingImages: Promise<void>[] = [];
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (revision && url.startsWith(basePath)) {
      const resource = new URL(url);
      resource.searchParams.set("workspace-revision", revision);
      return resource.href;
    }
    return url;
  });
  class DeferredTextureLoader extends TextureLoader {
    override load(
      url: string,
      onLoad?: (texture: Texture<HTMLImageElement>) => void,
      _onProgress?: (event: ProgressEvent) => void,
      onError?: (error: unknown) => void,
    ) {
      const texture = new Texture<HTMLImageElement>();
      const resolved = manager.resolveURL(LoaderUtils.resolveURL(url, this.path));
      if (resolved.startsWith("blob:")) {
        const pending = (async () => {
          try {
            const response = await fetch(resolved);
            if (!response.ok) throw new Error("Could not read an embedded model texture.");
            imageUrls.set(texture.source.uuid, await response.blob());
            onLoad?.(texture);
          } finally {
            URL.revokeObjectURL(resolved);
          }
        })();
        pendingImages.push(pending);
        if (onError) void pending.catch(onError);
      } else {
        imageUrls.set(texture.source.uuid, resolved);
        onLoad?.(texture);
      }
      return texture;
    }
  }
  const textureLoader = new DeferredTextureLoader(manager);
  manager.addHandler(/./, textureLoader);
  return { manager, textureLoader, imageUrls, pendingImages };
}
