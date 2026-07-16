import React, { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertTriangle, MoreVertical } from "lucide-react";
import type { Avatar, ParticipantIn } from "../types";
import CharacterAvatar from "./CharacterAvatar";
import { humanDisplayLabel, normalizeHumanName } from "../utils/human";

export const YOU_ID = "__YOU__";

// Cards are keyed by the participant's server-assigned id (names may repeat).
const keyOf = (p: any) => p?.id ?? p?.name;

const CARD_WIDTH = 200;
const HUMAN_CARD_CLASS =
  "border border-outline-secondary rounded-lg p-4 bg-accent-soft relative group flex-shrink-0";

// Circled order number (①②③…) shown in the card's top-left corner.
const orderGlyph = (n: number) =>
  n >= 1 && n <= 20 ? String.fromCharCode(0x245f + n) : `(${n})`;

// Drop the provider prefix from a model id ("openai/gpt-5-mini" → "gpt-5-mini").
const shortModel = (m?: string) => {
  const s = m ?? "";
  const i = s.indexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
};

function OrderBadge({ index }: { index: number }) {
  return (
    <span className="pointer-events-none absolute left-1.5 top-1 select-none text-base leading-none text-on-surface-tertiary">
      {orderGlyph(index)}
    </span>
  );
}
const PARTICIPANT_CARD_CLASS =
  "border border-outline rounded-lg p-4 hover:border-outline-secondary transition-colors bg-surface relative group flex-shrink-0";
const DRAFT_CARD_CLASS =
  "border border-amber-300 rounded-lg p-4 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 hover:border-amber-400 dark:hover:border-amber-600 transition-colors relative group flex-shrink-0";

interface DnDParticipantsProps {
  order: string[];
  participants: any[];
  includeHuman: boolean;
  humanName?: string;
  humanAvatar?: Avatar | null;
  humanRole?: string;
  /** Opens the "..." menu (Edit / Delete) for the human card. */
  onHumanMenuOpen?: (rect: DOMRect) => void;
  apiBase: string;
  meetingId: string;
  onOrderChange: (newOrder: string[]) => void;
  onParticipantMenuOpen?: (participantId: string, rect: DOMRect) => void;
  /** Opens a read-only detail view; cards become clickable while locked. */
  onParticipantView?: (participantId: string) => void;
  locked?: boolean;
}

export default function DnDParticipants({
  order,
  participants,
  includeHuman,
  humanName,
  humanAvatar,
  humanRole,
  onHumanMenuOpen,
  apiBase,
  meetingId,
  onOrderChange,
  onParticipantMenuOpen,
  onParticipantView,
  locked = false,
}: DnDParticipantsProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const activeParticipant = useMemo(() => {
    if (!activeId || activeId === YOU_ID) return null;
    return participants.find((pp) => keyOf(pp) === activeId) ?? null;
  }, [activeId, participants]);

  const onDragStart = useCallback((event: DragStartEvent) => {
    if (locked) return;
    setActiveId(String(event.active.id));
  }, [locked]);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (locked) {
        setActiveId(null);
        return;
      }
      setActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = order.indexOf(String(active.id));
      const newIndex = order.indexOf(String(over.id));
      const newOrder = arrayMove(order, oldIndex, newIndex);

      onOrderChange(newOrder);

      fetch(`${apiBase}/meetings/${meetingId}/order`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: newOrder }),
      }).catch(() => {});
    },
    [locked, order, apiBase, meetingId, onOrderChange]
  );

  const onDragCancel = useCallback(() => setActiveId(null), []);

  return (
    <div>
      <DndContext
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <SortableContext items={order} strategy={horizontalListSortingStrategy}>
          <div className="inline-flex gap-3 py-1">
            {order.map((id, i) => (
              <SortableCard
                key={id}
                id={id}
                orderIndex={i + 1}
                includeHuman={includeHuman}
                humanName={humanName}
                humanAvatar={humanAvatar}
                humanRole={humanRole}
                onHumanMenuOpen={onHumanMenuOpen}
                participants={participants}
                onParticipantMenuOpen={onParticipantMenuOpen}
                onParticipantView={onParticipantView}
                locked={locked}
              />
            ))}
          </div>
        </SortableContext>
        {!locked ? (
          <DragOverlay
            dropAnimation={{
              duration: 180,
              easing: "cubic-bezier(0.22, 1, 0.36, 1)",
              dragSourceOpacity: 0.4,
            }}
          >
            {activeId ? (
              <OverlayCard
                id={activeId}
                orderIndex={order.indexOf(activeId) + 1}
                includeHuman={includeHuman}
                humanName={humanName}
                humanAvatar={humanAvatar}
                humanRole={humanRole}
                participant={activeParticipant}
              />
            ) : null}
          </DragOverlay>
        ) : null}
      </DndContext>
    </div>
  );
}

