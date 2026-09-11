#pragma once

#import <UIKit/UIKit.h>

// Used by both the shadow measurement and UITextView rendering paths.
static NSDictionary *T3ContextChipPayload(NSString *uri)
{
  if (![uri hasPrefix:@"chip:"]) return nil;
  NSData *data = [[uri substringFromIndex:5] dataUsingEncoding:NSUTF8StringEncoding];
  id payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [payload isKindOfClass:NSDictionary.class] ? payload : nil;
}

static UIColor *T3ContextChipColor(NSString *hex)
{
  unsigned int rgb = 0;
  if (![hex isKindOfClass:NSString.class] || hex.length != 7) return UIColor.labelColor;
  [[NSScanner scannerWithString:[hex substringFromIndex:1]] scanHexInt:&rgb];
  return [UIColor colorWithRed:((rgb >> 16) & 255) / 255.0
                        green:((rgb >> 8) & 255) / 255.0
                         blue:(rgb & 255) / 255.0 alpha:1];
}

static UIColor *T3ContextChipBlend(UIColor *accent, UIColor *base, CGFloat weight)
{
  CGFloat ar = 0, ag = 0, ab = 0, aa = 0, br = 0, bg = 0, bb = 0, ba = 0;
  [accent getRed:&ar green:&ag blue:&ab alpha:&aa];
  [base getRed:&br green:&bg blue:&bb alpha:&ba];
  return [UIColor colorWithRed:ar * weight + br * (1 - weight)
                        green:ag * weight + bg * (1 - weight)
                         blue:ab * weight + bb * (1 - weight)
                        alpha:aa * weight + ba * (1 - weight)];
}

// Some chip glyphs have no SF Symbol that reads correctly: the pull request one would land on
// `arrow.triangle.branch`, a road-sign fork that says "branch", not "pull request". Draw those
// from the same lucide geometry web and Android use so one chip looks alike on every surface.
static UIImage *T3ContextChipVectorIcon(NSString *symbol, CGFloat size, UIColor *color)
{
  if (![symbol isEqualToString:@"git-pull-request"]) return nil;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc]
      initWithSize:CGSizeMake(size, size)];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    CGFloat s = size / 24.0;  // lucide authors on a 24pt grid.
    UIBezierPath *path = [UIBezierPath bezierPath];
    [path appendPath:[UIBezierPath bezierPathWithArcCenter:CGPointMake(18 * s, 18 * s)
                                                   radius:3 * s startAngle:0
                                                 endAngle:M_PI * 2 clockwise:YES]];
    [path appendPath:[UIBezierPath bezierPathWithArcCenter:CGPointMake(6 * s, 6 * s)
                                                   radius:3 * s startAngle:0
                                                 endAngle:M_PI * 2 clockwise:YES]];
    [path moveToPoint:CGPointMake(13 * s, 6 * s)];
    [path addLineToPoint:CGPointMake(16 * s, 6 * s)];
    [path addCurveToPoint:CGPointMake(18 * s, 8 * s)
            controlPoint1:CGPointMake(17.1 * s, 6 * s)
            controlPoint2:CGPointMake(18 * s, 6.9 * s)];
    [path addLineToPoint:CGPointMake(18 * s, 15 * s)];
    [path moveToPoint:CGPointMake(6 * s, 9 * s)];
    [path addLineToPoint:CGPointMake(6 * s, 21 * s)];
    path.lineWidth = 2 * s;
    path.lineCapStyle = kCGLineCapRound;
    path.lineJoinStyle = kCGLineJoinRound;
    [color setStroke];
    [path stroke];
  }];
}

// Centres the chip on the run font's ascent/descent box, the rule the composer span and
// Android use, so the chip lands in the same place beside the words on every surface.
static inline CGRect T3ContextChipBounds(UIFont *font, CGSize size)
{
  CGFloat y = font != nil ? (font.ascender + font.descender - size.height) / 2 : -3;
  return CGRectMake(0, y, size.width, size.height);
}

