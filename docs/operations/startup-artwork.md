# Hyakki startup artwork

The desktop intro uses Ryoku Ember's Aka Oni plate. Source: Ryoku Site at `36a1450`, `account/public/ember/spirits/aka-oni/` and `account/app/lib/ember/plate.ts`. The packaged animation and still are prerendered from the short arrival timeline. The launcher does not need WebGL or a connection to the site.

The dithered watermark comes from `public/logos/mark.svg` in the same checkout. Geologica comes from `app/assets/fonts/` and ships with its OFL notice. Packaged artwork lives in `apps/desktop/resources/startup/`.

The splash plays the intro once and holds for 1.2 seconds after the main window is ready if the splash is visible. Database progress updates use the settled plate. Reduced motion uses the still from the start.
