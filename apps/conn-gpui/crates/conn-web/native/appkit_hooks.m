// AppKit glue for running CEF inside a GPUI or AppKit host on macOS.
// Adapted from Threadbear's `desktop/web/native/appkit_hooks.m` (which adapts
// Ghostex's `GpuiCefAppKitHooks.m`, MIT licensed).
#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>
#import <objc/runtime.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

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

const char *conn_main_bundle_identifier(void) {
  NSString *identifier = [[NSBundle mainBundle] bundleIdentifier];
  return identifier ? identifier.UTF8String : NULL;
}

// ---------------------------------------------------------------------------
// Context-menu actions: the general pasteboard and the default URL handler.
// ---------------------------------------------------------------------------

bool conn_web_pasteboard_set_string(const char *utf8) {
  if (!utf8) {
    return false;
  }
  @autoreleasepool {
    NSString *text = [NSString stringWithUTF8String:utf8];
    if (!text) {
      return false;
    }
    NSPasteboard *board = [NSPasteboard generalPasteboard];
    [board clearContents];
    return [board setString:text forType:NSPasteboardTypeString];
  }
}

bool conn_web_pasteboard_set_png(const uint8_t *bytes, size_t length) {
  if (!bytes || length == 0) {
    return false;
  }
  @autoreleasepool {
    NSData *data = [NSData dataWithBytes:bytes length:length];
    NSPasteboard *board = [NSPasteboard generalPasteboard];
    [board clearContents];
    return [board setData:data forType:NSPasteboardTypePNG];
  }
}

bool conn_web_open_url(const char *utf8) {
  if (!utf8) {
    return false;
  }
  @autoreleasepool {
    NSString *text = [NSString stringWithUTF8String:utf8];
    NSURL *url = text ? [NSURL URLWithString:text] : nil;
    return url ? [[NSWorkspace sharedWorkspace] openURL:url] : false;
  }
}

// ---------------------------------------------------------------------------
// Minimal AppKit run-loop helpers for standalone examples (e.g. `cef_smoke`).
// ---------------------------------------------------------------------------

void conn_smoke_init_app(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
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
