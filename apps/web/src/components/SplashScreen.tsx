export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex h-24 items-center justify-center px-4" aria-label="Atlas Vector splash screen">
        <img
          alt="Atlas Vector"
          className="h-22 w-auto object-contain dark:brightness-0 dark:invert"
          src="/atlas-logo.png"
        />
      </div>
    </div>
  );
}
