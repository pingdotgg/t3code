#import "T3MarkdownText.h"
#import "T3MarkdownTextShadowNode.h"
#import "T3MarkdownTextComponentDescriptor.h"
#import "T3MarkdownTextRun.h"
#import <React/RCTConversions.h>
#import <objc/runtime.h>

#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>
#import <react/renderer/components/T3MarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/T3MarkdownTextSpec/Props.h>
#import <react/renderer/components/T3MarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"

using namespace facebook::react;

static void T3MarkdownTextApplyParagraphStyles(
    NSMutableAttributedString *attributedString,
    const std::vector<T3MarkdownTextParagraphStyleRange> &styleRanges)
{
  for (const auto &styleRange : styleRanges) {
    if (styleRange.length == 0 || styleRange.location >= attributedString.length) {
      continue;
    }

    const NSRange markerRange = NSMakeRange(
        styleRange.location,
        MIN(styleRange.length, attributedString.length - styleRange.location));
    const NSRange paragraphRange = [attributedString.string paragraphRangeForRange:markerRange];
    const NSParagraphStyle *existingStyle =
        [attributedString attribute:NSParagraphStyleAttributeName
                            atIndex:paragraphRange.location
                     effectiveRange:nil];
    NSMutableParagraphStyle *paragraphStyle =
        existingStyle ? [existingStyle mutableCopy] : [NSMutableParagraphStyle new];
    paragraphStyle.firstLineHeadIndent = styleRange.firstLineHeadIndent;
    paragraphStyle.headIndent = styleRange.headIndent;
    paragraphStyle.paragraphSpacing = styleRange.paragraphSpacing;
    paragraphStyle.tabStops = @[
      [[NSTextTab alloc] initWithTextAlignment:NSTextAlignmentLeft
                                      location:styleRange.headIndent
                                       options:@{}]
    ];
    paragraphStyle.defaultTabInterval = styleRange.headIndent;
    [attributedString addAttribute:NSParagraphStyleAttributeName
                             value:paragraphStyle
                             range:paragraphRange];
  }
}

static void T3MarkdownTextApplyAttachments(
    NSMutableAttributedString *attributedString,
    const std::vector<T3MarkdownTextAttachmentRange> &attachmentRanges,
    NSDictionary<NSString *, UIImage *> *images)
{
  for (const auto &attachmentRange : attachmentRanges) {
    if (attachmentRange.length == 0 || attachmentRange.location >= attributedString.length) {
      continue;
    }

    NSString *imageUri = [NSString stringWithUTF8String:attachmentRange.imageUri.c_str()];
    NSTextAttachment *attachment = [[NSTextAttachment alloc] init];
    UIImage *image = images[imageUri];
    if ([imageUri hasPrefix:@"sf:"]) {
      NSString *symbolName = [imageUri substringFromIndex:3];
      UIColor *foregroundColor =
          [attributedString attribute:NSForegroundColorAttributeName
                              atIndex:attachmentRange.location
                       effectiveRange:nil] ?: UIColor.labelColor;
      image = [[UIImage systemImageNamed:symbolName] imageWithTintColor:foregroundColor
                                                          renderingMode:UIImageRenderingModeAlwaysOriginal];
    }
    attachment.image = image ?: [[UIImage alloc] init];
    const CGFloat attachmentSize = T3MarkdownTextAttachmentSize(attachmentRange);
    attachment.bounds = CGRectMake(
        0,
        T3MarkdownTextAttachmentBaselineOffset(attachmentRange),
        attachmentSize,
        attachmentSize);
    const NSRange range = NSMakeRange(
        attachmentRange.location,
        MIN(attachmentRange.length, attributedString.length - attachmentRange.location));
    NSAttributedString *attachmentString =
        [NSAttributedString attributedStringWithAttachment:attachment];
    [attributedString replaceCharactersInRange:range withAttributedString:attachmentString];
  }
}

@protocol T3MarkdownOutsideTapTarget <NSObject>
- (void)clearSelectionForOutsideTapWithHitView:(UIView *)hitView;
@end

@interface T3MarkdownOutsideTapCoordinator : NSObject <UIGestureRecognizerDelegate>

- (instancetype)initWithWindow:(UIWindow *)window;
- (void)addTarget:(id<T3MarkdownOutsideTapTarget>)target;
- (void)removeTarget:(id<T3MarkdownOutsideTapTarget>)target;

