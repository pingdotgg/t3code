import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { Fragment, type ReactNode } from "react";
import { View } from "react-native";

export function VersionControlList<T>({
  items,
  getKey,
  renderItem,
}: {
  readonly items: readonly T[];
  readonly getKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
}) {
  if (items.length <= 40)
    return items.map((item) => <Fragment key={getKey(item)}>{renderItem(item)}</Fragment>);
  return (
    <View style={{ height: 420 }}>
      <LegendList<T>
        data={items}
        extraData={renderItem}
        keyExtractor={getKey}
        renderItem={({ item }: LegendListRenderItemProps<T>) => renderItem(item)}
        estimatedItemSize={56}
        drawDistance={180}
        nestedScrollEnabled
        recycleItems={false}
        maintainVisibleContentPosition
      />
    </View>
  );
}
