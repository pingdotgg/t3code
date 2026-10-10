import {
  AnimationClip,
  Bone,
  BoxGeometry,
  BufferAttribute,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  LoadingManager,
  Mesh,
  MeshPhongMaterial,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  RepeatWrapping,
  Skeleton,
  SkinnedMesh,
  Texture,
} from "three";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { packModel, restoreModel } from "./modelTransfer";
import { clearMissingModelTextures, disposeModel } from "./modelResources";

const images = vi.hoisted(
  () =>
    [] as Array<{
      url: string;
      success: (image: HTMLImageElement) => void;
      fail: () => void;
    }>,
);
vi.mock("three", async (importOriginal) => {
  const original = await importOriginal<typeof import("three")>();
  return {
    ...original,
    ImageLoader: class {
      constructor(readonly manager: import("three").LoadingManager) {}
      load(url: string, onLoad: (image: HTMLImageElement) => void) {
        const resolved = this.manager.resolveURL(url);
        this.manager.itemStart(resolved);
        images.push({
          url: resolved,
          success: (image) => {
            onLoad(image);
            this.manager.itemEnd(resolved);
          },
          fail: () => {
            this.manager.itemError(resolved);
            this.manager.itemEnd(resolved);
          },
        });
      }
    },
  };
});
afterEach(() => {
  images.length = 0;
  vi.restoreAllMocks();
});

