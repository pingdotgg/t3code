import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  FloatType,
  ImageLoader,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  ObjectLoader,
  SkinnedMesh,
  Sphere,
  TextureSource,
  Vector3,
} from "three";
import type { JSONMeta, LoadingManager, Object3D, Texture, TypedArray, Vector3Tuple } from "three";

interface ModelAttribute {
  array: TypedArray;
  itemSize: number;
  normalized: boolean;
  name: string;
  usage: BufferAttribute["usage"];
  gpuType: BufferAttribute["gpuType"];
  interleaved?: { uuid: string; stride: number; offset: number };
}

interface ModelBounds {
  min: Vector3Tuple;
  max: Vector3Tuple;
  center: Vector3Tuple;
  radius: number;
}

interface ModelGeometry {
  uuid: string;
  name: string;
  attributes: Record<string, ModelAttribute>;
  index: ModelAttribute | null;
  morphAttributes: Partial<Record<keyof BufferGeometry["morphAttributes"], ModelAttribute[]>>;
  morphTargetsRelative: boolean;
  groups: BufferGeometry["groups"];
  drawRange: BufferGeometry["drawRange"];
  userData: BufferGeometry["userData"];
  bounds: ModelBounds;
}

export interface TransferredModel {
  json: ReturnType<Object3D["toJSON"]> & {
    materials: JSONMeta["materials"][string][];
    textures: JSONMeta["textures"][string][];
    skeletons: JSONMeta["skeletons"][string][];
    animations: JSONMeta["animations"][string][];
  };
  geometries: ModelGeometry[];
  images: { uuid: string; url: string | Blob | null }[];
  skinnedBounds: Record<string, ModelBounds>;
  warnings?: string[];
}

function packBounds(box: Box3, sphere: Sphere): ModelBounds {
  return {
    min: box.min.toArray(),
    max: box.max.toArray(),
    center: sphere.center.toArray(),
    radius: sphere.radius,
  };
}

/** Keep large vertex arrays out of Three's JSON serializer and transfer their buffers. */
export function packModel(model: Object3D, imageUrls: ReadonlyMap<string, string | Blob>) {
  const meta: JSONMeta = {
    geometries: {},
    materials: {},
    textures: {},
    images: {},
    shapes: {},
    skeletons: {},
    animations: {},
    nodes: {},
  };
  const geometries: ModelGeometry[] = [];
  const buffers = new Set<ArrayBuffer>();
  const skinnedBounds: Record<string, ModelBounds> = {};
  const packAttribute = (
    attribute: BufferAttribute | InterleavedBufferAttribute,
  ): ModelAttribute => {
    const interleaved = attribute instanceof InterleavedBufferAttribute ? attribute : null;
    const data = attribute instanceof BufferAttribute ? attribute : attribute.data;
    if (data.array.buffer instanceof ArrayBuffer) buffers.add(data.array.buffer);
    return {
      array: attribute.array,
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
      name: attribute.name,
      usage: data.usage,
      gpuType: attribute instanceof BufferAttribute ? attribute.gpuType : FloatType,
      ...(interleaved
        ? {
            interleaved: {
              uuid: interleaved.data.uuid,
              stride: interleaved.data.stride,
              offset: interleaved.offset,
            },
          }
        : {}),
    };
  };
  model.updateMatrixWorld(true);
  model.traverse((child) => {
    if ("geometry" in child && child.geometry instanceof BufferGeometry) {
      const geometry = child.geometry;
      if (!meta.geometries[geometry.uuid]) {
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        const attributes: Record<string, ModelAttribute> = {};
        for (const [name, attribute] of Object.entries(geometry.attributes)) {
          if (
            !(attribute instanceof BufferAttribute) &&
            !(attribute instanceof InterleavedBufferAttribute)
          )
            throw new Error("Unsupported model vertex attribute.");
          attributes[name] = packAttribute(attribute);
        }
        const morphAttributes: ModelGeometry["morphAttributes"] = {};
        for (const [name, attributes] of Object.entries(geometry.morphAttributes)) {
          if (attributes)
            morphAttributes[name as keyof BufferGeometry["morphAttributes"]] =
              attributes.map(packAttribute);
        }
        geometries.push({
          uuid: geometry.uuid,
          name: geometry.name,
          attributes,
          index: geometry.index ? packAttribute(geometry.index) : null,
          morphAttributes,
          morphTargetsRelative: geometry.morphTargetsRelative,
          groups: geometry.groups,
          drawRange: geometry.drawRange,
          userData: geometry.userData,
          bounds: packBounds(geometry.boundingBox!, geometry.boundingSphere!),
        });
        // Object3D.toJSON reuses this entry rather than expanding vertex arrays into JSON.
        meta.geometries[geometry.uuid] = { uuid: geometry.uuid, type: "BufferGeometry" };
      }
    }
    if (child instanceof SkinnedMesh) {
      child.computeBoundingBox();
      child.computeBoundingSphere();
      skinnedBounds[child.uuid] = packBounds(child.boundingBox!, child.boundingSphere!);
    }
  });
  const json = model.toJSON(meta);
  const payload: TransferredModel = {
    json: {
      ...json,
      materials: Object.values(meta.materials),
      textures: Object.values(meta.textures),
      skeletons: Object.values(meta.skeletons),
      animations: Object.values(meta.animations),
    },
    geometries,
    images: Object.keys(meta.images).map((uuid) => ({ uuid, url: imageUrls.get(uuid) ?? null })),
    skinnedBounds,
  };
  return { payload, transfer: [...buffers] };
}

