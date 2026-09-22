#import "RCTBridge.h"
#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface T3SourceTextManager : RCTViewManager
@end

@implementation T3SourceTextManager

RCT_EXPORT_MODULE(T3SourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface T3SourceTextRunManager : RCTViewManager
@end

@implementation T3SourceTextRunManager

RCT_EXPORT_MODULE(T3SourceTextRun)

- (UIView *)view {
  return nil;
}

@end
