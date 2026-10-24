import { createRoot } from "react-dom/client";
import { ComposerBannerStack } from "../../apps/web/src/components/chat/ComposerBannerStack";
import { ComposerSurface } from "../../apps/web/src/components/chat/ComposerSurface";

// Simultaneous urgent notices are not produced by the goal/tasks fixture.
export function mount(variant: "warning" | "error") {
  const host = document.createElement("div");
  host.id = "composer-banner-shadow-harness";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647";
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    <div className="fixed inset-0 flex flex-col bg-background p-6 text-foreground">
      <p>Harness only: {variant} collapsed stack</p>
      <div className="mt-auto mb-12 w-full max-w-3xl self-center">
        <ComposerSurface.Shell>
          <ComposerBannerStack
            items={[
              { id: "first", priority: "urgent", variant, icon: "!", title: "First urgent notice" },
              {
                id: "second",
                priority: "urgent",
                variant,
                icon: "!",
                title: "Second urgent notice",
              },
            ]}
          />
          <ComposerSurface.Host>
            <div className="h-36 p-4">Composer surface control</div>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </div>,
  );
  return () => {
    root.unmount();
    host.remove();
  };
}
