import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Clock3, AlertTriangle, Car, Train, Bike } from "lucide-react";
import type { RoutePlan, RoutePlanDestination } from "../types";
import { formatStayWindow } from "../utils/formatting";

type TransportKind = "walk" | "bus" | "train" | "bike" | "car";

// Match a free-text transport mode onto a known kind. Order matters: the
// train/bike checks (電車 / 自転車) run before car, since both contain 車.
function transportKind(mode?: string | null): TransportKind | null {
  if (!mode) return null;
  const m = mode.toLowerCase();
  if (/walk|on foot|foot|徒歩|歩/.test(m)) return "walk";
  if (/bus|バス/.test(m)) return "bus";
  if (/train|subway|metro|rail|電車|地下鉄|列車/.test(m)) return "train";
  if (/bike|bicycle|cycl|自転車/.test(m)) return "bike";
  if (/car|taxi|drive|driving|車|タクシー/.test(m)) return "car";
  return null;
}

// A pedestrian mid-stride facing right, so the icon itself reads left-to-right
// like the route flow. Uses the Tabler "walk" glyph (MIT-licensed) embedded
// here to avoid pulling in a second icon package; stroke styling matches the
// lucide icons beside it.
function WalkingPerson(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="13" cy="4" r="1" />
      <path d="M7 21l3 -4" />
      <path d="M16 21l-2 -4l-3 -3l1 -6" />
      <path d="M6 12l2 -3l4 -1l3 3l3 1" />
    </svg>
  );
}

// Tabler "bus" glyph (MIT), embedded like WalkingPerson; its front faces right
// so it also reads left-to-right.
function BusIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M6 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M18 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
      <path d="M4 17h-2v-11a1 1 0 0 1 1 -1h14a5 7 0 0 1 5 7v5h-2m-4 0h-8" />
      <path d="M16 5l1.5 7l4.5 0" />
      <path d="M2 10l15 0" />
      <path d="M7 5l0 5" />
      <path d="M12 5l0 5" />
    </svg>
  );
}

function TransportIcon({
  kind,
  mode,
  className,
}: {
  kind: TransportKind;
  mode?: string | null;
  className?: string;
}) {
  const label = mode ?? undefined;
  switch (kind) {
    case "walk":
      return <WalkingPerson className={className} aria-label={label} />;
    case "bus":
      return <BusIcon className={className} aria-label={label} />;
    case "train":
      return <Train className={className} aria-label={label} />;
    case "bike":
      return <Bike className={className} aria-label={label} />;
    case "car":
      return <Car className={className} aria-label={label} />;
  }
}

type RouteScrollState = { pos: number; auto: boolean };

interface RoutePlanViewProps {
  plan: RoutePlan;
  scrollKey: string;
  routeScrollPositionsRef: React.MutableRefObject<Record<string, RouteScrollState>>;
  /** Optional header row rendered at the frame's top-left (e.g. a "Proposal"
   *  tag plus a retry marker), styled like the other chat boxes' badges. */
  headerSlot?: React.ReactNode;
  /** Extra classes on the outer frame (e.g. the chat-pop entrance). */
  className?: string;
}

