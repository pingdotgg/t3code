#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/SecTask.h>

// Loaded inside Electron's main process so the system sheet belongs to the
// requesting browser window and uses the app's browser credential entitlement.
typedef void (*Completion)(const char *);
static NSMutableDictionary *requests;

static NSData *decode(NSString *value) {
  NSString *base64 = [[value stringByReplacingOccurrencesOfString:@"-" withString:@"+"]
      stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
  while (base64.length % 4) base64 = [base64 stringByAppendingString:@"="];
  return [[NSData alloc] initWithBase64EncodedString:base64 options:0];
}
static NSString *encode(NSData *value) {
  if (!value) return @"";
  return [[[[value base64EncodedStringWithOptions:0]
      stringByReplacingOccurrencesOfString:@"+" withString:@"-"]
      stringByReplacingOccurrencesOfString:@"/" withString:@"_"]
      stringByReplacingOccurrencesOfString:@"=" withString:@""];
}

BOOL t3_passkeys_available(void) {
  if (@available(macOS 14.4, *)) {
    SecTaskRef task = SecTaskCreateFromSelf(NULL);
    if (!task) return NO;
    CFTypeRef value = SecTaskCopyValueForEntitlement(task,
        CFSTR("com.apple.developer.web-browser.public-key-credential"), NULL);
    BOOL allowed = value && CFEqual(value, kCFBooleanTrue);
    if (value) CFRelease(value);
    CFRelease(task);
    return allowed;
  }
  return NO;
}

API_AVAILABLE(macos(14.4))
@interface PasskeyRequest : NSObject <ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding>
@property NSWindow *window;
@property ASAuthorizationController *controller;
@property ASAuthorizationWebBrowserPublicKeyCredentialManager *manager;
@property Completion completion;
@property NSString *result;
- (void)finish:(NSDictionary *)result;
- (void)start:(NSDictionary *)options;
@end

@implementation PasskeyRequest
- (void)finish:(NSDictionary *)result {
  if (self.result) return;
  self.result = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:result options:0 error:nil]
                                    encoding:NSUTF8StringEncoding];
  self.completion(self.result.UTF8String);
}
- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
  return self.window;
}
- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithError:(NSError *)error {
  NSString *name = @"NotAllowedError";
  if (@available(macOS 15.0, *)) {
    if (error.code == ASAuthorizationErrorMatchedExcludedCredential) name = @"InvalidStateError";
  }
  [self finish:@{@"error": name}];
}
- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithAuthorization:(ASAuthorization *)authorization {
  id credential = authorization.credential;
  if ([credential conformsToProtocol:@protocol(ASAuthorizationPublicKeyCredentialAssertion)]) {
    id<ASAuthorizationPublicKeyCredentialAssertion> assertion = credential;
    BOOL platform = [credential isKindOfClass:ASAuthorizationPlatformPublicKeyCredentialAssertion.class] &&
        ((ASAuthorizationPlatformPublicKeyCredentialAssertion *)credential).attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform;
    [self finish:@{@"id": encode(assertion.credentialID),
      @"authenticatorAttachment": platform ? @"platform" : @"cross-platform",
      @"response": @{@"clientDataJSON": encode(assertion.rawClientDataJSON),
        @"authenticatorData": encode(assertion.rawAuthenticatorData),
        @"signature": encode(assertion.signature), @"userHandle": encode(assertion.userID)}}];
  } else if ([credential isKindOfClass:ASAuthorizationPlatformPublicKeyCredentialRegistration.class]) {
    ASAuthorizationPlatformPublicKeyCredentialRegistration *registration = credential;
    [self finish:@{@"id": encode(registration.credentialID),
      @"authenticatorAttachment": registration.attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform ? @"platform" : @"cross-platform",
      @"response": @{@"clientDataJSON": encode(registration.rawClientDataJSON),
        @"attestationObject": encode(registration.rawAttestationObject)}}];
  } else {
    [self finish:@{@"error": @"NotSupportedError"}];
  }
}
- (void)start:(NSDictionary *)options {
  if (self.result) return;
  ASPublicKeyCredentialClientData *clientData = [[ASPublicKeyCredentialClientData alloc]
      initWithChallenge:decode(options[@"challenge"]) origin:options[@"origin"]];
  clientData.crossOrigin = ASPublicKeyCredentialClientDataCrossOriginValueSameOriginWithAncestors;
  ASAuthorizationPlatformPublicKeyCredentialProvider *provider =
      [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:options[@"rpId"]];
  NSMutableArray *descriptors = [NSMutableArray array];
  for (NSString *identifier in options[@"credentials"]) {
    [descriptors addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc]
        initWithCredentialID:decode(identifier)]];
  }
  NSMutableArray<ASAuthorizationRequest *> *authorizationRequests = [NSMutableArray array];
  ASAuthorizationRequest *request;
  if ([options[@"operation"] isEqual:@"create"]) {
    ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *registration =
        [provider createCredentialRegistrationRequestWithClientData:clientData
            name:options[@"userName"] userID:decode(options[@"userId"])];
    registration.displayName = options[@"displayName"];
    registration.userVerificationPreference = options[@"userVerification"];
    registration.excludedCredentials = descriptors;
    registration.attestationPreference = options[@"attestation"];
    registration.shouldShowHybridTransport = YES;
    request = registration;
  } else {
    ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *assertion =
        [provider createCredentialAssertionRequestWithClientData:clientData];
    assertion.allowedCredentials = descriptors;
    assertion.userVerificationPreference = options[@"userVerification"];
    assertion.shouldShowHybridTransport = YES;
    request = assertion;
    ASAuthorizationSecurityKeyPublicKeyCredentialProvider *securityProvider =
        [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:options[@"rpId"]];
    ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *securityRequest =
        [securityProvider createCredentialAssertionRequestWithClientData:clientData];
    NSMutableArray *securityDescriptors = [NSMutableArray array];
    for (NSString *identifier in options[@"credentials"]) {
      [securityDescriptors addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc]
          initWithCredentialID:decode(identifier) transports:ASAuthorizationAllSupportedPublicKeyCredentialDescriptorTransports()]];
    }
    securityRequest.allowedCredentials = securityDescriptors;
    securityRequest.userVerificationPreference = options[@"userVerification"];
    [authorizationRequests addObject:securityRequest];
  }
  [authorizationRequests insertObject:request atIndex:0];
  self.controller = [[ASAuthorizationController alloc] initWithAuthorizationRequests:authorizationRequests];
  self.controller.delegate = self;
  self.controller.presentationContextProvider = self;
  [self.controller performRequests];
}
@end

