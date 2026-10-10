#import "T3ReactNativeFeatureFlags.h"

#import <React/RCTAssert.h>
#import <react/featureflags/ReactNativeFeatureFlags.h>
#import <react/featureflags/ReactNativeFeatureFlagsOverridesOSSStable.h>

using namespace facebook::react;

namespace {

// The stable release level, which ExpoReactNativeFactory picks when Info.plist
// sets no ReactNativeReleaseLevel, plus the one flag Reanimated needs.
class T3FeatureFlagsProvider : public ReactNativeFeatureFlagsOverridesOSSStable {
 public:
  bool preventShadowTreeCommitExhaustion() override
  {
    return true;
  }
};

} // namespace

@implementation T3ReactNativeFeatureFlags

+ (void)applyOverrides
{
  // RCTReactNativeFactory has already made the one-time override, so only a
  // forced override can change a flag without building React Native from source.
  // Flags read before this keep their values, since the provider only changes
  // one flag, and that one must not have been read yet.
  auto accessedFlags =
      ReactNativeFeatureFlags::dangerouslyForceOverride(std::make_unique<T3FeatureFlagsProvider>());
  RCTAssert(
      (", " + accessedFlags.value_or("") + ", ").find(", preventShadowTreeCommitExhaustion, ") ==
          std::string::npos,
      @"React Native read preventShadowTreeCommitExhaustion before "
      @"T3ReactNativeFeatureFlags overrode it");
}

@end
