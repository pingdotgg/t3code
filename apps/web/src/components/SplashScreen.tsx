export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label="PostHog Inbox splash screen"
      >
        <img alt="PostHog Inbox" className="size-16 object-contain" src="/favicon.svg" />
      </div>
    </div>
  );
}
