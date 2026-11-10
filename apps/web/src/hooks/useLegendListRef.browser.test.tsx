import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { createRef, useState, type RefObject } from "react";
import { expect, it } from "vite-plus/test";
import { act, render } from "../../test/render";
import { useLegendListRef } from "./useLegendListRef";

function ListProbe({
  items,
  listRef,
}: {
  items: string[];
  listRef: RefObject<LegendListRef | null>;
}) {
  const [edges, setEdges] = useState("");
  const ref = useLegendListRef(listRef, () => {
    const state = listRef.current?.getState();
    if (state) setEdges(`${state.isAtStart}:${state.isAtEnd}`);
  });
  return (
    <>
      <output aria-label="List edges">{edges}</output>
      <LegendList
        ref={ref}
        data={items}
        keyExtractor={(item) => item}
        renderItem={({ item }) => <div style={{ height: 40 }}>{item}</div>}
        style={{ height: 120, width: 300 }}
      />
    </>
  );
}

it("refreshes list edges after content shrinks without scrolling and after the list reopens", async () => {
  const listRef = createRef<LegendListRef | null>();
  const items = Array.from({ length: 20 }, (_, index) => `Row ${index}`);
  await using screen = await render(<ListProbe items={items} listRef={listRef} />);
  await expect.element(screen.getByLabelText("List edges")).toHaveTextContent("true:false");
  await act(() => {
    void listRef.current!.scrollToEnd({ animated: false });
  });
  await expect.element(screen.getByLabelText("List edges")).toHaveTextContent("false:true");
  await screen.rerender(<ListProbe items={["Only row"]} listRef={listRef} />);
  await expect.element(screen.getByLabelText("List edges")).toHaveTextContent("true:true");
  await screen.rerender(<></>);
  expect(listRef.current).toBeNull();
  await screen.rerender(<ListProbe items={items} listRef={listRef} />);
  await expect.element(screen.getByLabelText("List edges")).toHaveTextContent("true:false");
});
