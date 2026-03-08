# Add Browser View Panel for Thread Preview
## Problem
You want to preview localhost in a browser view while working on threads in t3code, so you can see live project output alongside your conversation.
## Current State
T3 Code has a sidebar layout with:
* Left: Thread sidebar
* Center: ChatView (messages, input, terminal)
* Right: DiffPanel (toggleable, file changes view)
The layout uses React Router with `/_chat/$threadId` route that conditionally renders DiffPanel inline or as a sheet based on screen size.
## Proposed Changes
### 1. Create BrowserPanel Component
* New file: `apps/web/src/components/BrowserPanel.tsx`
* Simple iframe-based component that loads a configurable URL (default: `http://localhost:3000`)
* Props: `mode` ("sidebar" | "sheet"), `url`, `onUrlChange`
* Basic styling: full height/width with border
* Input field for URL customization
### 2. Add Browser Toggle to Route
* Modify `apps/web/src/routes/_chat.$threadId.tsx`:
    * Add `browser` search param (like `diff="1"`)
    * Create `BrowserPanelInlineSidebar` (mirrors DiffPanelInlineSidebar)
    * Create `BrowserPanelSheet` (mirrors DiffPanelSheet)
    * Render both DiffPanel and BrowserPanel when appropriate
* Store browser URL preference in localStorage
### 3. Add Browser Toggle Button to ChatHeader
* Modify `apps/web/src/components/ChatView.tsx`:
    * Add browser toggle button in ChatHeader (next to diff toggle)
    * Pass `browserOpen` state and handler
    * Add keybinding for browser toggle (optional)
### 4. Layout Adjustments
* On wide screens: DiffPanel (right) + BrowserPanel (far right) both visible
* On medium screens: Toggle between DiffPanel or BrowserPanel as sheet
* On small screens: Single sheet modal
## Implementation Details
### BrowserPanel Props
```typescript
interface BrowserPanelProps {
  mode: "sidebar" | "sheet";
  url?: string;
  onUrlChange?: (url: string) => void;
}
```
### Search Params
Add to route search: `browser="1"` and optional `browserUrl="http://localhost:..."` 
### Storage
* Browser URL: localStorage key `chat_browser_url` (default: `http://localhost:3000`)
* Browser sidebar width: `chat_browser_sidebar_width` (mirrors diff logic)
## Success Criteria
* Browser view toggles on/off from ChatHeader
* URL is customizable and persists
* Renders alongside DiffPanel on wide screens
* Works as sheet on mobile
* No performance regression
* Follows existing code patterns (mirrors DiffPanel implementation)
