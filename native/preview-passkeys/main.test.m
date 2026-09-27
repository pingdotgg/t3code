#import "main.m"

API_AVAILABLE(macos(14.4))
@interface ValidationRequest : PasskeyRequest
@property BOOL rejected;
@end
@implementation ValidationRequest
- (void)finish:(NSDictionary *)result {
  NSCAssert([result[@"error"] isEqual:@"TypeError"], @"Malformed input must fail before calling AuthenticationServices");
  self.rejected = YES;
}
@end

int main(void) {
  @autoreleasepool {
    if (@available(macOS 14.4, *)) {
      for (NSString *value in @[@"", @"A", @"AAAAA", @"not base64"]) {
        for (NSString *operation in @[@"get", @"create"]) {
          for (NSString *field in @[@"challenge", @"credentials", @"userId"]) {
            if ([operation isEqual:@"get"] && [field isEqual:@"userId"]) continue;
            NSMutableDictionary *options = [@{@"operation": operation, @"challenge": @"AQID",
              @"credentials": @[@"BAUG"], @"userId": @"BwgJ"} mutableCopy];
            options[field] = [field isEqual:@"credentials"] ? @[value] : (id)value;
            ValidationRequest *request = [ValidationRequest new];
            [request start:options];
            NSCAssert(request.rejected, @"Malformed %@ must be rejected", field);
          }
        }
      }
    }
  }
  return 0;
}