function unpackBounds(bounds: ModelBounds) {
  return {
    box: new Box3(new Vector3().fromArray(bounds.min), new Vector3().fromArray(bounds.max)),
    sphere: new Sphere(new Vector3().fromArray(bounds.center), bounds.radius),
  };
}

/** Rebuild Three objects without copying transferred geometry or redoing per-vertex bounds. */
export function restoreModel(payload: TransferredModel) {
  const geometries: Record<string, BufferGeometry> = {};
  const interleavedBuffers = new Map<string, InterleavedBuffer>();
  const unpackAttribute = (attribute: ModelAttribute) => {
    if (attribute.interleaved) {
      const { uuid, stride, offset } = attribute.interleaved;
      let data = interleavedBuffers.get(uuid);
      if (!data) {
        data = new InterleavedBuffer(attribute.array, stride);
        data.setUsage(attribute.usage);
        interleavedBuffers.set(uuid, data);
      }
      const restored = new InterleavedBufferAttribute(
        data,
        attribute.itemSize,
        offset,
        attribute.normalized,
      );
      restored.name = attribute.name;
      return restored;
    }
    const restored = new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized);
    restored.name = attribute.name;
    restored.setUsage(attribute.usage);
    restored.gpuType = attribute.gpuType;
    return restored;
  };
  for (const packed of payload.geometries) {
    const geometry = new BufferGeometry();
    geometry.uuid = packed.uuid;
    geometry.name = packed.name;
    for (const [name, attribute] of Object.entries(packed.attributes)) {
      geometry.setAttribute(name, unpackAttribute(attribute));
    }
    if (packed.index) {
      const index = unpackAttribute(packed.index);
      if (!(index instanceof BufferAttribute))
        throw new Error("Unsupported model index attribute.");
      geometry.setIndex(index);
    }
    for (const [name, attributes] of Object.entries(packed.morphAttributes)) {
      geometry.morphAttributes[name as keyof BufferGeometry["morphAttributes"]] =
        attributes.map(unpackAttribute);
    }
    geometry.morphTargetsRelative = packed.morphTargetsRelative;
    geometry.groups = packed.groups;
    geometry.drawRange = packed.drawRange;
    geometry.userData = packed.userData;
    const { box, sphere } = unpackBounds(packed.bounds);
    geometry.boundingBox = box;
    geometry.boundingSphere = sphere;
    geometries[packed.uuid] = geometry;
  }
  const images = Object.fromEntries(
    payload.images.map(({ uuid }) => [uuid, new TextureSource<unknown>(null)]),
  );
  class ModelLoader extends ObjectLoader {
    textures: Record<string, Texture> = {};
    override parseGeometries() {
      return geometries;
    }
    override parseImages() {
      return images;
    }
    override parseTextures(json: unknown, sources: Record<string, TextureSource<unknown>>) {
      this.textures = super.parseTextures(json, sources);
      return this.textures;
    }
  }
  const loader = new ModelLoader();
  const model = loader.parse(payload.json);
  model.traverse((child) => {
    if (child instanceof SkinnedMesh && payload.skinnedBounds[child.uuid]) {
      const { box, sphere } = unpackBounds(payload.skinnedBounds[child.uuid]!);
      child.boundingBox = box;
      child.boundingSphere = sphere;
    }
  });
  return {
    model,
    loadTextures(manager: LoadingManager, signal: AbortSignal) {
      const imageLoader = new ImageLoader(manager);
      for (const image of payload.images) {
        if (!image.url || signal.aborted) continue;
        const url = typeof image.url === "string" ? image.url : URL.createObjectURL(image.url);
        imageLoader.load(url, (loaded) => {
          if (signal.aborted) return;
          const source = images[image.uuid]!;
          source.data = loaded;
          for (const texture of Object.values(loader.textures)) {
            if (texture.source === source) texture.needsUpdate = true;
          }
        });
      }
    },
  };
}
