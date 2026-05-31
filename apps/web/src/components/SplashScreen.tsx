import { BASE_PATH } from "../basePath";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="T3 Code splash screen">
        <img
          alt="T3 Code"
          className="size-16 object-contain"
          src={`${BASE_PATH}/apple-touch-icon.png`}
        />
      </div>
    </div>
  );
}
