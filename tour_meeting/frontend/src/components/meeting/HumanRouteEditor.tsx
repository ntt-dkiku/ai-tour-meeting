import React from "react";
import { Plus, Trash2, Sparkles, Clock3, GripVertical, X, ChevronDown, RotateCcw } from "lucide-react";
import {
  DndContext,
  closestCenter,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  arrayMove,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import ChatComposer from "./ChatComposer";
import type { ModelOptionGroup } from "../../constants";

// One editable destination. Mirrors the backend Destination schema (plus a
// client-only `id` used as a stable drag key; the backend ignores it).
export interface EditableDestination {
  id: string;
  name: string;
  description: string;
  transport_mode: string;
  transport_cost: string;
  travel_time_from_previous: string;
  start_time: string;
  stay_duration: string;
  cost: string;
}

let _destSeq = 0;
const newDestId = () => `dest-${_destSeq++}`;

// Template of the schema fields (no id); addStop stamps a fresh id.
export const EMPTY_DESTINATION: Omit<EditableDestination, "id"> = {
  name: "",
  description: "",
  transport_mode: "",
  transport_cost: "",
  travel_time_from_previous: "",
  start_time: "",
  stay_duration: "",
  cost: "",
};

// Normalize any destination-shaped object (an accepted route's stop, or an
// AI-generated one) into a fully-populated EditableDestination with a fresh id.
export const toEditableDestination = (
  d: Partial<EditableDestination> | Record<string, unknown> | null | undefined
): EditableDestination => {
  const get = (k: keyof Omit<EditableDestination, "id">) => {
    const v = (d as Record<string, unknown> | null | undefined)?.[k];
    return typeof v === "string" ? v : v == null ? "" : String(v);
  };
  return {
    id: newDestId(),
    name: get("name"),
    description: get("description"),
    transport_mode: get("transport_mode"),
    transport_cost: get("transport_cost"),
    travel_time_from_previous: get("travel_time_from_previous"),
    start_time: get("start_time"),
    stay_duration: get("stay_duration"),
    cost: get("cost"),
  };
};

// Parse a "HH:MM" clock into minutes-since-midnight, or null if unparseable.
const parseClock = (s: string): number | null => {
  const m = (s || "").match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 47 || min > 59) return null;
  return h * 60 + min;
};

// Parse a duration ("60 min", "1 h", "90") into minutes, or null.
const parseMins = (s: string): number | null => {
  const m = (s || "").match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return /h(?:our|r)?|時間/i.test(s || "") ? n * 60 : n;
};

