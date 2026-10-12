// Top-level await in the entry itself: refused on every runtime.
const settings = await Promise.resolve({ greeting: "hi" });

export function activate(context) {
  context.log.info(settings.greeting);
}
