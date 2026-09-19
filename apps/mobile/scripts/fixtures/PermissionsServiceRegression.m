@interface TestPermissionRequester : NSObject <EXPermissionsRequester>
@end

@implementation TestPermissionRequester
+ (NSString *)permissionType { return NSStringFromClass(self); }
- (NSDictionary *)getPermissions { return @{ @"status": @(EXPermissionStatusGranted) }; }
- (void)requestPermissionsWithResolver:(EXPromiseResolveBlock)resolve rejecter:(EXPromiseRejectBlock)reject {
  resolve([self getPermissions]);
}
@end

typedef struct {
  __unsafe_unretained EXPermissionsService *service;
  __unsafe_unretained NSArray *requesters;
  size_t offset;
} Worker;

static void *exerciseRegistry(void *context) {
  Worker *worker = context;
  for (size_t index = 0; index < 250; index++) {
    @autoreleasepool {
      id<EXPermissionsRequester> requester = worker->requesters[(index + worker->offset) % worker->requesters.count];
      [worker->service registerRequesters:@[requester]];
      id resolved = [worker->service getPermissionRequesterForType:[[requester class] permissionType]];
      assert(resolved == requester);
      NSDictionary *permissions = [worker->service getPermissionUsingRequesterClass:[requester class]];
      assert([permissions[@"status"] isEqualToString:@"granted"]);
    }
  }
  return NULL;
}

int main(void) {
  @autoreleasepool {
    EXPermissionsService *service = [EXPermissionsService new];
    NSMutableArray *requesters = [NSMutableArray new];
    for (int i = 0; i < 32; i++) {
      NSString *name = [NSString stringWithFormat:@"TestPermission%d", i];
      Class cls = objc_allocateClassPair([TestPermissionRequester class], name.UTF8String, 0);
      objc_registerClassPair(cls);
      [requesters addObject:[cls new]];
    }
    Worker workers[8];
    pthread_t threads[8];
    for (size_t index = 0; index < 8; index++) {
      workers[index] = (Worker){ service, requesters, index };
      assert(pthread_create(&threads[index], NULL, exerciseRegistry, &workers[index]) == 0);
    }
    for (size_t index = 0; index < 8; index++) {
      assert(pthread_join(threads[index], NULL) == 0);
    }
    puts("passed");
  }
  return 0;
}
