import {
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  LoadingManager,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Object3D } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { modelPreviewFormat } from "@t3tools/shared/filePreview";

import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { fitModelCamera } from "./modelCamera";
import { clearMissingModelTextures, disposeModel } from "./modelResources";
import { parseModelInWorker } from "./loadModel";
import { restoreModel } from "./modelTransfer";

interface ModelPreviewProps {
  readonly src: string;
  readonly name: string;
  readonly refresh?: () => Promise<void>;
}

export function ModelPreview(props: ModelPreviewProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ModelViewport
      key={`${props.src}:${attempt}`}
      {...props}
      onRetry={() => {
        if (props.refresh) void props.refresh().catch(() => undefined);
        else setAttempt((value) => value + 1);
      }}
    />
  );
}

function ModelViewport({ src, name, onRetry }: ModelPreviewProps & { onRetry: () => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [missingTextures, setMissingTextures] = useState<ReadonlyArray<string>>([]);
  const [warnings, setWarnings] = useState<ReadonlyArray<string>>([]);
  const resetViewRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let disposed = false;
    let model: Object3D | null = null;
    const controller = new AbortController();
    const scene = new Scene();
    scene.background = new Color("#18181b");
    scene.add(new HemisphereLight(0xffffff, 0x6d7180, 2));
    const keyLight = new DirectionalLight(0xffffff, 3);
    keyLight.position.set(4, 8, 6);
    scene.add(keyLight);

    const camera = new PerspectiveCamera(45, 1, 0.01, 100_000);
    let renderer: WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let renderFrame: number | null = null;
    const render = () => {
      if (disposed || !renderer || renderFrame !== null) return;
      renderFrame = requestAnimationFrame(() => {
        renderFrame = null;
        if (!disposed) renderer?.render(scene, camera);
      });
    };
    const manager = new LoadingManager();
    const embeddedUrls = new Set<string>();
    const revokeEmbeddedUrls = () => {
      for (const url of embeddedUrls) URL.revokeObjectURL(url);
      embeddedUrls.clear();
    };
    const revision = new URL(src).searchParams.get("workspace-revision");
    manager.setURLModifier((url) => {
      if (url.startsWith("blob:")) embeddedUrls.add(url);
      else if (revision && url.startsWith(new URL(".", src).href)) {
        const textureUrl = new URL(url);
        textureUrl.searchParams.set("workspace-revision", revision);
        return textureUrl.href;
      }
      return url;
    });
    manager.onLoad = () => {
      revokeEmbeddedUrls();
      if (!disposed && model) {
        clearMissingModelTextures(model);
        render();
      }
    };
    const failedTextures = new Set<string>();
    manager.onError = (url) => {
      if (disposed) return;
      let fileName = "texture";
      try {
        fileName = decodeURIComponent(new URL(url, src).pathname.split("/").at(-1) ?? "texture");
      } catch {
        // A malformed texture filename must not prevent the model from loading.
      }
      failedTextures.add(fileName);
      setMissingTextures([...failedTextures]);
      console.warn("Model texture could not be loaded", fileName);
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      if (!disposed) setLoadError("3D rendering was interrupted. Retry to reload the model.");
    };
    const release = () => {
      if (renderFrame !== null) cancelAnimationFrame(renderFrame);
      renderFrame = null;
      resizeObserver?.disconnect();
      controls?.removeEventListener("change", render);
      controls?.removeEventListener("start", onViewInteraction);
      controls?.dispose();
      resetViewRef.current = null;
      renderer?.domElement.removeEventListener("webglcontextlost", onContextLost);
      if (model) disposeModel(model);
      scene.clear();
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
      renderer = null;
      controls = null;
      model = null;
      revokeEmbeddedUrls();
    };
    let viewChanged = false;
    const onViewInteraction = () => {
      viewChanged = true;
    };

    void (async () => {
      try {
        const response = await fetch(src, { signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load this model (${response.status}).`);
        const bytes = await response.arrayBuffer();
        if (disposed) return;
        const basePath = new URL(".", src).href;
        const format = modelPreviewFormat(name);
        if (!format) throw new Error("This model format is not supported.");
        const transferred = await parseModelInWorker(
          bytes,
          format,
          basePath,
          controller.signal,
          revision,
        );
        if (disposed) return;
        setWarnings(transferred.warnings ?? []);
        const { model: loaded, loadTextures } = restoreModel(transferred);

        model = loaded;
        const bounds = new Box3().setFromObject(loaded);
        if (bounds.isEmpty() || ![...bounds.min, ...bounds.max].every(Number.isFinite)) {
          throw new Error("This file does not contain a valid visible model.");
        }
        const center = bounds.getCenter(new Vector3());
        const centeredModel = new Group();
        centeredModel.add(loaded);
        centeredModel.position.sub(center);
        scene.add(centeredModel);
        const centeredBounds = new Box3().setFromObject(centeredModel);
        const radius = Math.max(centeredBounds.getSize(new Vector3()).length() / 2, 0.001);

        renderer = new WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.domElement.className = "block h-full w-full";
        renderer.domElement.addEventListener("webglcontextlost", onContextLost);
        viewport.appendChild(renderer.domElement);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.addEventListener("change", render);
        controls.addEventListener("start", onViewInteraction);
        const fitView = () => {
          const { width, height } = viewport.getBoundingClientRect();
          fitModelCamera(camera, centeredBounds, width, height);
          if (controls) {
            controls.minDistance = radius * 0.05;
            controls.maxDistance = camera.far - radius * 2;
          }
          controls?.target.set(0, 0, 0);
          controls?.update();
          render();
        };
        resetViewRef.current = () => {
          viewChanged = false;
          fitView();
        };
        const resize = () => {
          const { width, height } = viewport.getBoundingClientRect();
          if (width <= 0 || height <= 0 || !renderer) return;
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          renderer.setSize(width, height, false);
          if (!viewChanged) fitView();
          render();
        };
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(viewport);
        resize();
        loadTextures(manager, controller.signal);
        setLoadError(null);
        setIsLoading(false);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        console.error("Model loading failed", error);
        release();
        setLoadError(error instanceof Error ? error.message : "Could not open this model.");
        setIsLoading(false);
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
      release();
    };
  }, [src, name]);

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-background"
      aria-label={`3D preview of ${name}`}
    >
      <div ref={viewportRef} className="absolute inset-0" />
      {loadError ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-destructive"
        >
          <p>{loadError}</p>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-foreground hover:bg-muted"
            onClick={onRetry}
          >
            Retry model preview
          </button>
        </div>
      ) : isLoading ? (
        <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-2 rounded-md bg-background/80 px-2.5 py-1.5 text-2xs text-muted-foreground">
          <Spinner size="xs" />
          Loading modelâ€¦
        </div>
      ) : null}
      {missingTextures.length > 0 && !loadError ? (
        <Tooltip>
          <TooltipTrigger
            render={<button type="button" />}
            className="absolute left-3 top-3 max-w-[75%] rounded-md bg-background/90 px-2.5 py-1.5 text-left text-2xs text-muted-foreground"
          >
            {missingTextures.length}{" "}
            {missingTextures.length === 1 ? "texture missing" : "textures missing"} Â· Showing
            available materials
          </TooltipTrigger>
          <TooltipPopup>{missingTextures.join(", ")}</TooltipPopup>
        </Tooltip>
      ) : null}
      {warnings.length > 0 && !loadError ? (
        <div
          role="status"
          className="absolute bottom-12 left-3 max-w-[75%] rounded-md bg-background/90 px-2.5 py-1.5 text-2xs text-muted-foreground"
        >
          {warnings.join(" ")}
        </div>
      ) : null}
      {!isLoading && !loadError ? (
        <button
          type="button"
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-md bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label="Reset 3D view"
          onClick={() => resetViewRef.current?.()}
        >
          <RotateCcw className="size-4" />
        </button>
      ) : null}
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-background/80 px-2.5 py-1.5 text-2xs text-muted-foreground">
        Drag to orbit Â· scroll to zoom
      </div>
    </div>
  );
}
