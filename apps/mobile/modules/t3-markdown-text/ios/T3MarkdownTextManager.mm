#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface T3MarkdownTextManager : RCTViewManager
@end

@implementation T3MarkdownTextManager

RCT_EXPORT_MODULE(T3MarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface T3MarkdownTextRunManager : RCTViewManager
@end

@implementation T3MarkdownTextRunManager

RCT_EXPORT_MODULE(T3MarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
