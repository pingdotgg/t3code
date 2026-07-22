---
name: add-dark-mode
description: Add dark mode with colors, shadows, and surfaces handled the way a designer would.
---

# Add Dark Mode

Use this when the user wants to add dark mode support to an existing UI.

## Activation

### Use For

- adding dark mode to a page, section, component, or site
- improving an existing dark mode treatment
- converting a light-mode-only UI to support dark mode

### Do Not Use For

- brand-new design or layout work
- standalone image dark-mode conversion
- responsive behavior, component organization, or general visual polish without dark mode

## Load First

- No companion files are required.
- Dark-mode design guidance is inline below.

## Progress Updates

Keep the user informed so longer runs do not look stuck.

- One-line status update before each major phase.
- Concrete and lightweight: what you are doing now, not verbose logs.

## Workflow

1. Inspect the existing UI and project Tailwind conventions.
2. Convert markup to include appropriate dark-mode classes.
3. Audit rasterized images for dark-mode variants.
4. For each rasterized image that needs a dark-mode variant, hand off to `dark-mode-image`, which MUST load and use the `imagegen` skill before creating or editing image assets.
5. Save generated dark-mode images alongside the originals and wire them into the dark-mode UI.

## Dark Mode Rules

### Design Rules

- Dark mode is about maintaining the same contrast ratios as light mode, not simply inverting colors
- Dark mode doesn't need to preserve every detail of the light mode design — it just needs to look good
- Default dark mode to follow the operating system's `prefers-color-scheme` setting (Tailwind's built-in `dark:` behavior); only add a manual toggle when the user explicitly asks for one
- Remove all shadows in dark mode — use `dark:shadow-none`
- On dark-mode-only sites, add the `scheme-only-dark` class to `<html>` or the top-level element — ensures native elements like scrollbars, form controls, and `color-scheme` render in dark mode

### Component Rules

- Never keep large branded/colored panels in dark mode; instead use the same background color and add a light divider between sections
- Style cards only slightly lighter than the page background (e.g. `dark:bg-gray-900` on a `dark:bg-gray-950` page); add a `dark:inset-ring dark:inset-ring-white/5` for definition
- Make decorative quote marks in testimonials very faint (e.g. `dark:text-white/5`)
- Never use multiple heading text colors in dark mode (e.g. dark gray + brand color); use a single light color like `white` or `gray-100` for all heading text

### Raster Image Rules

- When adding or improving dark mode, audit the page for rasterized images that need dark-mode versions: photos, screenshots, product mockups, decorative backgrounds, textures, and rasterized illustrations
- Never use CSS filters (`invert`, `brightness`, `contrast`, `opacity`) as the final dark-mode treatment for raster images; always create real dark-mode image files
- Generate dark-mode raster image variants with the `dark-mode-image` skill, which MUST load and use the `imagegen` skill before creating or editing any raster image assets

### SVG Rules

- For inline `<svg>` elements, style dark mode with Tailwind `dark:*` classes (e.g. `dark:fill-*`, `dark:stroke-*`, `dark:text-*`)
- For external SVG files referenced via `<img>`, always create a dark-mode version alongside the original (e.g. `logo.svg` and `logo-dark.svg`); never substitute CSS filters (`invert`, `brightness`) or opacity adjustments for a true dark variant

## Guardrails

- Do not generate, edit, or replace raster image assets directly from this skill; `dark-mode-image` owns that work and MUST use the `imagegen` skill.
- Require the `dark-mode-image` + `imagegen` handoff even when the image change seems simple, decorative, or incidental.

## Verify

- Check light and dark modes for contrast, missing variants, and images that still assume a light background.