describe("model transfer", () => {
  it("transfers interleaved glTF attributes without copying or losing stride and offsets", () => {
    const geometry = new BoxGeometry();
    const data = new InterleavedBuffer(
      new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
      6,
    );
    geometry.setIndex(null);
    geometry.deleteAttribute("uv");
    geometry.clearGroups();
    geometry.setAttribute("position", new InterleavedBufferAttribute(data, 3, 0));
    geometry.setAttribute("normal", new InterleavedBufferAttribute(data, 3, 3));
    const { payload, transfer } = packModel(
      new Mesh(geometry, new MeshStandardMaterial({ metalness: 0.2, roughness: 0.7 })),
      new Map(),
    );
    expect(transfer).toHaveLength(1);
    const received = structuredClone(payload, { transfer });
    const { model } = restoreModel(received);
    const mesh = model as Mesh;
    const position = mesh.geometry.getAttribute("position") as InterleavedBufferAttribute;
    const normal = mesh.geometry.getAttribute("normal") as InterleavedBufferAttribute;
    expect(position.data).toBe(normal.data);
    expect(position.data.array.buffer).toBe(
      received.geometries[0]!.attributes.position!.array.buffer,
    );
    expect(position.data.stride).toBe(6);
    expect(position.getX(1)).toBe(1);
    expect(normal.getZ(2)).toBe(1);
    expect((mesh.material as MeshStandardMaterial).roughness).toBe(0.7);
    disposeModel(model);
  });
  it("shares geometry without copying and preserves attributes, morphs, transforms and materials", () => {
    const geometry = new BoxGeometry();
    geometry.setAttribute("color", new BufferAttribute(new Uint8Array(24 * 3).fill(128), 3, true));
    geometry.morphAttributes.position = [
      new BufferAttribute(new Float32Array(24 * 3).fill(0.1), 3),
    ];
    geometry.morphTargetsRelative = true;
    geometry.setDrawRange(3, 12);
    const material = new MeshPhongMaterial({ color: 0x669933, opacity: 0.5, transparent: true });
    const group = new Group();
    const first = new Mesh(geometry, [material, material]);
    first.position.set(10, -2, 3);
    first.morphTargetInfluences![0] = 0.7;
    group.add(first, new Mesh(geometry, material));
    const { payload, transfer } = packModel(group, new Map());
    expect(payload.geometries).toHaveLength(1);
    expect(new Set(transfer).size).toBe(transfer.length);
    const received = structuredClone(payload, { transfer });
    expect(geometry.attributes.position!.array.byteLength).toBe(0);
    const restored = restoreModel(received).model;
    const restoredFirst = restored.children[0] as Mesh<BoxGeometry, MeshPhongMaterial[]>;
    const restoredSecond = restored.children[1] as Mesh;
    expect(restoredFirst.geometry).toBe(restoredSecond.geometry);
    expect(restoredFirst.geometry.attributes.position!.array.buffer).toBe(
      received.geometries[0]!.attributes.position!.array.buffer,
    );
    expect(restoredFirst.position.toArray()).toEqual([10, -2, 3]);
    expect(restoredFirst.geometry.attributes.color!.normalized).toBe(true);
    expect(restoredFirst.geometry.morphAttributes.position![0]!.array[0]).toBeCloseTo(0.1);
    expect(restoredFirst.morphTargetInfluences).toEqual([0.7]);
    expect(restoredFirst.geometry.drawRange).toEqual({ start: 3, count: 12 });
    expect(restoredFirst.material[0]).toBe(restoredFirst.material[1]);
    expect(restoredFirst.material[0]!.color.getHex()).toBe(0x669933);
    expect(restoredFirst.material[0]!.opacity).toBe(0.5);
    expect(restoredFirst.geometry.boundingSphere!.radius).toBeGreaterThan(0);
    disposeModel(restored);
  });

  it("restores bone binding, skin weights, animations and precomputed skinned bounds", () => {
    const geometry = new BoxGeometry();
    geometry.setAttribute("skinIndex", new BufferAttribute(new Uint16Array(24 * 4), 4));
    const weights = new Float32Array(24 * 4);
    for (let i = 0; i < 24; i++) weights[i * 4] = 1;
    geometry.setAttribute("skinWeight", new BufferAttribute(weights, 4));
    const mesh = new SkinnedMesh(geometry, new MeshPhongMaterial());
    const bone = new Bone();
    bone.name = "rootBone";
    mesh.add(bone);
    mesh.bind(new Skeleton([bone]));
    mesh.animations = [
      new AnimationClip("motion", 1, [
        new NumberKeyframeTrack("rootBone.position[x]", [0, 1], [0, 2]),
      ]),
    ];
    bone.position.x = 2;
    const { payload } = packModel(mesh, new Map());
    const restored = restoreModel(structuredClone(payload)).model as SkinnedMesh;
    expect(restored.skeleton.bones[0]).toBe(restored.children[0]);
    expect(restored.bindMatrix.toArray()).toEqual(mesh.bindMatrix.toArray());
    expect(restored.geometry.attributes.skinWeight!.array).toEqual(weights);
    expect(restored.animations[0]!.tracks[0]!.values).toEqual(new Float32Array([0, 2]));
    expect(restored.boundingBox).toEqual(mesh.boundingBox);
    expect(restored.boundingSphere).toEqual(mesh.boundingSphere);
    disposeModel(mesh);
    disposeModel(restored);
  });

  it("loads textures on the viewer thread with shared sources, transforms and revision URLs", () => {
    const texture = new Texture();
    texture.wrapS = RepeatWrapping;
    texture.repeat.set(2, 3);
    texture.offset.set(0.1, 0.2);
    const material = new MeshPhongMaterial({ map: texture, normalMap: texture });
    const { payload } = packModel(
      new Mesh(new BoxGeometry(), material),
      new Map([[texture.source.uuid, "https://host.test/leaves.png"]]),
    );
    const { model, loadTextures } = restoreModel(payload);
    const restored = (model as Mesh<BoxGeometry, MeshPhongMaterial>).material;
    expect(images).toHaveLength(0);
    expect(restored.map).toBe(restored.normalMap);
    expect(restored.map!.repeat.toArray()).toEqual([2, 3]);
    expect(restored.map!.wrapS).toBe(RepeatWrapping);
    const manager = new LoadingManager();
    manager.setURLModifier((url) => `${url}?workspace-revision=123`);
    loadTextures(manager, new AbortController().signal);
    expect(images[0]!.url).toContain("workspace-revision=123");
    images[0]!.success({ width: 2, height: 2 } as HTMLImageElement);
    expect(restored.map!.image).toEqual({ width: 2, height: 2 });
    expect(restored.map!.version).toBeGreaterThan(0);
    disposeModel(model);
  });

  it("retains the missing-texture fallback and ignores late images after cancellation", () => {
    const texture = new Texture();
    const { payload } = packModel(
      new Mesh(new BoxGeometry(), new MeshPhongMaterial({ map: texture })),
      new Map([[texture.source.uuid, "https://host.test/missing.png"]]),
    );
    const { model, loadTextures } = restoreModel(payload);
    const material = (model as Mesh<BoxGeometry, MeshPhongMaterial>).material;
    const controller = new AbortController();
    const manager = new LoadingManager();
    manager.onLoad = () => clearMissingModelTextures(model);
    const failed = vi.fn();
    manager.onError = failed;
    loadTextures(manager, controller.signal);
    images[0]!.fail();
    expect(failed).toHaveBeenCalledWith("https://host.test/missing.png");
    expect(material.map).toBeNull();
    const next = restoreModel(payload);
    next.loadTextures(new LoadingManager(), controller.signal);
    controller.abort();
    images[1]!.success({ width: 2, height: 2 } as HTMLImageElement);
    expect((next.model as Mesh<BoxGeometry, MeshPhongMaterial>).material.map!.image).toBeNull();
    disposeModel(model);
    disposeModel(next.model);
  });

  it("creates embedded image URLs in the viewer so worker termination cannot invalidate them", () => {
    const texture = new Texture();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const { payload } = packModel(
      new Mesh(new BoxGeometry(), new MeshPhongMaterial({ map: texture })),
      new Map([[texture.source.uuid, blob]]),
    );
    const received = structuredClone(payload);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:viewer-image");
    const { model, loadTextures } = restoreModel(received);
    loadTextures(new LoadingManager(), new AbortController().signal);
    expect(create).toHaveBeenCalledWith(received.images[0]!.url);
    expect(images[0]!.url).toBe("blob:viewer-image");
    disposeModel(model);
  });
});
