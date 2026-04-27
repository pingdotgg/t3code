import { FormaMark } from "./FormaMark";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="Forma splash screen">
        <FormaMark className="h-auto w-16 text-foreground" />
      </div>
    </div>
  );
}