@end

static const void *T3MarkdownOutsideTapCoordinatorKey =
    &T3MarkdownOutsideTapCoordinatorKey;

@implementation T3MarkdownOutsideTapCoordinator {
  __weak UIWindow *_window;
  UITapGestureRecognizer *_recognizer;
  NSHashTable<id<T3MarkdownOutsideTapTarget>> *_targets;
}

- (instancetype)initWithWindow:(UIWindow *)window
{
  if (self = [super init]) {
    _window = window;
    _targets = [NSHashTable weakObjectsHashTable];
    _recognizer = [[UITapGestureRecognizer alloc] initWithTarget:self
                                                          action:@selector(handleTap:)];
    _recognizer.cancelsTouchesInView = NO;
    _recognizer.delegate = self;
    [window addGestureRecognizer:_recognizer];
  }
  return self;
}

- (void)addTarget:(id<T3MarkdownOutsideTapTarget>)target
{
  [_targets addObject:target];
}

- (void)removeTarget:(id<T3MarkdownOutsideTapTarget>)target
{
  [_targets removeObject:target];
  if (_targets.count > 0) {
    return;
  }

  UIWindow *window = _window;
  [window removeGestureRecognizer:_recognizer];
  if (objc_getAssociatedObject(window, T3MarkdownOutsideTapCoordinatorKey) == self) {
    objc_setAssociatedObject(
        window,
        T3MarkdownOutsideTapCoordinatorKey,
        nil,
        OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
}

- (void)handleTap:(UITapGestureRecognizer *)sender
{
  UIWindow *window = _window;
  if (window == nil) {
    return;
  }

  UIView *hitView = [window hitTest:[sender locationInView:window] withEvent:nil];
  if (hitView == nil) {
    return;
  }
  for (id<T3MarkdownOutsideTapTarget> target in _targets.allObjects) {
    [target clearSelectionForOutsideTapWithHitView:hitView];
  }
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer
{
  return YES;
}

@end

static T3MarkdownOutsideTapCoordinator *
T3MarkdownOutsideTapCoordinatorForWindow(UIWindow *window)
{
  T3MarkdownOutsideTapCoordinator *coordinator =
      objc_getAssociatedObject(window, T3MarkdownOutsideTapCoordinatorKey);
  if (coordinator == nil) {
    coordinator = [[T3MarkdownOutsideTapCoordinator alloc] initWithWindow:window];
    objc_setAssociatedObject(
        window,
        T3MarkdownOutsideTapCoordinatorKey,
        coordinator,
        OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return coordinator;
}

@interface T3MarkdownText () <RCTT3MarkdownTextViewProtocol, UIGestureRecognizerDelegate, UITextViewDelegate>

@end

@interface T3MarkdownText () <T3MarkdownOutsideTapTarget>
@end

@implementation T3MarkdownText {
  UIView * _view;
  UITextView * _textView;
  T3MarkdownTextShadowNode::ConcreteState::Shared _state;
  __weak UIWindow * _outsideTapWindow;
  BOOL _suppressSelectionChange;
  NSMutableDictionary<NSString *, UIImage *> * _attachmentImages;
  NSMutableSet<NSString *> * _pendingAttachmentUris;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
  return concreteComponentDescriptorProvider<T3MarkdownTextComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const T3MarkdownTextProps>();
    _props = defaultProps;

    _view = [[UIView alloc] init];
    self.contentView = _view;
    self.clipsToBounds = true;

    _textView = [[UITextView alloc] init];
    _attachmentImages = [[NSMutableDictionary alloc] init];
    _pendingAttachmentUris = [[NSMutableSet alloc] init];
    _textView.scrollEnabled = false;
    _textView.editable = false;
    _textView.textContainerInset = UIEdgeInsetsZero;
    _textView.textContainer.lineFragmentPadding = 0;
    _textView.delegate = self;
    // Must match RCTTextLayoutManager, which measures with usesFontLeading = NO.
    _textView.layoutManager.usesFontLeading = NO;
    [self addSubview:_textView];

    const auto longPressGestureRecognizer = [[UILongPressGestureRecognizer alloc] initWithTarget:self
                                                                                          action:@selector(handleLongPressIfNecessary:)];
    longPressGestureRecognizer.delegate = self;

    const auto pressGestureRecognizer = [[UITapGestureRecognizer alloc] initWithTarget:self
                                                                                action:@selector(handlePressIfNecessary:)];
    pressGestureRecognizer.delegate = self;
    [pressGestureRecognizer requireGestureRecognizerToFail:longPressGestureRecognizer];

    [_textView addGestureRecognizer:pressGestureRecognizer];
    [_textView addGestureRecognizer:longPressGestureRecognizer];
  }

  return self;
}

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  if (_outsideTapWindow == self.window) {
    return;
  }
  if (_outsideTapWindow != nil) {
    T3MarkdownOutsideTapCoordinator *coordinator =
        objc_getAssociatedObject(_outsideTapWindow, T3MarkdownOutsideTapCoordinatorKey);
    [coordinator removeTarget:self];
  }
  _outsideTapWindow = self.window;
  if (_outsideTapWindow != nil) {
    [T3MarkdownOutsideTapCoordinatorForWindow(_outsideTapWindow) addTarget:self];
  }
}

- (void)dealloc
{
  T3MarkdownOutsideTapCoordinator *coordinator =
      objc_getAssociatedObject(_outsideTapWindow, T3MarkdownOutsideTapCoordinatorKey);
  [coordinator removeTarget:self];
}

// See RCTParagraphComponentView
- (void)prepareForRecycle
{
  [super prepareForRecycle];
  T3MarkdownOutsideTapCoordinator *coordinator =
      objc_getAssociatedObject(_outsideTapWindow, T3MarkdownOutsideTapCoordinatorKey);
  [coordinator removeTarget:self];
  _outsideTapWindow = nil;
  _state.reset();

  // Reset the frame to zero so that when it properly lays out on the next use
  _textView.frame = CGRectZero;
  _textView.attributedText = nil;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  // _textView's frame is assigned inside drawRect, which only fires when
  // state changes. Trigger a redraw whenever the host frame moves out from
  // under it (rotation, parent relayout) so the text view resizes and
  // onTextLayout re-fires with the new line wrapping.
  if (!CGRectEqualToRect(_textView.frame, _view.frame)) {
    [self setNeedsDisplay];
  }
}

- (void)drawRect:(CGRect)rect
{
  if (!_state) {
    return;
  }

  const auto &props = *std::static_pointer_cast<T3MarkdownTextProps const>(_props);

  const auto attrString = _state->getData().attributedString;
  NSMutableAttributedString *convertedAttrString =
      [RCTNSAttributedStringFromAttributedString(attrString) mutableCopy];
  T3MarkdownTextApplyParagraphStyles(
      convertedAttrString,
      _state->getData().paragraphStyleRanges);
  T3MarkdownTextApplyAttachments(
      convertedAttrString,
      _state->getData().attachmentRanges,
      _attachmentImages);
  [self loadAttachmentImages:_state->getData().attachmentRanges];

  // Setting attributedText clears any active text selection, and re-assigning
  // the frame triggers a layout flush that has the same effect. Bail out
  // entirely when nothing actually changed so a JS-side state update made in
  // response to onSelectionChange doesn't deselect what the user is selecting.
  const BOOL textChanged = ![_textView.attributedText isEqualToAttributedString:convertedAttrString];
  const BOOL frameChanged = !CGRectEqualToRect(_textView.frame, _view.frame);
  if (!textChanged && !frameChanged) {
    return;
  }
  if (textChanged) {
    // Reassigning attributedText clears any active selection. Save it and
    // restore after, while suppressing the synthetic textViewDidChangeSelection
    // events the clear-then-restore would otherwise produce — those would
    // round-trip to JS and re-trigger this same path, causing a loop.
    const NSRange savedRange = _textView.selectedRange;
    _suppressSelectionChange = YES;
    _textView.attributedText = convertedAttrString;
    if (savedRange.length > 0 && NSMaxRange(savedRange) <= _textView.attributedText.length) {
      _textView.selectedRange = savedRange;
    }
    _suppressSelectionChange = NO;
  }
  if (frameChanged) {
    _textView.frame = _view.frame;
  }

  __block std::vector<std::string> lines;
  const int maxLines = props.numberOfLines;
  [_textView.layoutManager enumerateLineFragmentsForGlyphRange:NSMakeRange(0, convertedAttrString.string.length) usingBlock:^(CGRect rect,
                                                                                              CGRect usedRect,
                                                                                              NSTextContainer * _Nonnull textContainer,
                                                                                              NSRange glyphRange,
                                                                                              BOOL * _Nonnull stop) {
    const auto charRange = [self->_textView.layoutManager characterRangeForGlyphRange:glyphRange actualGlyphRange:nil];
    const auto line = [self->_textView.text substringWithRange:charRange];
    lines.push_back(line.UTF8String);
    // enumerateLineFragments overshoots maximumNumberOfLines by one on iOS
    // 18, so cap explicitly.
    if (maxLines > 0 && lines.size() >= (size_t)maxLines) {
      *stop = YES;
    }
  }];

  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::T3MarkdownTextEventEmitter>(_eventEmitter)
    ->onTextLayout(facebook::react::T3MarkdownTextEventEmitter::OnTextLayout{static_cast<int>(self.tag), lines});
  };
}

- (void)loadAttachmentImages:(const std::vector<T3MarkdownTextAttachmentRange> &)attachmentRanges
{
  for (const auto &attachmentRange : attachmentRanges) {
    NSString *imageUri = [NSString stringWithUTF8String:attachmentRange.imageUri.c_str()];
    if ([imageUri hasPrefix:@"sf:"]) {
      continue;
    }
    if (_attachmentImages[imageUri] != nil || [_pendingAttachmentUris containsObject:imageUri]) {
      continue;
    }

    NSURL *url = [NSURL URLWithString:imageUri];
    if (url == nil) {
      continue;
    }
    if (url.isFileURL) {
      UIImage *image = [UIImage imageWithContentsOfFile:url.path];
      if (image != nil) {
        _attachmentImages[imageUri] = image;
        dispatch_async(dispatch_get_main_queue(), ^{
          [self refreshDisplayedAttachments];
        });
      }
      continue;
    }

    [_pendingAttachmentUris addObject:imageUri];
    [[[NSURLSession sharedSession] dataTaskWithURL:url
                                completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
      UIImage *image = data == nil ? nil : [UIImage imageWithData:data];
      dispatch_async(dispatch_get_main_queue(), ^{
        [self->_pendingAttachmentUris removeObject:imageUri];
        if (image != nil) {
          self->_attachmentImages[imageUri] = image;
          [self refreshDisplayedAttachments];
        }
      });
    }] resume];
  }
}

- (void)refreshDisplayedAttachments
{
  if (!_state || _textView.attributedText == nil) {
    return;
  }

  NSMutableAttributedString *attributedText = [_textView.attributedText mutableCopy];
  T3MarkdownTextApplyAttachments(
      attributedText,
      _state->getData().attachmentRanges,
      _attachmentImages);

  const NSRange savedRange = _textView.selectedRange;
  _suppressSelectionChange = YES;
  _textView.attributedText = attributedText;
  if (savedRange.location != NSNotFound &&
      NSMaxRange(savedRange) <= _textView.attributedText.length) {
    _textView.selectedRange = savedRange;
  }
  _suppressSelectionChange = NO;
  [_textView setNeedsDisplay];
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<T3MarkdownTextProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<T3MarkdownTextProps const>(props);

  if (oldViewProps.numberOfLines != newViewProps.numberOfLines) {
    _textView.textContainer.maximumNumberOfLines = newViewProps.numberOfLines;
  }

  if (oldViewProps.selectable != newViewProps.selectable) {
    _textView.selectable = newViewProps.selectable;
  }

  if (oldViewProps.allowFontScaling != newViewProps.allowFontScaling) {
    if (@available(iOS 11.0, *)) {
      _textView.adjustsFontForContentSizeCategory = newViewProps.allowFontScaling;
    }
  }

  if (oldViewProps.ellipsizeMode != newViewProps.ellipsizeMode) {
    if (newViewProps.ellipsizeMode == T3MarkdownTextEllipsizeMode::Head) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingHead;
    } else if (newViewProps.ellipsizeMode == T3MarkdownTextEllipsizeMode::Middle) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingMiddle;
    } else if (newViewProps.ellipsizeMode == T3MarkdownTextEllipsizeMode::Tail) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByTruncatingTail;
    } else if (newViewProps.ellipsizeMode == T3MarkdownTextEllipsizeMode::Clip) {
      _textView.textContainer.lineBreakMode = NSLineBreakMode::NSLineBreakByClipping;
    }
  }


  // I'm not sure if this is really the right way to handle this style. This means that the entire _view_ the text
  // is in will have this background color applied. To apply it just to a particular part of a string, you'd need
  // to do <Text><Text style={{backgroundColor: 'blue'}}>Hello</Text></Text>.
  // This is how the base <Text> component works though, so we'll go with it for now. Can change later if we want.
  if (oldViewProps.backgroundColor != newViewProps.backgroundColor) {
    _textView.backgroundColor = RCTUIColorFromSharedColor(newViewProps.backgroundColor);
  }

  [super updateProps:props oldProps:oldProps];
}

