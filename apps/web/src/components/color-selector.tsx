"use client";

import { useState } from "react";
import { cn } from "~/lib/utils";

interface ColorSelectorProps {
  colors: string[];
  size?: "default" | "sm" | "lg";
  defaultValue: string;
  name?: string;
  onColorSelect?: (color: string) => void;
  className?: string;
}

const colorMap = {
  default: "var(--foreground)",
  red: "var(--color-red-500)",
  green: "var(--color-green-500)",
  blue: "var(--color-blue-500)",
  yellow: "var(--color-yellow-500)",
  purple: "var(--color-purple-500)",
  pink: "var(--color-pink-500)",
  indigo: "var(--color-indigo-500)",
  orange: "var(--color-orange-500)",
  teal: "var(--color-teal-500)",
  cyan: "var(--color-cyan-500)",
  lime: "var(--color-lime-500)",
  emerald: "var(--color-emerald-500)",
  violet: "var(--color-violet-500)",
  fuchsia: "var(--color-fuchsia-500)",
  rose: "var(--color-rose-500)",
  sky: "var(--color-sky-500)",
  amber: "var(--color-amber-500)",
} as const;

function getSizeClass(size: "default" | "sm" | "lg") {
  switch (size) {
    case "sm":
      return "size-4";
    case "default":
      return "size-5";
    case "lg":
      return "size-6";
    default:
      return "size-5";
  }
}

function getColorValue(color: string): string {
  return colorMap[color as keyof typeof colorMap] || color;
}

export function ColorSelector({
  colors,
  size = "default",
  defaultValue,
  name,
  onColorSelect,
  className,
}: ColorSelectorProps) {
  const [selectedColor, setSelectedColor] = useState<string>(defaultValue);

  const handleColorSelect = (color: string) => {
    setSelectedColor(color);
    onColorSelect?.(color);
  };

  const sizeClass = getSizeClass(size);

  return (
    <div className={cn("flex gap-2", className)}>
      {name && <input type="hidden" name={name} value={selectedColor} />}
      {colors.map((color) => {
        const colorValue = getColorValue(color);
        return (
          <div
            key={color}
            className={`${sizeClass} cursor-pointer rounded-full transition-transform duration-200 active:scale-90`}
            style={{
              backgroundColor: colorValue,
              ...(selectedColor === color && {
                boxShadow: `inset 0 0 0 2px var(--card), 0 0 0 2px ${colorValue}`,
              }),
            }}
            onClick={() => handleColorSelect(color)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleColorSelect(color);
              }
            }}
            tabIndex={0}
            role="button"
            aria-label={`Select ${color} color`}
            aria-pressed={selectedColor === color}
          />
        );
      })}
    </div>
  );
}