const minutesToClock = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// Parse a cost string into [currencySymbol, amount] (mirrors the backend).
const parseCostAmount = (text: string): [string, number] | null => {
  if (!text) return null;
  const num = text.match(/([-+]?\d[\d,.]*)/);
  if (!num) return null;
  const amount = parseFloat(num[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const sym = text.match(/([$¥€£₩₹₫₪฿])\s*\d/);
  if (sym) return [sym[1], amount];
  if (/\d\s*円/.test(text)) return ["¥", amount];
  return ["", amount];
};

// Sum cost strings per currency, e.g. "¥2,300" or "$20 + ¥1,500".
const formatCostTotals = (texts: string[]): string | null => {
  const totals = new Map<string, number>();
  for (const t of texts) {
    const parsed = parseCostAmount(t);
    if (!parsed) continue;
    totals.set(parsed[0], (totals.get(parsed[0]) ?? 0) + parsed[1]);
  }
  const parts: string[] = [];
  for (const [sym, amt] of totals) {
    if (amt) parts.push(`${sym}${Math.trunc(amt).toLocaleString("en-US")}`);
  }
  return parts.length ? parts.join(" + ") : null;
};

// Time window / total cost across the whole route, mirroring the backend's
// compute_route_summary so the editor's summary matches an LLM proposal's.
const computeSummary = (route: EditableDestination[]): { timeWindow: string | null; totalCost: string | null } => {
  let firstRaw: string | null = null;
  let lastRaw: string | null = null;
  for (const d of route) {
    const st = (d.start_time || "").trim();
    if (st) {
      if (firstRaw === null) firstRaw = st;
      lastRaw = st;
    }
  }
  let timeWindow: string | null = null;
  if (firstRaw) {
    const lastMins = lastRaw ? parseClock(lastRaw) : null;
    const lastStay = route.length ? parseMins(route[route.length - 1].stay_duration) : null;
    if (lastMins != null && lastStay) {
      timeWindow = `${firstRaw} - ${minutesToClock(lastMins + lastStay)}`;
    } else if (lastRaw) {
      timeWindow = `${firstRaw} - ${lastRaw}`;
    }
  }
  const totalCost = formatCostTotals(route.flatMap((d) => [d.cost, d.transport_cost]));
  return { timeWindow, totalCost };
};

interface HumanRouteEditorProps {
  route: EditableDestination[];
  setRoute: (route: EditableDestination[]) => void;
  /** Generate/refine a route from a description + the current route (used by
   *  the interactive AI dialog). Returns `{ message, route }`. */
  generateHumanRoute: (
    description: string,
    route: any[],
    model?: string,
    history?: { role: string; content: string }[]
  ) => Promise<any>;
  canGenerate: boolean;
  /** Selectable models for the AI dialog's model picker (same groups as the
   *  participant "Model" dropdown). */
  modelGroups: ModelOptionGroup[];
  /** Model preselected in the AI dialog's model picker. */
  defaultModel: string;
}

// Inputs read like the RoutePlanView card text but reveal an editable frame on
// hover/focus, so the editor looks like the chat's route display.
const CELL =
  "bg-transparent rounded-md border border-transparent px-1 hover:border-outline focus:border-accent focus:outline-none";

// A textarea that wraps within the card width and grows to fit its content
// (used for the description, so long notes wrap like the chat's route card
// instead of overflowing to the right).
const GrowingTextarea: React.FC<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className: string;
}> = ({ value, onChange, placeholder, className }) => {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  // Layout effect (not effect) so the textarea is sized before the parent's
  // section-height sync measures it.
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`resize-none overflow-hidden ${className}`}
    />
  );
};

