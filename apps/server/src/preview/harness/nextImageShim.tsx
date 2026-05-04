import * as React from "react";

type ImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  src: string | { src: string };
  alt: string;
  fill?: boolean | null;
  priority?: boolean | null;
};

export default function Image(props: ImageProps) {
  const { src, alt, fill: _fill, priority: _priority, style, ...rest } = props;
  return (
    <img
      alt={alt}
      src={typeof src === "string" ? src : src.src}
      style={{
        maxWidth: "100%",
        height: "auto",
        ...style,
      }}
      {...rest}
    />
  );
}
