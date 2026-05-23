export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex size-24 items-center justify-center" aria-label="Salchi splash screen">
        <img
          alt="Salchi"
          className="size-16 object-contain [image-rendering:pixelated]"
          src="/salchi-logo.png"
        />
      </div>
    </div>
  );
}