// The editable, drag-sortable route: summary cards + the horizontal card row.
// Shared by the inline editor and the AI-refine dialog (no title/generate).
const RouteCardsEditor: React.FC<{
  route: EditableDestination[];
  setRoute: (route: EditableDestination[]) => void;
}> = ({ route, setRoute }) => {
  const update = (id: string, key: keyof EditableDestination, value: string) => {
    setRoute(route.map((d) => (d.id === id ? { ...d, [key]: value } : d)));
  };
  const addStop = () => setRoute([...route, { ...EMPTY_DESTINATION, id: newDestId() }]);
  const removeStop = (id: string) => setRoute(route.filter((d) => d.id !== id));
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = route.findIndex((d) => d.id === active.id);
    const newIndex = route.findIndex((d) => d.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setRoute(arrayMove(route, oldIndex, newIndex));
  };

  const namedStops = route.filter((d) => d.name.trim()).length;
  const { timeWindow, totalCost } = computeSummary(route);
  const summaryCards = [
    { label: "Time window", value: timeWindow ?? "—" },
    { label: "Total cost", value: totalCost ?? "—" },
    { label: "Destinations", value: namedStops > 0 ? String(namedStops) : "—" },
  ];

  // A stop's start time is "abnormal" when it falls before the earliest it
  // could begin (previous start + stay + travel) — flagged in red.
  const invalid = route.map(() => false);
  for (let i = 1; i < route.length; i += 1) {
    const prevStart = parseClock(route[i - 1].start_time);
    const thisStart = parseClock(route[i].start_time);
    if (prevStart == null || thisStart == null) continue;
    const prevStay = parseMins(route[i - 1].stay_duration) ?? 0;
    const travel = parseMins(route[i].travel_time_from_previous) ?? 0;
    if (thisStart < prevStart + prevStay + travel) invalid[i] = true;
  }

  // Align each card's name / description / time section to the tallest one so
  // the rows below line up across cards (mirrors RoutePlanView).
  const rowRef = React.useRef<HTMLDivElement>(null);
  const syncSectionHeights = React.useCallback(() => {
    const container = rowRef.current;
    if (!container) return;
    (["name", "desc", "time"] as const).forEach((section) => {
      const els = Array.from(
        container.querySelectorAll<HTMLElement>(`[data-card-section="${section}"]`)
      );
      els.forEach((el) => (el.style.minHeight = ""));
      if (els.length < 2) return;
      let max = 0;
      els.forEach((el) => {
        const h = el.getBoundingClientRect().height;
        if (h > max) max = h;
      });
      if (max > 0) els.forEach((el) => (el.style.minHeight = `${max}px`));
    });
  }, []);
  React.useLayoutEffect(() => {
    syncSectionHeights();
  }, [route, syncSectionHeights]);
  React.useEffect(() => {
    window.addEventListener("resize", syncSectionHeights);
    return () => window.removeEventListener("resize", syncSectionHeights);
  }, [syncSectionHeights]);

  return (
    <div className="space-y-3">
      {/* Summary cards (time window / total cost / destinations), styled like
          RoutePlanView's and computed the same way. */}
      <div className="flex flex-wrap justify-center gap-3">
        {summaryCards.map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-outline bg-surface shadow-sm px-3 py-2 text-center min-w-[150px]"
          >
            <div className="text-[11px] font-semibold tracking-wide text-zinc-600 dark:text-zinc-400">
              {card.label}
            </div>
            <div className="text-xl font-bold text-on-surface mt-0.5">{card.value}</div>
          </div>
        ))}
      </div>

      {/* Horizontal, editable, drag-sortable version of the RoutePlanView row. */}
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={route.map((d) => d.id)} strategy={horizontalListSortingStrategy}>
          <div ref={rowRef} className="flex gap-4 overflow-x-auto pb-2">
            {route.map((dest, idx) => (
              <SortableDestinationCard
                key={dest.id}
                dest={dest}
                index={idx}
                isFirst={idx === 0}
                invalidStart={invalid[idx]}
                update={update}
                removeStop={removeStop}
              />
            ))}

            {/* Add-destination card at the end of the row (not sortable). */}
            <button
              type="button"
              onClick={addStop}
              className="min-w-[120px] flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-outline-secondary px-4 py-5 text-on-surface-secondary hover:bg-surface"
            >
              <Plus className="w-5 h-5" />
              <span className="text-sm font-medium">Add destination</span>
            </button>
          </div>
        </SortableContext>
      </DndContext>

      {route.length === 0 && (
        <p className="text-sm text-on-surface-tertiary text-center">
          Add stops above, or ask the AI below to draft the route.
        </p>
      )}
    </div>
  );
};

// ── Model picker (ChatGPT-style: model name + chevron, opens a menu) ──
// Button label: the model id minus its provider prefix and, for multi-instance
// vllm/ollama ids like "vllm/1/Qwen/Qwen3.5-9B", the instance index too.
const modelShortLabel = (m: string) => {
  let rest = m.split("/").slice(1);
  if (rest.length > 1 && /^\d+$/.test(rest[0])) rest = rest.slice(1);
  return rest.join("/") || m;
};

