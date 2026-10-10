#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Turns on React Native's `preventShadowTreeCommitExhaustion`.
///
/// Reanimated's `DISABLE_COMMIT_PAUSING_MECHANISM` (apps/mobile/package.json) is
/// only safe with it. Without it, Reanimated commits every animation frame and a
/// React commit that takes longer than a frame is retried forever, so the app
/// stops responding.
@interface T3ReactNativeFeatureFlags : NSObject

/// Call after RCTReactNativeFactory installs its feature flags and before
/// React Native reads preventShadowTreeCommitExhaustion. Debug builds assert the
/// second part.
+ (void)applyOverrides;

@end

NS_ASSUME_NONNULL_END
