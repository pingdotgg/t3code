import "react-native";

declare module "react-native" {
  interface ViewProps {
    className?: string;
  }

  interface TextProps {
    className?: string;
  }

  interface TextInputProps {
    className?: string;
  }

  interface ScrollViewProps {
    className?: string;
  }

  interface PressableProps {
    className?: string;
  }

  interface ActivityIndicatorProps {
    className?: string;
  }
}
