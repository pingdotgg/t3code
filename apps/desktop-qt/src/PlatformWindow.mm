#include "PlatformWindow.h"

#import <AppKit/AppKit.h>

#include <QWindow>

void applyWindowBlur(QWindow* window, bool enabled, bool dark) {
  if (window == nullptr || !enabled) {
    return;
  }
  auto* qtView = reinterpret_cast<NSView*>(window->winId());
  NSWindow* native = qtView.window;
  if (native == nil || [native.contentView isKindOfClass:[NSVisualEffectView class]]) {
    return;
  }
  // Qt's view becomes a child of the effect view: the blur paints below it and
  // Qt keeps drawing on a clear surface on top.
  NSView* content = native.contentView;
  NSVisualEffectView* backdrop = [[NSVisualEffectView alloc] initWithFrame:content.frame];
  backdrop.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  backdrop.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  backdrop.material = NSVisualEffectMaterialUnderWindowBackground;
  backdrop.state = NSVisualEffectStateActive;
  backdrop.appearance =
      [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
  native.contentView = backdrop;
  content.frame = backdrop.bounds;
  content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [backdrop addSubview:content];
  native.opaque = NO;
  native.backgroundColor = NSColor.clearColor;
}