export default function RoutePlanView({
  plan,
  scrollKey,
  routeScrollPositionsRef,
  headerSlot,
  className,
}: RoutePlanViewProps) {
  const destinations = plan.destinations ?? [];
  if (!destinations.length) {
    return null;
  }
  // Render the description row on every card (empty when absent) whenever any
  // card has one, so heights can be aligned across the row.
  const anyDescription = destinations.some((d) => Boolean(d.description));
  const summary = plan.summary ?? {};
  const stopCount = destinations.filter((d) => d.diff_status !== "removed").length;
  const summaryCards = [
    {
      label: "Time window",
      value: summary.time_window ?? "—",
    },
    {
      label: "Total cost",
      value: summary.total_cost ?? "—",
    },
    {
      label: "Destinations",
      value: stopCount > 0 ? String(stopCount) : "—",
    },
  ];

  const getDiffStyles = (diffStatus?: string) => {
    switch (diffStatus) {
      case "added":
        return {
          border: "border-zinc-400",
          bg: "bg-zinc-50 dark:bg-zinc-800",
          badge: "bg-zinc-600",
          badgeText: "text-white",
          badgeBorder: "",
          text: "text-on-surface",
          badgeIcon: "+"
        };
      case "removed":
        return {
          border: "border-zinc-300",
          bg: "bg-zinc-100 dark:bg-zinc-800/50",
          badge: "bg-zinc-400",
          badgeText: "text-white",
          badgeBorder: "",
          text: "text-on-surface-tertiary",
          badgeIcon: "✕"
        };
      case "modified":
        return {
          border: "border-zinc-500",
          bg: "bg-surface-secondary",
          badge: "bg-zinc-500",
          badgeText: "text-white",
          badgeBorder: "",
          text: "text-on-surface-secondary",
          badgeIcon: "~"
        };
      default:
        return {
          border: "border-outline",
          bg: "bg-surface",
          // Light green fill + green digit, with a green (accent, same as the
          // transport icons) ring around the circle.
          badge: "bg-accent-soft",
          badgeText: "text-accent-soft-text",
          badgeBorder: "border border-accent",
          text: "text-on-surface",
          badgeIcon: null
        };
    }
  };

  const renderConnector = (nextStop: RoutePlanDestination, idx: number) => {
    const travel = nextStop.travel_time_from_previous;
    const mode = nextStop.transport_mode;
    const transportCost = nextStop.transport_cost;
    if (!travel && !mode && !transportCost) {
      return (
        <div
          key={`connector-${idx}`}
          className="flex flex-col items-center justify-center text-xs text-on-surface-tertiary min-w-[32px]"
        >
          <span className="text-accent">›</span>
        </div>
      );
    }
    // When the mode matches a known kind, its icon stands in for the arrow +
    // mode text; otherwise fall back to the arrow with the raw mode label.
    const kind = transportKind(mode);
    return (
      <div
        key={`connector-${idx}`}
        className="flex flex-col items-center justify-center text-xs text-on-surface-tertiary min-w-[64px]"
      >
        {kind ? (
          <TransportIcon kind={kind} mode={mode} className="w-5 h-5 text-accent" />
        ) : (
          <>
            <span className="text-accent text-xl">➜</span>
            {mode && <span className="mt-1 text-zinc-600 dark:text-zinc-400">{mode}</span>}
          </>
        )}
        {travel && <span className="mt-1 font-semibold text-on-surface-secondary">{travel}</span>}
        {transportCost && <span className="mt-0.5 text-on-surface-tertiary">{transportCost}</span>}
      </div>
    );
  };

  const hasSummaryCard = summaryCards.some((card) => card.value !== "—");

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const adjustJustification = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const shouldCenter = container.scrollWidth <= container.clientWidth + 1;
    container.style.justifyContent = shouldCenter ? "center" : "flex-start";
  }, []);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    let state = routeScrollPositionsRef.current[scrollKey];
    if (!state) {
      state = { pos: 0, auto: true };
      routeScrollPositionsRef.current[scrollKey] = state;
    }
    if (state.auto) {
      const target = Math.max(0, container.scrollWidth - container.clientWidth);
      container.scrollLeft = target;
      state.pos = container.scrollLeft;
    } else {
      container.scrollLeft = state.pos;
    }
    adjustJustification();
  }, [scrollKey, destinations.length, adjustJustification, routeScrollPositionsRef]);

  useEffect(() => {
    const handler = () => adjustJustification();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [adjustJustification]);

  // Align each card section (name / description / time) to the tallest one so
  // that the rows below (time, cost) line up across cards regardless of how
  // many lines the name or description wraps to.
  const syncSectionHeights = useCallback(() => {
    const container = scrollContainerRef.current;
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

  useLayoutEffect(() => {
    syncSectionHeights();
  }, [destinations, anyDescription, syncSectionHeights]);

  useEffect(() => {
    window.addEventListener("resize", syncSectionHeights);
    return () => window.removeEventListener("resize", syncSectionHeights);
  }, [syncSectionHeights]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
    const nearRight = maxScroll === 0 ? true : maxScroll - container.scrollLeft <= 8;
    routeScrollPositionsRef.current[scrollKey] = {
      pos: container.scrollLeft,
      auto: nearRight,
    };
  };

  return (
    <div className={`mt-4 bg-surface-secondary rounded-lg px-3 pb-5 ${headerSlot ? "pt-2.5" : "pt-5"}${className ? ` ${className}` : ""}`}>
      {/* Tag row spacing (px-3 / pt-2.5 above, mb-1 below) mirrors the
          conclude/judge badge boxes so the "Proposal" tag hugs the frame the
          same way. */}
      {headerSlot && <div className="mb-1">{headerSlot}</div>}
      {hasSummaryCard && (
        <div className="flex flex-wrap justify-center gap-3 mb-5">
          {summaryCards.map((card, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-outline bg-surface shadow-sm px-3 py-2 text-center min-w-[150px]"
            >
              <div className="text-[11px] font-semibold tracking-wide text-zinc-600 dark:text-zinc-400">
                {card.label}
              </div>
              <div className="text-xl font-bold text-on-surface mt-0.5">{card.value}</div>
            </div>
          ))}
        </div>
      )}
      <div
        className="flex gap-4 overflow-x-auto pb-2"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {destinations.map((dest, idx) => {
          const styles = getDiffStyles(dest.diff_status);
          const isRemoved = dest.diff_status === "removed";
          return (
            <React.Fragment key={`${dest.name || "dest"}-${idx}`}>
              <div className={`min-w-[170px] max-w-[190px] ${styles.bg} border ${styles.border} rounded-lg shadow-sm px-4 py-5 flex flex-col items-center text-center relative ${isRemoved ? "opacity-70" : ""}`}>
                {styles.badgeIcon && (
                  <div className={`absolute -top-2 -right-2 w-6 h-6 rounded-full ${styles.badge} ${styles.badgeText} flex items-center justify-center font-bold text-sm shadow-lg`}>
                    {styles.badgeIcon}
                  </div>
                )}
                <div className={`w-8 h-8 rounded-full ${styles.badge} ${styles.badgeText} ${styles.badgeBorder} flex items-center justify-center font-semibold ${isRemoved ? "line-through" : ""}`}>
                  {idx + 1}
                </div>
                <div className="mt-3 w-full text-center">
                  <div
                    data-card-section="name"
                    className={`text-base font-semibold ${styles.text} ${isRemoved ? "line-through" : ""}`}
                  >
                    {dest.name || `Stop ${idx + 1}`}
                  </div>
                  {anyDescription && (
                    <div
                      data-card-section="desc"
                      className={`mt-1 text-xs text-zinc-600 dark:text-zinc-400 font-medium ${isRemoved ? "line-through" : ""}`}
                    >
                      {dest.description ?? ""}
                    </div>
                  )}
                </div>
                <div className="mt-3 w-full text-center text-sm text-on-surface-tertiary">
                  <div data-card-section="time">
                    {dest.start_time && (
                      <div className={`flex items-center justify-center gap-1 text-on-surface-tertiary ${isRemoved ? "line-through" : ""}`}>
                        <Clock3 className="w-4 h-4" />
                        <span className="font-semibold">
                          {formatStayWindow(dest.start_time, dest.stay_duration) ?? dest.start_time}
                        </span>
                        {dest.original_start_time && (
                          <span className="relative group cursor-help">
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-[11px] bg-zinc-800 text-white rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                              Adjusted: {dest.original_start_time} → {dest.start_time}
                            </span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {dest.cost && (
                    <div className={`mt-1 text-on-surface-tertiary font-semibold ${isRemoved ? "line-through" : ""}`}>
                      {dest.cost}
                    </div>
                  )}
                </div>
              </div>
              {idx < destinations.length - 1 &&
                renderConnector(destinations[idx + 1], idx)}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
