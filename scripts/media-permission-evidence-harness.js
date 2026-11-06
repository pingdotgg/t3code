// Browser-only inspector fixture. Run in the paired dev app through native preview evaluation:
// import('/@fs/<checkout>/scripts/media-permission-evidence-harness.js')
//   .then(m => m.mountInspector('<absolute fixture media directory>'))
// This mounts the actual inspector, using the existing app registry and real session permissions.
export async function mountInspector(mediaRoot) {
  if (!mediaRoot || !mediaRoot.startsWith("/"))
    throw new Error("Pass the absolute generated fixture media directory");
  const [reactModule, domModule, { AppAtomRegistryProvider }, { V2ItemInspector }] =
    await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("/src/rpc/atomRegistry.ts"),
      import("/src/components/chat/V2ItemInspector.tsx"),
    ]);
  const { createElement: h, Suspense } = reactModule.default ?? reactModule;
  const { createRoot } = domModule.default ?? domModule;
  document.querySelector("#media-evidence-inspector")?.remove();
  const environmentId = location.pathname.split("/")[1];
  const threadId = "media-permission-a5";
  const T = "2026-10-22T12:00:00.000Z";
  const item = {
    id: threadId + "-reasoning",
    threadId,
    runId: threadId + "-run",
    nodeId: threadId + "-root",
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 2,
    status: "completed",
    title: "Synthetic media reasoning",
    startedAt: T,
    completedAt: T,
    updatedAt: T,
    type: "reasoning",
    streaming: false,
    text: `![Demo](${mediaRoot}/demo.mp4)`,
  };
  const container = document.createElement("div");
  container.id = "media-evidence-inspector";
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9999",
    overflow: "auto",
    background: "var(--background)",
    color: "var(--foreground)",
    padding: "24px",
  });
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    h(
      AppAtomRegistryProvider,
      null,
      h(
        Suspense,
        { fallback: "Loading actual inspector…" },
        h(
          "div",
          { style: { maxWidth: "736px", margin: "0 auto" } },
          h(
            "p",
            { style: { marginBottom: "24px" } },
            "HARNESS · A5 · Actual V2ItemInspector · real restricted session",
          ),
          h(V2ItemInspector, {
            projectedItem: {
              position: 2,
              visibility: "local",
              sourceThreadId: threadId,
              sourceItemId: item.id,
              item,
            },
            environmentId,
            cwd: mediaRoot,
            onOpenThread: () => {},
            onOpenTurnDiff: () => {},
          }),
        ),
      ),
    ),
  );
  window.removeMediaEvidenceInspector = () => {
    root.unmount();
    container.remove();
  };
}

// Controlled player boundary plus the actual asset component's GitHub fallback branch.
// The intentionally unsupported GitHub asset URL fails validation; fallback media is local.
export async function mountControls(mediaRoot) {
  if (!mediaRoot?.startsWith("/")) throw new Error("Pass the generated media directory");
  const [
    reactModule,
    domModule,
    { AppAtomRegistryProvider },
    { ChatMarkdownAssetImage },
    { MediaVideoPlayer },
  ] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("/src/rpc/atomRegistry.ts"),
    import("/src/components/chat/ChatMarkdownMedia.tsx"),
    import("/src/components/media/MediaVideoPlayer.tsx"),
  ]);
  const { createElement: h, Suspense, useState } = reactModule.default ?? reactModule;
  const { createRoot } = domModule.default ?? domModule;
  const environmentId = location.pathname.split("/")[1];
  const good = `${location.origin}/@fs${mediaRoot}/demo.mp4`;
  const broken = `${location.origin}/@fs${mediaRoot}/corrupt.mp4`;
  function Controls() {
    const [scenario, select] = useState("fallback-good");
    const [resolved, resolve] = useState(false);
    const [deferred, setDeferred] = useState(null);
    const control = (name, action) =>
      h(
        "button",
        {
          key: name,
          type: "button",
          onClick: action,
          style: { padding: "8px", border: "1px solid", borderRadius: "6px", margin: "4px" },
        },
        name,
      );
    const choose = (name) => {
      resolve(false);
      select(name);
    };
    let player;
    if (scenario.startsWith("fallback")) {
      player = h(ChatMarkdownAssetImage, {
        key: scenario,
        environmentId,
        kind: "video",
        alt: "Demo",
        resource: {
          _tag: "github-media",
          cwd: mediaRoot,
          url: "https://example.invalid/fixture.mp4",
        },
        fallbackSrc: scenario === "fallback-good" ? good : broken,
        originalUrl: scenario === "fallback-good" ? good : broken,
        srcFragment: "#t=0.1",
      });
    } else {
      player = h(MediaVideoPlayer, {
        key: scenario,
        label: "Demo",
        src: resolved ? good : null,
        sourceFailed: scenario === "retry",
        onRetry:
          scenario === "retry"
            ? () => new Promise((accept, reject) => setDeferred({ accept, reject }))
            : undefined,
        className: "w-full max-w-[min(100%,30rem)]",
      });
    }
    return h(
      "div",
      { style: { maxWidth: "736px", margin: "0 auto" } },
      h("p", null, "HARNESS · actual asset/player components · controlled boundary states"),
      h(
        "div",
        { style: { margin: "20px 0" } },
        ...["fallback-good", "fallback-broken", "retry", "loading"].map((name) =>
          control(name, () => choose(name)),
        ),
      ),
      h("p", { style: { marginBottom: "20px" } }, `Scenario: ${scenario}`),
      h(Suspense, { fallback: "Loading actual component…" }, player),
      h(
        "div",
        { style: { marginTop: "20px" } },
        control("Resolve", () => {
          resolve(true);
          deferred?.accept();
          setDeferred(null);
        }),
        control("Reject", () => {
          deferred?.reject(new Error("Synthetic refresh failure"));
          setDeferred(null);
        }),
      ),
      h(
        "p",
        { style: { marginTop: "20px" } },
        "Loading is controlled at player props. This does not simulate session-query pending/error.",
      ),
    );
  }
  const container = document.createElement("div");
  container.id = "media-evidence-controls";
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9999",
    overflow: "auto",
    background: "var(--background)",
    color: "var(--foreground)",
    padding: "24px",
  });
  document.body.append(container);
  const root = createRoot(container);
  root.render(h(AppAtomRegistryProvider, null, h(Controls)));
  window.removeMediaEvidenceControls = () => {
    root.unmount();
    container.remove();
  };
}