// --- 個々のカード ---
function SortableCard({
  id,
  orderIndex,
  includeHuman,
  humanName,
  humanAvatar,
  humanRole,
  onHumanMenuOpen,
  participants,
  onParticipantMenuOpen,
  onParticipantView,
  locked,
}: {
  id: string;
  orderIndex: number;
  includeHuman: boolean;
  humanName?: string;
  humanAvatar?: Avatar | null;
  humanRole?: string;
  onHumanMenuOpen?: (rect: DOMRect) => void;
  participants: any[];
  onParticipantMenuOpen?: (participantId: string, rect: DOMRect) => void;
  onParticipantView?: (participantId: string) => void;
  locked?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: locked });
  const isHuman = id === YOU_ID && includeHuman;
  const participant = !isHuman ? participants.find((pp) => keyOf(pp) === id) : null;

  if (!isHuman && !participant) return null;

  // Incomplete participants (saved with the meeting) render as amber draft cards.
  const isDraft = !!participant?.incomplete;

  const menuId = participant ? keyOf(participant) : undefined;
  // While locked, cards open a read-only detail view on click.
  const viewable = Boolean(locked && !isHuman && menuId && onParticipantView);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0 : 1,
    cursor: locked ? (viewable ? "pointer" : "default") : isDragging ? "grabbing" : "grab",
    width: CARD_WIDTH,
    willChange: "transform",
    touchAction: "none",
  };

  const cardClass = isHuman ? HUMAN_CARD_CLASS : isDraft ? DRAFT_CARD_CLASS : PARTICIPANT_CARD_CLASS;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(locked ? {} : listeners)}
      // While viewable, the sortable is disabled but the card itself acts as
      // a button — drop dnd-kit's aria-disabled so it reads as interactive.
      {...(viewable
        ? { role: "button", "aria-disabled": undefined, tabIndex: 0, title: "View details" }
        : {})}
      onClick={viewable ? () => onParticipantView!(menuId!) : undefined}
      onKeyDown={
        viewable
          ? (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onParticipantView!(menuId!);
              }
            }
          : undefined
      }
      className={cardClass}
    >
      <OrderBadge index={orderIndex} />
      {!locked && !isHuman && menuId && onParticipantMenuOpen ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onParticipantMenuOpen(menuId, rect);
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => event.stopPropagation()}
          className={`absolute top-2 right-2 rounded-md p-1 transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 ${
            isDraft
              ? "text-amber-500 hover:text-amber-700 hover:bg-amber-100 focus:ring-amber-400"
              : "text-on-surface-tertiary hover:text-accent hover:bg-accent-soft focus:ring-accent"
          }`}
          aria-label="Participant options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      ) : null}
      {!locked && isHuman && onHumanMenuOpen ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onHumanMenuOpen(rect);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          className="absolute top-2 right-2 rounded-md p-1 transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 text-on-surface-tertiary hover:text-accent hover:bg-accent-soft focus:ring-accent"
          aria-label="Your options"
        >
          <MoreVertical className="w-4 h-4" />
        </button>
      ) : null}
      {isDraft ? (
        <DraftCardContent participant={participant} />
      ) : (
        <CardContent
          isHuman={isHuman}
          humanName={humanName}
          humanAvatar={humanAvatar}
          humanRole={humanRole}
          participant={participant}
        />
      )}
    </div>
  );
}