// See RCTParagraphComponentView
- (void)updateState:(const facebook::react::State::Shared &)state oldState:(const facebook::react::State::Shared &)oldState
{
  _state = std::static_pointer_cast<const T3MarkdownTextShadowNode::ConcreteState>(state);
  [self setNeedsDisplay];
}

// MARK: - UIGestureRecognizerDelegate

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer
{
  return YES;
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer shouldReceiveTouch:(UITouch *)touch
{
  return YES;
}

- (void)clearSelectionForOutsideTapWithHitView:(UIView *)hitView
{
  if ([hitView isDescendantOfView:self]) {
    return;
  }
  // Defer past the current event loop turn so any in-flight edit-menu action
  // (Copy / Define / Look Up / …) reads the live selection before we clear it.
  UITextView *textView = _textView;
  dispatch_async(dispatch_get_main_queue(), ^{
    UITextRange *range = textView.selectedTextRange;
    if (range != nil && !range.isEmpty) {
      textView.selectedTextRange = nil;
    }
  });
}

// MARK: - Touch handling

- (CGPoint)getLocationOfPress:(UIGestureRecognizer*)sender
{
  return [sender locationInView:_textView];
}

- (T3MarkdownTextRun*)getTouchChild:(CGPoint)location
{
  const auto charIndex = [_textView.layoutManager characterIndexForPoint:location
                                                         inTextContainer:_textView.textContainer
                                fractionOfDistanceBetweenInsertionPoints:nil
  ];

  int currIndex = -1;
  for (UIView* child in self.subviews) {
    if (![child isKindOfClass:[T3MarkdownTextRun class]]) {
      continue;
    }

    T3MarkdownTextRun* textChild = (T3MarkdownTextRun*)child;

    // This is UTF16 code units!!
    currIndex += textChild.text.length;

    if (charIndex <= currIndex) {
      return textChild;
    }
  }

  return nil;
}

- (void)handlePressIfNecessary:(UITapGestureRecognizer*)sender
{
  const auto location = [self getLocationOfPress:sender];
  const auto child = [self getTouchChild:location];

  if (child) {
    [child onPress];
  }
}

- (void)handleLongPressIfNecessary:(UILongPressGestureRecognizer*)sender
{
  const auto location = [self getLocationOfPress:sender];
  const auto child = [self getTouchChild:location];

  if (child) {
    [child onLongPress];
  }
}

// MARK: - UITextViewDelegate

- (void)textViewDidChangeSelection:(UITextView *)textView
{
  if (_suppressSelectionChange) {
    return;
  }
  if (_eventEmitter == nullptr) {
    return;
  }

  const NSRange selectedRange = textView.selectedRange;
  if (selectedRange.location == NSNotFound) {
    return;
  }

  // Fires on programmatic selection changes too (e.g. the outside-tap clear
  // in handleOutsideTap:), so JS will see a synthetic empty-range event then.
  std::dynamic_pointer_cast<const facebook::react::T3MarkdownTextEventEmitter>(_eventEmitter)
    ->onSelectionChange(facebook::react::T3MarkdownTextEventEmitter::OnSelectionChange{
      static_cast<int>(self.tag),
      static_cast<int>(selectedRange.location),
      static_cast<int>(selectedRange.location + selectedRange.length),
    });
}

Class<RCTComponentViewProtocol> T3MarkdownTextCls(void)
{
  return T3MarkdownText.class;
}

@end