void t3_passkeys_start(int identifier, uint64_t nativeView, const char *json, Completion completion) {
  NSString *input = [NSString stringWithUTF8String:json];
  dispatch_async(dispatch_get_main_queue(), ^{
    if (@available(macOS 14.4, *)) {
      if (!requests) requests = [NSMutableDictionary dictionary];
      PasskeyRequest *request = [PasskeyRequest new];
      request.completion = completion;
      request.window = ((__bridge NSView *)(void *)(uintptr_t)nativeView).window;
      requests[@(identifier)] = request;
      NSDictionary *options = [NSJSONSerialization JSONObjectWithData:[input dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
      if (!t3_passkeys_available() || !request.window || !options) {
        [request finish:@{@"error": @"NotAllowedError"}];
        return;
      }
      request.manager = [ASAuthorizationWebBrowserPublicKeyCredentialManager new];
      if (request.manager.authorizationStateForPlatformCredentials == ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateNotDetermined) {
        [request.manager requestAuthorizationForPublicKeyCredentials:^(ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationState state) {
          dispatch_async(dispatch_get_main_queue(), ^{
            if (state == ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateAuthorized) [request start:options];
            else [request finish:@{@"error": @"NotAllowedError"}];
          });
        }];
      } else if (request.manager.authorizationStateForPlatformCredentials == ASAuthorizationWebBrowserPublicKeyCredentialManagerAuthorizationStateAuthorized) {
        [request start:options];
      } else {
        [request finish:@{@"error": @"NotAllowedError"}];
      }
    }
  });
}

void t3_passkeys_cancel(int identifier) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (@available(macOS 14.4, *)) {
      PasskeyRequest *request = requests[@(identifier)];
      [request finish:@{@"error": @"AbortError"}];
      [request.controller cancel];
    }
  });
}

// The result string stays alive until the asynchronous FFI callback consumes it.
void t3_passkeys_release(int identifier) {
  dispatch_async(dispatch_get_main_queue(), ^{ [requests removeObjectForKey:@(identifier)]; });
}