function OverlayCard({
  id,
  orderIndex,
  includeHuman,
  humanName,
  humanAvatar,
  humanRole,
  participant,
}: {
  id: string;
  orderIndex: number;
  includeHuman: boolean;
  humanName?: string;
  humanAvatar?: Avatar | null;
  humanRole?: string;
  participant: any | null;
}) {
  const isHuman = id === YOU_ID && includeHuman;
  if (!isHuman && !participant) return null;
  const isDraft = !!participant?.incomplete;

  const cardClass = isHuman ? HUMAN_CARD_CLASS : isDraft ? DRAFT_CARD_CLASS : PARTICIPANT_CARD_CLASS;

  return (
    <div
      className={cardClass}
      style={{
        width: CARD_WIDTH,
        cursor: "grabbing",
        boxShadow: isDraft
          ? "0 24px 48px -28px rgba(217, 119, 6, 0.7)"
          : "0 24px 48px -28px rgba(16, 185, 129, 0.7)",
        transform: "scale(1.02)",
        opacity: 1,
        pointerEvents: "none",
      }}
    >
      <OrderBadge index={orderIndex} />
      {isDraft ? (
        <DraftCardContent participant={participant} />
      ) : (
        <CardContent
          isHuman={isHuman}
          humanName={humanName}
          humanAvatar={humanAvatar}
          humanRole={humanRole}
          participant={participant}
        />
      )}
    </div>
  );
}

function CardContent({
  isHuman,
  humanName,
  humanAvatar,
  humanRole,
  participant,
}: {
  isHuman: boolean;
  humanName?: string;
  humanAvatar?: Avatar | null;
  humanRole?: string;
  participant: any | null;
}) {
  if (isHuman) {
    const name = normalizeHumanName(humanName);
    return (
      <div className="flex items-start gap-3">
        <CharacterAvatar
          avatar={humanAvatar}
          name={name}
          size={40}
          className="flex-shrink-0"
        />
        <div className="min-w-0">
          <div className="font-semibold text-on-surface truncate">
            {humanDisplayLabel(humanName)}
          </div>
          <div className="text-sm text-on-surface-tertiary mt-1 truncate capitalize">
            {humanRole || "attendee"}
          </div>
          <div className="text-xs text-on-surface-tertiary mt-1 truncate">Human</div>
        </div>
      </div>
    );
  }

  if (!participant) return null;

  return (
    <div className="flex items-start gap-3">
      <CharacterAvatar
        avatar={participant.avatar}
        name={participant.name}
        size={40}
        className="flex-shrink-0"
      />
      <div className="min-w-0">
        <div className="font-semibold text-on-surface truncate">{participant.name}</div>
        <div className="text-sm text-on-surface-tertiary mt-1 truncate capitalize">
          {participant.role}
        </div>
        <div className="text-xs text-on-surface-tertiary mt-1 truncate">
          {shortModel(participant.model_name)}
        </div>
      </div>
    </div>
  );
}

function DraftCardContent({ participant }: { participant: ParticipantIn }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex flex-col items-center self-stretch flex-shrink-0">
        <CharacterAvatar avatar={participant.avatar} name={participant.name} size={40} />
        <div className="flex flex-1 flex-col items-center justify-center gap-0.5">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-[10px] font-medium leading-none text-amber-500">incomplete</span>
        </div>
      </div>
      <div className="min-w-0">
        {participant.name.trim() ? (
          <div className="font-semibold text-on-surface truncate">{participant.name}</div>
        ) : (
          <div className="font-semibold text-amber-500 italic text-sm">No name</div>
        )}
        <div className="text-sm text-on-surface-tertiary mt-1 truncate capitalize">
          {participant.role}
        </div>
        <div className="text-xs text-on-surface-tertiary mt-1 truncate">
          {shortModel(participant.model_name)}
        </div>
      </div>
    </div>
  );
}
