import React, { useCallback, useState } from "react";
import HalftoneCharacters from "./HalftoneCharacters";

interface EmptyStateProps {
  /** Called when the user clicks the "Create meeting" table. */
  onStart?: () => void;
}

interface TableRect {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * Home / empty screen: the three logo characters tumble across the space and a
 * dotted 3D "round table" sits in front of them, drawn in the same scene so it
 * shares the perspective and the centre character rolls up onto it. The table
 * is the call to action — clicking it creates a new meeting, exactly like the
 * sidebar's "New meeting".
 *
 * The table's visible label ("Create meeting") is rendered inside the 3D scene;
 * here we overlay a transparent, accessible button on its projected footprint
 * to handle the click. Holding the pointer lifts the label (press feedback).
 * If WebGL is unavailable, we fall back to a plain dotted DOM oval.
 */
const EmptyState: React.FC<EmptyStateProps> = ({ onStart }) => {
  const [rect, setRect] = useState<TableRect | null | undefined>(undefined);
  const [active, setActive] = useState(false);
  const handleTable = useCallback((r: TableRect | null) => setRect(r), []);

  // Lift the label whenever the pointer is over (or pressing) the table.
  const activeProps = {
    onPointerEnter: () => setActive(true),
    onPointerDown: () => setActive(true),
    onPointerLeave: () => setActive(false),
    onPointerUp: () => setActive(false),
    onPointerCancel: () => setActive(false),
  };

  return (
    <div className="relative flex items-center justify-center h-full overflow-hidden">
      <HalftoneCharacters
        className="pointer-events-none absolute inset-0"
        onTable={handleTable}
        pressed={active}
      />

      {rect ? (
        // 3D table drawn in the scene; this is just the click / a11y target.
        <button
          type="button"
          onClick={onStart}
          {...activeProps}
          aria-label="Create meeting"
          className="absolute z-10 cursor-pointer"
          style={{
            left: rect.cx - rect.rx,
            top: rect.cy - rect.ry,
            width: rect.rx * 2,
            height: rect.ry * 2,
          }}
        />
      ) : rect === null ? (
        // Fallback (no WebGL): a plain dotted oval with a visible label.
        <button
          type="button"
          onClick={onStart}
          aria-label="Create meeting"
          className="relative z-10 overflow-hidden rounded-[50%] border-2 border-on-surface-tertiary bg-surface px-20 py-10 text-on-surface-tertiary shadow-md transition-transform duration-150 hover:-translate-y-0.5 active:-translate-y-1"
          style={{
            backgroundImage:
              "radial-gradient(circle, currentColor 1.8px, transparent 2.1px)",
            backgroundSize: "7px 7px",
          }}
        >
          <span className="text-xl font-extrabold tracking-tight text-on-surface">
            Create meeting
          </span>
        </button>
      ) : null}
    </div>
  );
};

export default EmptyState;
