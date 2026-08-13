import { Text as NativeText, type TextStyle } from "react-native";
import type { CustomRenderers } from "react-native-nitro-markdown";

export interface AndroidSelectableMarkdownRendererStyles {
  readonly paragraph: TextStyle;
  readonly heading: (level: number) => TextStyle;
}

export function createAndroidSelectableMarkdownRenderers(
  styles: AndroidSelectableMarkdownRendererStyles,
): Pick<CustomRenderers, "heading" | "paragraph"> {
  return {
    paragraph: ({ node, Renderer }) => (
      <NativeText selectable style={styles.paragraph}>
        {node.children?.map((child, index) => (
          <Renderer
            key={`${child.type}:${child.beg ?? index}:${child.end ?? index}`}
            node={child}
            depth={1}
            inListItem={false}
            parentIsText
          />
        ))}
      </NativeText>
    ),
    heading: ({ node, Renderer, level = 1 }) => (
      <NativeText selectable style={styles.heading(level)}>
        {node.children?.map((child, index) => (
          <Renderer
            key={`${child.type}:${child.beg ?? index}:${child.end ?? index}`}
            node={child}
            depth={1}
            inListItem={false}
            parentIsText
          />
        ))}
      </NativeText>
    ),
  };
}
