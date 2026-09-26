# Voice controls

Voice can operate the buttons of your attached T3 window itself: you ask, T3 lists the
interface's activatable controls, and clicks the one you mean. This works for regular buttons,
links, tabs, checkboxes, radios and switches, and for the items of open menus and dialogs. It is
useful for anything the conversation commands do not already cover, such as pressing a toolbar
button, confirming a dialog, or toggling a setting.

## What is supported

- **Activatable controls with a supported role:** button, link, menu item, tab, switch, checkbox,
  radio, and dropdown option. Items inside an open menu or dialog are listed like any other
  control.
- **Disabled controls** are always listed and marked as disabled. Asking to click one reports
  that it is disabled instead of pretending to press it.
- **Hidden controls** (inside a closed menu or an invisible section) are excluded unless you ask
  for them ("include hidden controls"). Clicking a hidden control reports that it is not visible;
  open its menu or dialog first, then click the item.
- **Duplicate names** are listed with a number and the visible text of the container they sit in
  (for a row action, the row's title), for example two buttons named "Settle thread" under
  different thread titles. That context is so you can say which one; the click itself always
  presses the exact element that was listed.
- **Stale targets are rejected, never retargeted.** If a control disappears between listing and
  clicking, voice reports it as gone and lists again. A surviving control with the same name is
  never pressed by the old one's id, so removing one of two identical buttons can never make a
  repeat click hit the wrong one. The same applies when a listed control's label or surrounding
  content changes before the click: voice refuses and lists again instead of pressing something
  you did not choose.

Controls without a supported role (plain text or images that only look clickable) are not
reachable. If a button you want is missing from the list, it is either not visible yet or does not
expose a supported role.

## How to use it

Ask in plain language: "Click the Archive button", "Open the model menu", "Press Submit". Voice
lists the current controls when it needs to, picks the one you named, and presses it with a real
click. A click only counts as done when the control was actually visible, enabled, and pressed;
every other outcome is reported to you as one.

## Honesty rules

Voice never claims a click succeeded without a real press on a real control. Disabled, hidden,
missing, and ambiguous targets are reported as what they are, and confirmation dialogs appear as
normal: voice lists the dialog's buttons and presses the one you confirm with.
