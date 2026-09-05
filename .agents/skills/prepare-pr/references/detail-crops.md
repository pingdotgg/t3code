# Detail crops for screenshots and GIFs

Use ImageMagick 7 (`magick`) through the existing entry point:

```sh
MEDIA=.agents/skills/prepare-pr/scripts/prepare_proof_media.py
python3 "$MEDIA" detail after.png --before before.png \
  --region 0.10,0.25,0.55,0.20 \
  --reason "Show the changed row label and its neighboring rows" \
  --output-dir evidence --stem row-label
```

`--region` is normalized `x,y,width,height` in the fully displayed, oriented
source canvas. Repeat it for the trigger, destination, surrounding label, or
caption that must remain visible. The renderer takes their union and adds
context padding, with a minimum 320×180 crop where the source permits. Regions
override automatic detection so an unrelated clock or cursor cannot choose the
framing. `--padding` adjusts context; `--max-width` defaults to 960 pixels and
only downsizes. A full-image region (`0,0,1,1`) retains the overview.

For a matching before/after pair without regions, the helper suggests a crop
from pixel differences above `--difference-threshold` (default 5%). It requires
matching oriented canvas sizes and applies exactly the same rectangle and
scale to both. Inspect both sources first: matching dimensions alone do not
prove that the viewport, scroll position, or content is aligned.

For an existing GIF:

```sh
python3 "$MEDIA" detail interaction.gif \
  --region 0.08,0.30,0.70,0.35 \
  --reason "Keep the dragged row, full path, and final ordering visible" \
  --output-dir evidence --stem reorder
```

Without regions, every fully composed frame is compared against the initial
frame and all detected changes contribute to one stable crop. With `--before`,
the baseline's first frame anchors detection across both inputs. The renderer
preserves frame count, delays, and GIF looping. It performs no temporal trim.
An unchanged pair or static single image stays full-frame unless semantic
regions are supplied; it never guesses a subject from empty difference data.
Difference detection flattens transparency onto white, so explicitly select
regions when transparency or dark-background rendering is the claim.

Outputs are `<stem>-after-detail.png|gif`, optional
`<stem>-before-detail.png|gif`, and `<stem>-detail-receipt.json`. Sources remain
untouched. Existing outputs require `--overwrite`; publication happens only
after both crops and their metadata pass validation.

These are detail derivatives; retain the raw captures as context and provenance.
For an annotated source, include its explanatory caption in the region set.
Coordinates in an existing timeline still belong to the original canvas: measure
annotation coordinates again if you crop before annotating.
Annotate first, then crop while retaining the annotations, or author a new
timeline measured on the cropped canvas. Keep before and after images separate
and labeled; do not use a composite that makes either state too small to read.
