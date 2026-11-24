#import <AppKit/AppKit.h>

typedef void (*T3ScrollPhaseHandler)(int phase, double at, double deltaX, double travelX, double travelY);

void *t3_monitor_trackpad_scroll(uintptr_t viewHandle, T3ScrollPhaseHandler onPhase) {
  NSView *view = (__bridge NSView *)(void *)viewHandle;
  const NSInteger windowNumber = view.window.windowNumber;
  if (windowNumber <= 0) return NULL;

  __block BOOL tracking = NO, shifted = NO;
  __block double deltaX = 0, travelX = 0, travelY = 0;
  id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
      handler:^NSEvent *(NSEvent *event) {
        const NSEventPhase phase = event.phase;
        if (phase == NSEventPhaseNone || event.windowNumber != windowNumber) return event;
        if (phase == NSEventPhaseBegan) {
          tracking = YES;
          shifted = NO;
          deltaX = travelX = travelY = 0;
        }
        if (!tracking) return event;
        shifted |= (event.modifierFlags & NSEventModifierFlagShift) != 0;

        if (phase != NSEventPhaseCancelled) {
          const CGEventRef wheel = event.CGEvent;
          if (wheel) {
            const double x = -(double)CGEventGetIntegerValueField(wheel, kCGScrollWheelEventPointDeltaAxis2);
            const double y = (double)CGEventGetIntegerValueField(wheel, kCGScrollWheelEventPointDeltaAxis1);
            deltaX += x;
            travelX += fabs(x);
            travelY += fabs(y);
          }
        }
        if (phase == NSEventPhaseBegan || phase == NSEventPhaseEnded || phase == NSEventPhaseCancelled) {
          // Chromium's wheel timestamp is derived from the same NSEvent uptime timestamp.
          double epoch = NSDate.date.timeIntervalSince1970 - NSProcessInfo.processInfo.systemUptime;
          const NSEventPhase reportedPhase = shifted && phase == NSEventPhaseEnded ? NSEventPhaseCancelled : phase;
          onPhase((int)reportedPhase, (epoch + event.timestamp) * 1000, deltaX, travelX, travelY);
          if (phase != NSEventPhaseBegan) tracking = NO;
        }
        return event;
      }];
  return (__bridge_retained void *)monitor;
}

void t3_remove_trackpad_monitor(void *token) {
  if (token) [NSEvent removeMonitor:(__bridge_transfer id)token];
}
