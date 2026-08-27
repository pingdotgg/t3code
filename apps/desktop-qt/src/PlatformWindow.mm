#include "PlatformWindow.h"

#import <AppKit/AppKit.h>
#include <dlfcn.h>

#include <QWindow>

namespace {

// WindowServer blur behind a window: pure blur with no tint, so the theme's
// own alpha decides how much of it shows. The same call terminals use for
// their "background blur" option; not public API, hence the dlsym.
bool applyWindowServerBlur(NSWindow* native, int radius) {
  using ConnectionFn = int (*)();
  using BlurFn = int (*)(int, NSInteger, int);
  static const auto connection =
      reinterpret_cast<ConnectionFn>(dlsym(RTLD_DEFAULT, "CGSDefaultConnectionForThread"));
  static const auto setBlur =
      reinterpret_cast<BlurFn>(dlsym(RTLD_DEFAULT, "CGSSetWindowBackgroundBlurRadius"));
  if (connection == nullptr || setBlur == nullptr) {
    return false;
  }
  return setBlur(connection(), native.windowNumber, radius) == 0;
}

void applyEffectView(NSWindow* native, bool dark) {
  if ([native.contentView isKindOfClass:[NSVisualEffectView class]]) {
    return;
  }
  // Qt's view becomes a child of the effect view: the blur paints below it and
  // Qt keeps drawing on a clear surface on top.
  NSView* content = native.contentView;
  NSVisualEffectView* backdrop = [[NSVisualEffectView alloc] initWithFrame:content.frame];
  backdrop.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  backdrop.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  backdrop.material = dark ? NSVisualEffectMaterialHUDWindow : NSVisualEffectMaterialPopover;
  backdrop.state = NSVisualEffectStateActive;
  backdrop.appearance =
      [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
  native.contentView = backdrop;
  content.frame = backdrop.bounds;
  content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [backdrop addSubview:content];
}

}  // namespace

void applyWindowBlur(QWindow* window, bool enabled, bool dark) {
  if (window == nullptr || !enabled) {
    return;
  }
  auto* qtView = reinterpret_cast<NSView*>(window->winId());
  NSWindow* native = qtView.window;
  if (native == nil) {
    return;
  }
  native.opaque = NO;
  native.backgroundColor = NSColor.clearColor;
  if (!applyWindowServerBlur(native, 32)) {
    applyEffectView(native, dark);
  }
}
