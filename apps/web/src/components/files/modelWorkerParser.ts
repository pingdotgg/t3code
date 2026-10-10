import { Mesh, MeshPhongMaterial, Points, PointsMaterial } from "three";
import type { Object3D } from "three";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";
import { deferredModelTextures } from "./deferredModelTextures";
import { packModel } from "./modelTransfer";

/** Format loaders stay lazy and all geometry parsing stays outside the UI thread. */
export async function parseModelForTransfer(
  bytes: ArrayBuffer,
  format: ModelPreviewFormat,
  basePath: string,
  revision: string | null = null,
) {
  if (format === "fbx") {
    const { parseFbxForTransfer } = await import("./fbxWorkerParser");
    return parseFbxForTransfer(bytes, basePath, revision);
  }
  const { manager, textureLoader, imageUrls, pendingImages } = deferredModelTextures(
    basePath,
    revision,
  );
  const warnings: string[] = [];
  let model: Object3D;
  switch (format) {
    case "gltf": {
      const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
      const loader = new GLTFLoader(manager);
      loader.register((parser) => {
        // Embedded buffer-view images bypass LoadingManager's URL handlers.
        parser.textureLoader = textureLoader;
        return { name: "T3_deferred_textures" };
      });
      const gltf = await loader.parseAsync(bytes, basePath).catch((error: unknown) => {
        if (error instanceof Error) {
          const compression = error.message.includes("DRACOLoader")
            ? "Draco"
            : error.message.includes("setMeshoptDecoder")
              ? "Meshopt"
              : error.message.includes("setKTX2Loader")
                ? "KTX2 texture"
                : null;
          if (compression)
            throw new Error(
              `This model uses ${compression} compression, which is not supported in previews yet.`,
              { cause: error },
            );
        }
        throw error;
      });
      model = gltf.scene;
      model.animations = gltf.animations;
      break;
    }
    case "obj": {
      const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");
      const { MTLLoader } = await import("three/addons/loaders/MTLLoader.js");
      const text = new TextDecoder().decode(bytes);
      const libraries = [
        ...new Set([...text.matchAll(/^\s*mtllib\s+(.+)$/gm)].map((match) => match[1]!.trim())),
      ];
      const creators = await Promise.all(
        libraries.map(async (library) => {
          const url = manager.resolveURL(new URL(library, basePath).href);
          try {
            const response = await fetch(url);
            if (!response.ok)
              throw new Error(`Material library request failed (${response.status}).`);
            return new MTLLoader(manager).parse(await response.text(), new URL(".", url).href);
          } catch {
            warnings.push(`Material library missing: ${library}. Showing available materials.`);
            return null;
          }
        }),
      );
      const materials = new MTLLoader(manager).parse("", basePath);
      const fallback = materials.create.bind(materials);
      materials.create = (name) => {
        for (const creator of creators) {
          if (creator && Object.hasOwn(creator.materialsInfo, name)) return creator.create(name);
        }
        return fallback(name);
      };
      model = new OBJLoader(manager).setMaterials(materials).parse(text);
      break;
    }
    case "stl": {
      const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
      const geometry = new STLLoader().parse(bytes);
      const alpha = "alpha" in geometry && typeof geometry.alpha === "number" ? geometry.alpha : 1;
      model = new Mesh(
        geometry,
        new MeshPhongMaterial({
          color: geometry.hasAttribute("color") ? 0xffffff : 0xb8bbc4,
          vertexColors: geometry.hasAttribute("color"),
          opacity: alpha,
          transparent: alpha < 1,
        }),
      );
      break;
    }
    case "ply": {
      const { PLYLoader } = await import("three/addons/loaders/PLYLoader.js");
      const geometry = new PLYLoader().parse(bytes);
      const header = new TextDecoder().decode(new Uint8Array(bytes).subarray(0, 64 * 1024));
      const hasFaces =
        geometry.index !== null ||
        /^element face [1-9]\d*\s*$/m.test(header.split("end_header", 1)[0] ?? "");
      const vertexColors = geometry.hasAttribute("color");
      if (hasFaces) {
        if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
        model = new Mesh(
          geometry,
          new MeshPhongMaterial({ color: vertexColors ? 0xffffff : 0xb8bbc4, vertexColors }),
        );
      } else {
        model = new Points(
          geometry,
          new PointsMaterial({
            color: vertexColors ? 0xffffff : 0xb8bbc4,
            vertexColors,
            size: 2,
            sizeAttenuation: false,
          }),
        );
      }
      break;
    }
  }
  await Promise.all(pendingImages);
  const result = packModel(model, imageUrls);
  if (warnings.length) result.payload.warnings = warnings;
  return result;
}
