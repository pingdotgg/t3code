# Mobile navigation headers

The iOS Home and thread routes share the root native stack in
[`Stack.tsx`](../../apps/mobile/src/Stack.tsx). Keeping them in one navigation
controller lets UIKit animate the header between routes. The iPad sidebar owns
a separate, single-screen stack; Android uses its own in-flow headers.

On Liquid Glass iOS, Home keeps a transparent native title and renders its brand
as a custom leading item. A custom `headerTitle` previously shortened the scroll
fade and removed the blur behind the logo. Preserve the native title when
changing the brand or its connection-status replacement.

Both brand states use `BRAND_HEADER_ITEM_IDENTIFIER` from
[`CompactBrandTitle.tsx`](../../apps/mobile/src/components/CompactBrandTitle.tsx).
The native-stack and react-native-screens patches forward custom item identifiers
to `UIBarButtonItem.identifier`, just as they do for native buttons and menus.
UIKit otherwise matches transition items using their position and content, so
the brand needs an explicit identity separate from navigation controls. Connection
status changes retain that identity. See [Apple's identifier documentation](https://developer.apple.com/documentation/uikit/uibarbuttonitem/identifier).

The react-native-screens patch caches leading, trailing, and center item groups
independently. A button can belong to only one group: constructing another group
with the same button removes it from the previous one. Unrelated menu updates
must therefore preserve the other groups while UIKit may be animating them.
Each cache includes the owning header config, its item values, and custom native
item identities, so changed content or remounted event emitters still rebuild.

Custom header identifiers require native code generation and a new mobile build;
an over-the-air JavaScript update alone is insufficient. The Android view manager
implements the generated identifier setter as a no-op because this behavior is
specific to iOS 26 and later.
