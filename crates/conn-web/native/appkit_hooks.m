// AppKit glue for running CEF inside a GPUI or AppKit host on macOS.
// Adapted from Threadbear's `desktop/web/native/appkit_hooks.m` (which adapts
// Ghostex's `GpuiCefAppKitHooks.m`, MIT licensed).
#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <stdbool.h>

// CEF's message pump traps unless NSApp conforms to CefAppProtocol.
// GPUI owns the NSApplication subclass, so we attach the protocol and
// `isHandlingSendEvent` state at runtime.
@protocol CrAppProtocol
- (BOOL)isHandlingSendEvent;
@end
@protocol CrAppControlProtocol <CrAppProtocol>
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent;
@end
@protocol CefAppProtocol <CrAppControlProtocol>
@end

static BOOL g_handlingSendEvent = NO;

@interface NSApplication (ConnCEF) <CefAppProtocol>
- (BOOL)isHandlingSendEvent;
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent;
- (void)connCefSendEvent:(NSEvent *)event;
@end

@implementation NSApplication (ConnCEF)
- (BOOL)isHandlingSendEvent {
  return g_handlingSendEvent;
}
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  g_handlingSendEvent = handlingSendEvent;
}
- (void)connCefSendEvent:(NSEvent *)event {
  BOOL was = g_handlingSendEvent;
  g_handlingSendEvent = YES;
  // Swizzled: calls the original -sendEvent:.
  [self connCefSendEvent:event];
  g_handlingSendEvent = was;
}
@end

void conn_cef_install_app_hooks(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class baseClass = [NSApplication class];
    Method original = class_getInstanceMethod(baseClass, @selector(sendEvent:));
    Method swapped = class_getInstanceMethod(baseClass, @selector(connCefSendEvent:));
    if (original && swapped) {
      method_exchangeImplementations(original, swapped);
    }
    class_addProtocol(baseClass, @protocol(CrAppProtocol));
    class_addProtocol(baseClass, @protocol(CrAppControlProtocol));
    class_addProtocol(baseClass, @protocol(CefAppProtocol));
  });
  if (NSApp) {
    Class appClass = object_getClass(NSApp);
    class_addProtocol(appClass, @protocol(CrAppProtocol));
    class_addProtocol(appClass, @protocol(CrAppControlProtocol));
    class_addProtocol(appClass, @protocol(CefAppProtocol));
  }
}

// Implemented in Rust (`mac/host.rs`): initializes CEF and runs Chromium's
// message loop on the main thread.
extern void conn_cef_run_message_loop(void);

static BOOL g_startPending = NO;
static BOOL g_loopRunning = NO;

static void conn_cef_schedule_start(CFTimeInterval delay) {
  CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(
      kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + delay, 0, 0, 0,
      ^(CFRunLoopTimerRef firedTimer) {
        (void)firedTimer;
        if (!g_startPending) {
          return;
        }
        if (NSApp.modalWindow != nil) {
          conn_cef_schedule_start(0.25);
          return;
        }
        g_startPending = NO;
        g_loopRunning = YES;
        conn_cef_run_message_loop();
        g_loopRunning = NO;
      });
  CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopDefaultMode);
  CFRelease(timer);
}

// Uses a CFRunLoopTimer (never dispatch_async on the main queue) so that
// entering `cef_run_message_loop()` does not starve GPUI's main-queue tasks.
void conn_cef_start_message_loop(void) {
  if (g_startPending || g_loopRunning) {
    return;
  }
  g_startPending = YES;
  conn_cef_schedule_start(0);
  CFRunLoopWakeUp(CFRunLoopGetMain());
}

// Pins Chromium's flipped autoresizing CALayers to their parent's exact bounds
// to prevent sub-pixel drift across resizes.
static void conn_pin_flipped_layers(CALayer *layer, int depth) {
  for (CALayer *sub in layer.sublayers) {
    CAAutoresizingMask sizable = kCALayerWidthSizable | kCALayerHeightSizable;
    if (sub.geometryFlipped && (sub.autoresizingMask & sizable) == sizable &&
        !CGRectEqualToRect(sub.frame, layer.bounds)) {
      sub.frame = layer.bounds;
    }
    if (depth < 6) {
      conn_pin_flipped_layers(sub, depth + 1);
    }
  }
}

static void conn_pin_page_layers(NSView *view) {
  if (!view.layer) {
    return;
  }
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  conn_pin_flipped_layers(view.layer, 0);
  [CATransaction commit];
}

void conn_view_set_frame(void *nativeView, double x, double y, double width, double height) {
  NSView *view = (__bridge NSView *)nativeView;
  if (!view) {
    return;
  }
  view.autoresizingMask = NSViewNotSizable;
  NSView *parent = view.superview;
  CGFloat nativeY = y;
  if (parent && !parent.isFlipped) {
    nativeY = NSHeight(parent.bounds) - y - height;
  }
  view.frame = NSMakeRect(x, nativeY, MAX(0.0, width), MAX(0.0, height));
  [view layoutSubtreeIfNeeded];
  [view.layer layoutIfNeeded];
  conn_pin_page_layers(view);
  __weak NSView *weakView = view;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSView *later = weakView;
    if (later) {
      conn_pin_page_layers(later);
    }
  });
}

void conn_view_set_hidden(void *nativeView, bool hidden) {
  NSView *view = (__bridge NSView *)nativeView;
  if (view) {
    view.hidden = hidden;
  }
}

void conn_view_remove(void *nativeView) {
  NSView *view = (__bridge NSView *)nativeView;
  if (view) {
    [view removeFromSuperview];
  }
}

const char *conn_main_bundle_identifier(void) {
  NSString *identifier = [[NSBundle mainBundle] bundleIdentifier];
  return identifier ? identifier.UTF8String : NULL;
}

// ---------------------------------------------------------------------------
// Minimal AppKit window helpers for standalone examples (e.g. `cef_smoke`).
// ---------------------------------------------------------------------------

static NSWindow *g_smokeWindow = nil;

void *conn_smoke_init_window(double width, double height, const char *title) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSRect rect = NSMakeRect(100.0, 100.0, MAX(1.0, width), MAX(1.0, height));
    NSWindowStyleMask style =
        NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:rect
                                                   styleMask:style
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
    if (title) {
      window.title = [NSString stringWithUTF8String:title];
    }
    [window orderFrontRegardless];
    g_smokeWindow = window;
    return (__bridge void *)window.contentView;
  }
}

void conn_smoke_schedule_timer(double intervalSeconds, void (*callback)(void *), void *ctx) {
  if (!callback || intervalSeconds <= 0.0) {
    return;
  }
  CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(
      kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + intervalSeconds, intervalSeconds, 0, 0,
      ^(CFRunLoopTimerRef firedTimer) {
        (void)firedTimer;
        callback(ctx);
      });
  CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
  CFRelease(timer);
}

void conn_smoke_run_app(void) {
  @autoreleasepool {
    [NSApp run];
  }
}

void conn_smoke_stop_app(void) {
  @autoreleasepool {
    if (g_smokeWindow) {
      [g_smokeWindow orderOut:nil];
      g_smokeWindow = nil;
    }
    [NSApp stop:nil];
    // Post a dummy event so -[NSApplication run] wakes up and exits immediately.
    NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                        location:NSZeroPoint
                                   modifierFlags:0
                                       timestamp:0
                                    windowNumber:0
                                         context:nil
                                         subtype:0
                                           data1:0
                                           data2:0];
    if (event) {
      [NSApp postEvent:event atStart:YES];
    }
  }
}
