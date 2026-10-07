#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

// Hebrew through Arabic Extended-A, the Hebrew and Arabic presentation forms, and the
// supplementary-plane right-to-left scripts. Kept in step with `src/textDirection.ts`.
static inline BOOL T3MarkdownTextIsRightToLeftCharacter(UTF32Char character)
{
  return (character >= 0x0590 && character <= 0x08FF) ||
      (character >= 0xFB1D && character <= 0xFDFF) ||
      (character >= 0xFE70 && character <= 0xFEFF) ||
      (character >= 0x10800 && character <= 0x10FFF) ||
      (character >= 0x1E800 && character <= 0x1EFFF);
}

/// The direction of the first letter in `range`, the way HTML's `dir="auto"` picks it, or
/// natural when the range has no letters.
static inline NSWritingDirection T3MarkdownTextContentDirection(NSString *string, NSRange range)
{
  NSCharacterSet *letters = NSCharacterSet.letterCharacterSet;
  const NSUInteger end = NSMaxRange(range);
  for (NSUInteger index = range.location; index < end; index++) {
    UTF32Char character = [string characterAtIndex:index];
    if (CFStringIsSurrogateHighCharacter(character) && index + 1 < end) {
      const unichar low = [string characterAtIndex:index + 1];
      if (CFStringIsSurrogateLowCharacter(low)) {
        character = CFStringGetLongCharacterForSurrogatePair((unichar)character, low);
        index++;
      }
    }
    if ([letters longCharacterIsMember:character]) {
      return T3MarkdownTextIsRightToLeftCharacter(character) ? NSWritingDirectionRightToLeft
                                                             : NSWritingDirectionLeftToRight;
    }
  }
  return NSWritingDirectionNatural;
}

/// Lays out each paragraph in its own script's direction, the way HTML's `dir="auto"`
/// does. React Native resolves natural alignment to the app's side (left in an English
/// app) before this runs, so without it an Arabic paragraph sits on the left. Paragraphs
/// that already carry a writing direction (an explicit `textAlign: "left"`, as code uses) and
/// explicit center, justified, or opposite-side alignment are left alone.
static inline void T3MarkdownTextApplyContentDirection(NSMutableAttributedString *attributedString)
{
  NSString *string = attributedString.string;
  const BOOL naturalIsLeftToRight =
      [NSParagraphStyle defaultWritingDirectionForLanguage:nil] == NSWritingDirectionLeftToRight;
  const NSTextAlignment appSideAlignment =
      naturalIsLeftToRight ? NSTextAlignmentLeft : NSTextAlignmentRight;
  [string enumerateSubstringsInRange:NSMakeRange(0, string.length)
                             options:NSStringEnumerationByParagraphs |
                                     NSStringEnumerationSubstringNotRequired
                          usingBlock:^(NSString *substring, NSRange paragraphRange, NSRange enclosingRange, BOOL *stop) {
    if (enclosingRange.length == 0) {
      return;
    }
    const NSParagraphStyle *leadingStyle =
        [attributedString attribute:NSParagraphStyleAttributeName
                            atIndex:enclosingRange.location
                     effectiveRange:nil];
    const NSTextAlignment alignment = leadingStyle ? leadingStyle.alignment : NSTextAlignmentNatural;
    if ((alignment != NSTextAlignmentNatural && alignment != appSideAlignment) ||
        (leadingStyle && leadingStyle.baseWritingDirection != NSWritingDirectionNatural)) {
      return;
    }
    const NSWritingDirection direction = T3MarkdownTextContentDirection(string, paragraphRange);
    // Text that already reads in the app's direction keeps its style untouched.
    if (direction == NSWritingDirectionNatural ||
        (direction == NSWritingDirectionLeftToRight && naturalIsLeftToRight) ||
        (direction == NSWritingDirectionRightToLeft && !naturalIsLeftToRight)) {
      return;
    }

    [attributedString enumerateAttribute:NSParagraphStyleAttributeName
                                 inRange:enclosingRange
                                 options:0
                              usingBlock:^(id value, NSRange range, BOOL *stop) {
      NSParagraphStyle *existingStyle = value;
      const NSTextAlignment target = direction == NSWritingDirectionRightToLeft
          ? NSTextAlignmentRight
          : NSTextAlignmentLeft;
      if (existingStyle.baseWritingDirection == direction && existingStyle.alignment == target) {
        return;
      }
      NSMutableParagraphStyle *paragraphStyle =
          existingStyle ? [existingStyle mutableCopy] : [NSMutableParagraphStyle new];
      paragraphStyle.baseWritingDirection = direction;
      // Natural alignment resolves from the app's language, not the base writing
      // direction, so pin it to the paragraph's own leading edge.
      paragraphStyle.alignment = direction == NSWritingDirectionRightToLeft
          ? NSTextAlignmentRight
          : NSTextAlignmentLeft;
      if (direction == NSWritingDirectionRightToLeft) {
        // A left tab stop in a right-to-left paragraph pins list text to the marker; a
        // natural one measures from the leading (right) edge like the indents do.
        NSMutableArray<NSTextTab *> *tabStops = [NSMutableArray array];
        for (NSTextTab *tab in paragraphStyle.tabStops) {
          [tabStops addObject:[[NSTextTab alloc] initWithTextAlignment:NSTextAlignmentNatural
                                                              location:tab.location
                                                               options:tab.options]];
        }
        paragraphStyle.tabStops = tabStops;
      }
      [attributedString addAttribute:NSParagraphStyleAttributeName
                               value:paragraphStyle
                               range:range];
    }];
  }];
}