// Mirrors the participant modal's Model <select>: grouped options
// (Commercial / vLLM / Ollama) plus a Custom free-text mode.
const ModelPicker: React.FC<{
  value: string;
  groups: ModelOptionGroup[];
  onChange: (value: string) => void;
}> = ({ value, groups, onChange }) => {
  const [open, setOpen] = React.useState(false);
  // Start in custom mode when the current value isn't a known option.
  const [custom, setCustom] = React.useState(
    () => !groups.some((g) => g.options.some((o) => o.value === value))
  );
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  if (custom) {
    return (
      <div className="relative flex h-9 items-center">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="provider/model-name"
          aria-label="Custom model"
          className="h-9 w-44 rounded-lg border border-outline bg-surface pl-2 pr-7 text-sm text-on-surface focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            setCustom(false);
            onChange(groups[0]?.options[0]?.value ?? "");
          }}
          aria-label="Back to model list"
          title="Back to model list"
          className="absolute right-1.5 text-on-surface-tertiary hover:text-accent"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Choose model"
        title={value}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1 px-2 text-sm text-on-surface-secondary hover:text-on-surface transition-colors"
      >
        {modelShortLabel(value)}
        <ChevronDown className="w-4 h-4 text-on-surface-tertiary" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-20 mb-1 max-h-64 min-w-[16rem] overflow-y-auto rounded-lg border border-outline bg-surface py-1 shadow-lg">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="px-3 pt-2 pb-1 text-xs font-medium text-on-surface-tertiary">
                {group.label}
              </div>
              {group.options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-sm ${
                    opt.value === value
                      ? "bg-accent-soft text-accent-soft-text"
                      : "text-on-surface hover:bg-surface-secondary"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          ))}
          <div className="mt-1 border-t border-outline pt-1">
            <button
              type="button"
              onClick={() => {
                setCustom(true);
                setOpen(false);
                onChange("");
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-on-surface-tertiary hover:bg-surface-secondary"
            >
              Custom…
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// Interactive AI refinement: shows the proposal (editable) with a chat below.
// The dialog edits the editor's route directly, so every change — manual or
// AI-generated — is already saved when the dialog closes (X / outside click).
const AIRefineDialog: React.FC<{
  open: boolean;
  route: EditableDestination[];
  setRoute: (route: EditableDestination[]) => void;
  generateHumanRoute: (
    description: string,
    route: any[],
    model?: string,
    history?: { role: string; content: string }[]
  ) => Promise<any>;
  onClose: () => void;
  modelGroups: ModelOptionGroup[];
  defaultModel: string;
}> = ({ open, route, setRoute, generateHumanRoute, onClose, modelGroups, defaultModel }) => {
  const [messages, setMessages] = React.useState<{ role: "user" | "ai"; text: string }[]>([]);
  const [input, setInput] = React.useState("");
  const [generating, setGenerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [model, setModel] = React.useState(defaultModel);
  // Snapshot of the route as it was when the dialog opened, so Reset can
  // discard everything done in this dialog session.
  const openRouteRef = React.useRef<EditableDestination[]>(route);

  // The chat/session state deliberately survives closing the dialog: a
  // generation that is still running keeps going in the background (the
  // route is shared with the editor, so its result lands either way), and
  // reopening shows the conversation where it left off. Only the Reset
  // snapshot is re-anchored to what's on screen at open time. The state
  // clears naturally when the editor unmounts at the end of the turn.
  React.useEffect(() => {
    if (open) {
      openRouteRef.current = route;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reset = () => {
    if (generating) return;
    setRoute(openRouteRef.current);
    setMessages([]);
    setInput("");
    setError(null);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || generating) return;
    // The chat so far (before this message) travels along as conversation
    // history so the model remembers earlier exchanges in this session.
    const history = messages.map((m) => ({ role: m.role, content: m.text }));
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setGenerating(true);
    setError(null);
    try {
      const result = await generateHumanRoute(
        text,
        route.map(({ id: _id, ...d }) => d),
        model,
        history
      );
      // An empty route means the AI answered without (re)drafting — e.g. it
      // asked a clarifying question — so keep the current route as-is.
      if (result && Array.isArray(result.route) && result.route.length > 0) {
        setRoute(result.route.map(toEditableDestination));
      }
      const reply = result && result.message ? String(result.message) : "Updated the route.";
      setMessages((m) => [...m, { role: "ai", text: reply }]);
    } catch (err: any) {
      setError(err?.message || "Route generation failed.");
    } finally {
      setGenerating(false);
    }
  };

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-outline bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h3 className="flex items-center gap-1.5 font-semibold text-on-surface">
            {/* SVG gradient paint for the sparkles' stroke (same rainbow as
                the Generate with AI button). */}
            <svg width="0" height="0" className="absolute" aria-hidden="true">
              <defs>
                <linearGradient id="ai-rainbow-gradient" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#ef4444" />
                  <stop offset="25%" stopColor="#f59e0b" />
                  <stop offset="50%" stopColor="#10b981" />
                  <stop offset="75%" stopColor="#3b82f6" />
                  <stop offset="100%" stopColor="#8b5cf6" />
                </linearGradient>
              </defs>
            </svg>
            <Sparkles className="w-4 h-4" color="url(#ai-rainbow-gradient)" />
            Refine your proposal with AI
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-on-surface-tertiary hover:text-on-surface"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
          <RouteCardsEditor route={route} setRoute={setRoute} />

          {messages.length > 0 && (
            <div className="space-y-2">
              {messages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-accent-soft text-accent-soft-text"
                        : "bg-surface-secondary text-on-surface-secondary"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
              {generating && (
                <div className="flex justify-start">
                  {/* Same bouncing typing dots as the meeting chat. */}
                  <div
                    className="flex items-center gap-1 rounded-lg bg-surface-secondary px-3 py-2"
                    aria-label="Generating reply"
                    role="status"
                  >
                    {[0, 1, 2].map((n) => (
                      <span
                        key={n}
                        className="typing-dot inline-block w-2 h-2 rounded-full bg-on-surface-tertiary"
                        style={{ animationDelay: `${n * 0.18}s` }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        </div>

        <div className="p-3 pt-0">
          <ChatComposer
            value={input}
            disabled={generating}
            placeholder="Describe the route, or how to change it (e.g. add a lunch stop)…"
            sendEnabled={!!input.trim() && !generating}
            onChange={setInput}
            onSubmit={send}
            tall
            footerLeft={
              <button
                type="button"
                onClick={reset}
                disabled={generating}
                title="Restore the route as it was when this dialog opened and clear the chat"
                className="flex h-9 items-center gap-1.5 px-2 text-sm text-on-surface-secondary hover:text-on-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-4 h-4" />
                Reset
              </button>
            }
            footerRight={<ModelPicker value={model} groups={modelGroups} onChange={setModel} />}
          />
        </div>
      </div>
    </div>
  );
};

const HumanRouteEditor: React.FC<HumanRouteEditorProps> = ({
  route,
  setRoute,
  generateHumanRoute,
  canGenerate,
  modelGroups,
  defaultModel,
}) => {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  return (
    // No own background/padding: the speak-action header already provides
    // them, so the editor lines up with the other actions and the chat box.
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-on-surface">Your proposal</h3>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          disabled={!canGenerate}
          title="Refine this route with AI in a chat"
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
            !canGenerate
              ? "bg-gray-200 text-on-surface-tertiary cursor-not-allowed dark:bg-zinc-700"
              : "text-white bg-[linear-gradient(90deg,#ef4444,#f59e0b,#10b981,#3b82f6,#8b5cf6)] hover:brightness-110"
          }`}
        >
          <Sparkles className="w-4 h-4" />
          Generate with AI
        </button>
      </div>

      <RouteCardsEditor route={route} setRoute={setRoute} />

      <AIRefineDialog
        open={dialogOpen}
        route={route}
        setRoute={setRoute}
        generateHumanRoute={generateHumanRoute}
        onClose={() => setDialogOpen(false)}
        modelGroups={modelGroups}
        defaultModel={defaultModel}
      />
    </div>
  );
};

interface SortableDestinationCardProps {
  dest: EditableDestination;
  index: number;
  isFirst: boolean;
  invalidStart: boolean;
  update: (id: string, key: keyof EditableDestination, value: string) => void;
  removeStop: (id: string) => void;
}

const SortableDestinationCard: React.FC<SortableDestinationCardProps> = ({
  dest,
  index,
  isFirst,
  invalidStart,
  update,
  removeStop,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: dest.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    // The sortable unit is this stop's incoming connector (if any) plus its
    // card, so the connector travels with the card while dragging.
    <div ref={setNodeRef} style={style} className="flex items-center gap-4">
      {!isFirst && (
        <div className="flex flex-col items-center justify-center min-w-[92px] gap-1 text-xs text-on-surface-tertiary">
          <input
            type="text"
            value={dest.transport_mode}
            onChange={(e) => update(dest.id, "transport_mode", e.target.value)}
            placeholder="walk"
            className={`w-20 text-center ${CELL}`}
          />
          <span className="text-accent text-xl leading-none">➜</span>
          <input
            type="text"
            value={dest.travel_time_from_previous}
            onChange={(e) => update(dest.id, "travel_time_from_previous", e.target.value)}
            placeholder="10 min"
            className={`w-20 text-center font-semibold text-on-surface-secondary ${CELL}`}
          />
          <input
            type="text"
            value={dest.transport_cost}
            onChange={(e) => update(dest.id, "transport_cost", e.target.value)}
            placeholder="$0"
            className={`w-20 text-center ${CELL}`}
          />
        </div>
      )}

      <div className="min-w-[190px] max-w-[210px] bg-surface border border-outline rounded-lg shadow-sm px-3 pt-2 pb-4 flex flex-col items-center text-center">
        {/* Top row: drag handle (left) and delete (right), both inside the box. */}
        <div className="flex w-full items-center justify-between">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label="Drag to reorder"
            title="Drag to reorder"
            style={{ touchAction: "none" }}
            className="cursor-grab text-on-surface-tertiary hover:text-on-surface active:cursor-grabbing"
          >
            <GripVertical className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => removeStop(dest.id)}
            aria-label="Remove destination"
            className="text-on-surface-tertiary hover:text-red-600"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>

        <div className="w-8 h-8 rounded-full bg-accent-soft text-accent-soft-text border border-accent flex items-center justify-center font-semibold">
          {index + 1}
        </div>
        <div data-card-section="name" className="mt-3 w-full">
          <GrowingTextarea
            value={dest.name}
            onChange={(v) => update(dest.id, "name", v)}
            placeholder="Destination name"
            className={`w-full text-center text-base font-semibold leading-snug text-on-surface ${CELL}`}
          />
        </div>
        <div data-card-section="desc" className="mt-1 w-full">
          <GrowingTextarea
            value={dest.description}
            onChange={(v) => update(dest.id, "description", v)}
            placeholder="Notes"
            className={`w-full text-center text-xs leading-snug text-zinc-600 dark:text-zinc-400 ${CELL}`}
          />
        </div>
        <div data-card-section="time" className="mt-3 flex items-center justify-center gap-1 text-sm text-on-surface-tertiary">
          <Clock3 className={`w-4 h-4 flex-shrink-0 ${invalidStart ? "text-red-600 dark:text-red-400" : ""}`} />
          <input
            type="text"
            value={dest.start_time}
            onChange={(e) => update(dest.id, "start_time", e.target.value)}
            placeholder="10:00"
            title={invalidStart ? "This start time is earlier than the previous stop allows" : undefined}
            className={`w-14 text-center font-semibold ${CELL} ${
              invalidStart ? "text-red-600 dark:text-red-400" : ""
            }`}
          />
          <span className="text-on-surface-tertiary">·</span>
          <input
            type="text"
            value={dest.stay_duration}
            onChange={(e) => update(dest.id, "stay_duration", e.target.value)}
            placeholder="60 min"
            className={`w-16 text-center ${CELL}`}
          />
        </div>
        <input
          type="text"
          value={dest.cost}
          onChange={(e) => update(dest.id, "cost", e.target.value)}
          placeholder="$10"
          className={`mt-1 w-20 text-center text-sm font-semibold text-on-surface-tertiary ${CELL}`}
        />
      </div>
    </div>
  );
};

export default HumanRouteEditor;
