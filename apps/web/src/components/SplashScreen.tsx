import { AnimatedWorkbenchLogo } from "./Icons";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-32 items-center justify-center"
        aria-label="Workbench splash screen"
      >
        <AnimatedWorkbenchLogo aria-label="Workbench" className="size-24 text-foreground" />
      </div>
    </div>
  );
}
