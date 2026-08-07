import { Brand2codeMark } from "./Brand2codeMark";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="2code splash screen">
        <Brand2codeMark className="size-16 drop-shadow-[0_0_24px_rgba(176,254,147,0.2)]" />
      </div>
    </div>
  );
}
