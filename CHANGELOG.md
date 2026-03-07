# Changelog

## [Unreleased]

### Added
- **Theme selector**: Added theme toggle button in sidebar with three theme options:
  - **Light**: Light mode
  - **Dark**: Balanced dark mode with brighter backgrounds and more visible UI elements
  - **Night**: Darkest mode (previously the only dark mode)
  - **System**: Follow system preference

### Changed
- **apps/web/src/hooks/useTheme.ts**: Extended theme system to support `light`, `dark`, `night`, and `system` themes. Added `THEME_OPTIONS` export and `Theme` type export.
- **apps/web/src/index.css**: Added CSS variables for the new "dark" middle-ground theme and renamed existing dark theme to "night". The dark theme now uses brighter backgrounds (neutral-800/900 vs neutral-950) and more visible borders/accents.
- **apps/web/src/components/Sidebar.tsx**: Added theme selector menu with icon (Sun/Moon/MoonStar) in the sidebar header, available in both desktop and web modes.
- **apps/web/src/components/ChatView.tsx**: Made user messages more compact:
  - Reduced padding (px-3 py-2 instead of px-4 py-3)
  - Smaller text (13px instead of 14px)
  - Action buttons (copy, rollback) and timestamp moved below the message card
  - Actions only appear on hover for cleaner UI