// A bare attachment string carries none of the run's attributes. Losing the paragraph
// style at a paragraph's first character drops its line height, and losing the font lets
// a chip-only line shrink to the bitmap, so the placeholder keeps both, plus the run
// colour so a later re-apply (after an image loads) still tints with it.
static inline NSAttributedString *T3MarkdownTextAttachmentString(
    NSTextAttachment *attachment, NSDictionary<NSAttributedStringKey, id> *runAttributes)
{
  NSMutableAttributedString *string =
      [[NSAttributedString attributedStringWithAttachment:attachment] mutableCopy];
  for (NSAttributedStringKey key in
       @[
         NSFontAttributeName, NSParagraphStyleAttributeName, NSForegroundColorAttributeName,
         NSBaselineOffsetAttributeName
       ]) {
    id value = runAttributes[key];
    if (value != nil) {
      [string addAttribute:key value:value range:NSMakeRange(0, string.length)];
    }
  }
  return string;
}

static UIFont *T3ContextChipFont(NSDictionary *payload)
{
  CGFloat size = MAX(10, MIN(40, [payload[@"fontSize"] doubleValue]));
  return [UIFont fontWithName:@"DMSans-Medium" size:size]
    ?: [UIFont systemFontOfSize:size weight:UIFontWeightMedium];
}

static inline CGSize T3ContextChipSize(NSDictionary *payload, CGFloat maximumWidth)
{
  UIFont *font = T3ContextChipFont(payload);
  NSString *label = payload[@"label"];
  CGFloat textWidth = [label sizeWithAttributes:@{ NSFontAttributeName: font }].width;
  return CGSizeMake(MIN(maximumWidth, ceil(textWidth + font.pointSize * 2.5)),
                    ceil(font.pointSize * 1.41));
}

static inline UIImage *T3ContextChipImage(NSDictionary *payload, CGSize size, UIImage *fileIcon)
{
  static NSCache<NSString *, UIImage *> *cache;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ cache = [NSCache new]; cache.countLimit = 256; });
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:NSJSONWritingSortedKeys error:nil];
  NSString *key = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  key = [key stringByAppendingString:NSStringFromCGSize(size)];
  if (fileIcon != nil) key = [key stringByAppendingString:@":file-icon"];
  UIImage *cached = [cache objectForKey:key];
  if (cached) return cached;
  UIFont *font = T3ContextChipFont(payload);
  CGFloat em = font.pointSize;
  UIColor *accent = T3ContextChipColor(payload[@"accent"]);
  UIColor *foreground = T3ContextChipBlend(accent, T3ContextChipColor(payload[@"foreground"]), 0.22);
  UIColor *border = T3ContextChipBlend(accent, T3ContextChipColor(payload[@"border"]), 0.34);
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size];
  UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    UIBezierPath *path = [UIBezierPath bezierPathWithRoundedRect:
        CGRectInset(CGRectMake(0, 0, size.width, size.height), 0.5, 0.5)
        cornerRadius:em * 0.5];
    [[accent colorWithAlphaComponent:0.11] setFill];
    [path fill];
    [border setStroke];
    path.lineWidth = 1;
    [path stroke];
    CGFloat iconSize = em * 1.17;
    UIImage *icon = fileIcon
        ?: T3ContextChipVectorIcon(payload[@"symbol"], iconSize, foreground)
        ?: [[UIImage systemImageNamed:payload[@"symbol"]
        withConfiguration:[UIImageSymbolConfiguration configurationWithPointSize:em weight:UIImageSymbolWeightMedium]]
        imageWithTintColor:foreground renderingMode:UIImageRenderingModeAlwaysOriginal];
    [icon drawInRect:CGRectMake(em * 0.5, (size.height - iconSize) / 2, iconSize, iconSize)];
    NSMutableParagraphStyle *paragraph = [NSMutableParagraphStyle new];
    paragraph.lineBreakMode = NSLineBreakByTruncatingMiddle;
    CGFloat x = em * 2;
    [payload[@"label"] drawInRect:CGRectMake(x, (size.height - font.lineHeight) / 2,
                                           MAX(0, size.width - x - em * 0.5), font.lineHeight)
        withAttributes:@{ NSFontAttributeName: font, NSForegroundColorAttributeName: foreground,
                          NSParagraphStyleAttributeName: paragraph }];
  }];
  [cache setObject:image forKey:key];
  return image;
}
