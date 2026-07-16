import { useState, useCallback, useEffect, useRef } from "react";
import type {
  LogEntry,
  MessageOut,
  RoutePlan,
  SearchSection,
  InternalEventPayload,
  InternalLogContext,
  MeetingHistory,
} from "../types";
import {
  buildInternalKey,
  buildExpandedStorageKey,
  findLastMessageEntry,
  normalizeNameForKey,
  parseInvitationPhasePayload,
} from "../utils/helpers";
import { INTERNAL_EXPANDED_STORAGE_KEY } from "../constants";

function mergeStreamingText(existing: string, incoming: string): string {
  if (!incoming) {
    return existing;
  }
  if (!existing) {
    return incoming;
  }
  if (incoming.startsWith(existing)) {
    // Backend sometimes sends cumulative chunks (A -> AB -> ABC).
    return incoming;
  }
  if (existing.includes(incoming)) {
    return existing;
  }

  const maxOverlap = Math.min(existing.length, incoming.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap);
    }
  }

  return existing + incoming;
}

export interface UseMeetingLogsOptions {
  currentMeetingId: string | null;
  logs: LogEntry[];
  setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  meetingHistory: MeetingHistory;
  setMeetingHistory: React.Dispatch<React.SetStateAction<MeetingHistory>>;
  expandedInternalLogs: Record<string, boolean>;
  setExpandedInternalLogs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  meetings: { id: string; status?: string }[];
  status: string;
}

export interface UseMeetingLogsReturn {
  // State
  elapsedSeconds: number;
  setElapsedSeconds: React.Dispatch<React.SetStateAction<number>>;
  nowSeconds: number;
  expandedInternalLogsCache: Record<string, Record<string, boolean>>;
  setExpandedInternalLogsCache: React.Dispatch<React.SetStateAction<Record<string, Record<string, boolean>>>>;

  // Refs
  meetingStartRef: React.MutableRefObject<Record<string, number>>;
  meetingResumeOffsetRef: React.MutableRefObject<Record<string, number>>;

  // Callbacks
  tickElapsed: () => void;
  restoreExpandedLogs: (meetingId?: string | null) => void;
  resetLogsState: (opts?: { meetingId?: string; clearCache?: boolean }) => void;
  clearInternalStream: (key: string) => void;
  upsertMessage: (
    turn: number,
    speaker: string,
    append?: string,
    finalText?: string,
    routePlan?: RoutePlan,
    internalContext?: InternalLogContext,
    maxSteps?: number,
    score?: number
  ) => void;
  upsertRoutePlan: (turn: number, speaker: string, routePlan: RoutePlan) => void;
  upsertSearchSection: (turn: number, speaker: string, section: SearchSection) => void;
  handleInternalEvent: (turn: number, speaker: string, internalEvent?: InternalEventPayload) => void;
  toggleInternalLog: (key: string) => void;
  appendPhaseLog: (title: string, description?: string | null, opts?: { replay?: boolean }) => void;
  appendInvitationMessage: (title: string, description?: string | null, opts?: { replay?: boolean }) => void;
}

export function useMeetingLogs({
  currentMeetingId,
  logs,
  setLogs,
  meetingHistory,
  setMeetingHistory,
  expandedInternalLogs,
  setExpandedInternalLogs,
  meetings,
  status,
}: UseMeetingLogsOptions): UseMeetingLogsReturn {
  // State
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [nowSeconds, setNowSeconds] = useState<number>(() => Math.floor(Date.now() / 1000));
  const [expandedInternalLogsCache, setExpandedInternalLogsCache] = useState<
    Record<string, Record<string, boolean>>
  >({});

  // Refs
  const meetingStartRef = useRef<Record<string, number>>({});
  const meetingResumeOffsetRef = useRef<Record<string, number>>({});

  // Load expandedInternalLogsCache from localStorage on mount
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const raw = window.localStorage.getItem(INTERNAL_EXPANDED_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          setExpandedInternalLogsCache(parsed);
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Save expandedInternalLogsCache to localStorage
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(
        INTERNAL_EXPANDED_STORAGE_KEY,
        JSON.stringify(expandedInternalLogsCache)
      );
    } catch {
      /* ignore */
    }
  }, [expandedInternalLogsCache]);

  // Restore expanded logs for current meeting
  useEffect(() => {
    const key = buildExpandedStorageKey(currentMeetingId);
    setExpandedInternalLogs(expandedInternalLogsCache[key] ?? {});
  }, [currentMeetingId, expandedInternalLogsCache, setExpandedInternalLogs]);

  // Tick elapsed time
  const tickElapsed = useCallback(() => {
    if (!currentMeetingId) return;
    const startedAt = meetingStartRef.current[currentMeetingId];
    if (startedAt) {
      const diff = Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
      setElapsedSeconds(diff);
      return;
    }
    const offset = meetingResumeOffsetRef.current[currentMeetingId] ?? 0;
    setElapsedSeconds(offset);
  }, [currentMeetingId]);

  // Timer effect
  useEffect(() => {
    const normalizedStatus = (status ?? "").toLowerCase();
    const runningLikeStatuses = new Set(["running", "stopping"]);
    const hasRunningMeeting =
      runningLikeStatuses.has(normalizedStatus) ||
      meetings.some((meeting) =>
        runningLikeStatuses.has((meeting.status ?? "").toLowerCase())
      ) ||
      Object.values(meetingStartRef.current).some(
        (startedAt) => typeof startedAt === "number"
      );
    if (!hasRunningMeeting) {
      return;
    }
    setNowSeconds(Math.floor(Date.now() / 1000));
    const intervalId = window.setInterval(() => {
      setNowSeconds(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [meetings, status]);

  useEffect(() => {
    tickElapsed();
  }, [nowSeconds, tickElapsed]);

  // Restore expanded logs
  const restoreExpandedLogs = useCallback(
    (meetingId?: string | null) => {
      const key = buildExpandedStorageKey(meetingId);
      setExpandedInternalLogs(expandedInternalLogsCache[key] ?? {});
    },
    [expandedInternalLogsCache, setExpandedInternalLogs]
  );

  // Reset logs state
  const resetLogsState = useCallback(
    (opts?: { meetingId?: string; clearCache?: boolean }) => {
      setLogs([]);
      const shouldClear = opts?.clearCache ?? false;
      if (shouldClear) {
        const targetId = opts?.meetingId ?? currentMeetingId;
        if (targetId) {
          setExpandedInternalLogsCache((prev) => {
            if (!prev[targetId]) {
              return prev;
            }
            const next = { ...prev };
            delete next[targetId];
            return next;
          });
        }
      }
    },
    [currentMeetingId, setLogs]
  );

  // Clear internal stream (no-op: internal thoughts are now part of logs)
  const clearInternalStream = useCallback((_key: string) => {
    // No-op: internal thoughts are now part of logs
  }, []);

  // Upsert message
  const upsertMessage = useCallback(
    (
      turn: number,
      speaker: string,
      append?: string,
      finalText?: string,
      routePlan?: RoutePlan,
      internalContext?: InternalLogContext,
      maxSteps?: number,
      score?: number
    ) => {
      setLogs((prev) => {
        const idx = prev.findIndex(
          (m) =>
            m.kind === "message" &&
            m.turn === turn &&
            m.name === speaker
        );
        let next: LogEntry[];
        if (idx === -1) {
          const content = finalText ?? append ?? "";
          const entry: MessageOut = {
            kind: "message",
            name: speaker,
            content,
            turn,
          };
          if (routePlan) {
            entry.routePlan = routePlan;
          }
          if (internalContext) {
            entry.stepsLog = internalContext.log;
            entry.stepsLabel = internalContext.taskLabel;
          }
          if (maxSteps != null) {
            entry.maxSteps = maxSteps;
          }
          if (typeof score === "number" && Number.isFinite(score)) {
            entry.score = score;
          }
          next = [...prev, entry];
        } else {
          next = [...prev];
          const existing = next[idx] as MessageOut;
          const shouldKeepExistingOnEmptyFinal =
            finalText === "" && existing.content.trim().length > 0;
          const content =
            finalText != null
              ? shouldKeepExistingOnEmptyFinal
                ? existing.content
                : finalText
              : append
              ? mergeStreamingText(existing.content, append)
              : existing.content;
          const updated: MessageOut = { ...existing, content };
          if (routePlan) {
            updated.routePlan = routePlan;
          }
          if (internalContext) {
            if (internalContext.log) {
              if (internalContext.replaceLog) {
                updated.stepsLog = internalContext.log;
              } else {
                const existingLog = updated.stepsLog || "";
                const newLog = internalContext.log;

                if (internalContext.stepNumber && internalContext.action !== undefined) {
                  const stepPattern = new RegExp(
                    `\\[Step ${internalContext.stepNumber}/\\d+(?:\\s*-\\s*${internalContext.action ? internalContext.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[^\\]]*'})?\\]\\n[^\\[]*(?:\\nSearch: [^\\n]+)?`,
                    'g'
                  );

                  if (existingLog.match(stepPattern)) {
                    updated.stepsLog = existingLog.replace(stepPattern, newLog);
                  } else {
                    updated.stepsLog = existingLog ? existingLog + "\n\n" + newLog : newLog;
                  }
                } else {
                  if (existingLog && !existingLog.endsWith(newLog)) {
                    updated.stepsLog = existingLog + "\n\n" + newLog;
                  } else if (!existingLog) {
                    updated.stepsLog = newLog;
                  }
                }
              }
            }
            updated.stepsLabel = internalContext.taskLabel ?? updated.stepsLabel;
          }
          if (maxSteps != null) {
            updated.maxSteps = maxSteps;
          }
          if (typeof score === "number" && Number.isFinite(score)) {
            updated.score = score;
          }
          next[idx] = updated;
        }
        if (currentMeetingId) {
          setMeetingHistory((prevHistory) => ({
            ...prevHistory,
            [currentMeetingId]: next,
          }));
        }
        return next;
      });
    },
    [currentMeetingId, setLogs, setMeetingHistory]
  );

  // Upsert route plan
  const upsertRoutePlan = useCallback(
    (turn: number, speaker: string, routePlan: RoutePlan) => {
      setLogs((prev) => {
        const idx = prev.findIndex(
          (m) =>
            m.kind === "message" &&
            m.turn === turn &&
            m.name === speaker
        );
        if (idx === -1) {
          return prev;
        }
        const next = [...prev];
        const existing = next[idx] as MessageOut;
        next[idx] = { ...existing, routePlan };
        if (currentMeetingId) {
          setMeetingHistory((prevHistory) => ({
            ...prevHistory,
            [currentMeetingId]: next,
          }));
        }
        return next;
      });
    },
    [currentMeetingId, setLogs, setMeetingHistory]
  );

  // Upsert search section (search_start or search_complete)
  const upsertSearchSection = useCallback(
    (turn: number, speaker: string, section: SearchSection) => {
      setLogs((prev) => {
        const idx = prev.findIndex(
          (m) =>
            m.kind === "message" &&
            m.turn === turn &&
            m.name === speaker
        );
        if (idx === -1) return prev;
        const next = [...prev];
        const existing = next[idx] as MessageOut;
        const searches = [...(existing.searches || [])];
        // If search_start: add a new searching entry
        if (section.searching) {
          searches.push(section);
        } else {
          // search_complete: find matching query and update
          const matchIdx = searches.findIndex(
            (s) => s.searching && s.query === section.query
          );
          if (matchIdx !== -1) {
            searches[matchIdx] = section;
          } else {
            searches.push(section);
          }
        }
        next[idx] = { ...existing, searches };
        if (currentMeetingId) {
          setMeetingHistory((prevHistory) => ({
            ...prevHistory,
            [currentMeetingId]: next,
          }));
        }
        return next;
      });
    },
    [currentMeetingId, setLogs, setMeetingHistory]
  );

  // Handle internal event
  const handleInternalEvent = useCallback(
    (turn: number, speaker: string, internalEvent?: InternalEventPayload) => {
      if (!internalEvent) {
        return;
      }
      const key = buildInternalKey(turn, speaker);

      if (internalEvent.event_type === "complete") {
        clearInternalStream(key);
        if (internalEvent.task_label) {
          const payload: InternalLogContext = {
            taskLabel: internalEvent.task_label,
          };
          upsertMessage(turn, speaker, undefined, undefined, undefined, payload);
        }

        setExpandedInternalLogs((prev) => {
          const next = { ...prev, [key]: false };
          const meetingKey = buildExpandedStorageKey(currentMeetingId);
          setExpandedInternalLogsCache((cachePrev) => {
            const meetingMap = { ...(cachePrev[meetingKey] ?? {}), [key]: false };
            return { ...cachePrev, [meetingKey]: meetingMap };
          });
          return next;
        });
        return;
      }

      // Handle ask exchange: append Q&A to stepsLog
      if (internalEvent.event_type === "ask_exchange") {
        // The question is the step's own message (already in the log);
        // only the answer needs appending.
        const response = internalEvent.response || "";
        const parts: string[] = [];
        if (response) parts.push(`AskA: ${response}`);
        if (parts.length > 0) {
          const payload: InternalLogContext = {
            log: parts.join("\n"),
            taskLabel: internalEvent.task_label,
            replaceLog: false,
          };
          upsertMessage(turn, speaker, undefined, undefined, undefined, payload);
        }
        return;
      }

      // Handle reflection: append notes to stepsLog
      if (internalEvent.event_type === "reflection") {
        const notes = internalEvent.notes || "";
        if (notes.trim().length > 0) {
          let logText = notes;
          if (internalEvent.step_number && internalEvent.max_steps) {
            const progressInfo = `[Step ${internalEvent.step_number}/${internalEvent.max_steps} - reflect]`;
            logText = `${progressInfo}\n${notes}`;
          }
          const shouldReplace = internalEvent.step_number && internalEvent.max_steps;
          const payload: InternalLogContext = {
            log: logText,
            taskLabel: internalEvent.task_label,
            replaceLog: false,
            stepNumber: shouldReplace ? internalEvent.step_number : undefined,
            action: shouldReplace ? "reflect" : undefined,
          };
          upsertMessage(turn, speaker, undefined, undefined, undefined, payload);
        }
        return;
      }

      if (internalEvent.event_type === "search_results") {
        const observation = internalEvent.observation || "";
        if (observation.trim().length > 0) {
          setLogs((prev) => {
            const idx = prev.findIndex(
              (m) =>
                m.kind === "message" &&
                m.turn === turn &&
                m.name === speaker
            );

            if (idx === -1) return prev;

            const next = [...prev];
            const existing = next[idx] as MessageOut;
            const existingLog = existing.stepsLog || "";

            const stepPattern = new RegExp(
              `\\[Step ${internalEvent.step_number}/${internalEvent.max_steps}[^\\]]*\\]\\n([^\\n]*(?:\\nSearch: [^\\n]+)?)\\n?([\\s\\S]*?)(?=\\n\\[Step |$)`,
              'g'
            );

            let updatedLog = existingLog;
            const stepPrefix = `[Step ${internalEvent.step_number}/${internalEvent.max_steps}${internalEvent.action ? ` - ${internalEvent.action}` : ""}]`;

            if (existingLog.includes(stepPrefix)) {
              updatedLog = existingLog.replace(
                stepPattern,
                (_match, thoughtAndSearch) => {
                  return `${stepPrefix}\n${thoughtAndSearch}\n${observation}`;
                }
              );
            }

            const updated: MessageOut = {
              ...existing,
              stepsLog: updatedLog,
            };
            next[idx] = updated;

            if (currentMeetingId) {
              setMeetingHistory((prevHistory) => ({
                ...prevHistory,
                [currentMeetingId]: next,
              }));
            }
            return next;
          });
        }
        return;
      }

      const message = internalEvent.thought || internalEvent.working_notes || "";
      if (message && message.trim().length > 0) {
        let logText = message;
        if (internalEvent.step_number && internalEvent.max_steps) {
          const progressInfo = `[Step ${internalEvent.step_number}/${internalEvent.max_steps}${internalEvent.action ? ` - ${internalEvent.action}` : ""}]`;
          logText = `${progressInfo}\n${message}`;
        }
        if (internalEvent.query) {
          logText += `\nSearch: ${internalEvent.query}`;
        }
        if (internalEvent.ask_target) {
          logText += `\nAsk: ${internalEvent.ask_target}`;
        }

        const shouldReplace = internalEvent.step_number && internalEvent.max_steps;

        const payload: InternalLogContext = {
          log: logText,
          summary: undefined,
          taskLabel: internalEvent.task_label,
          replaceLog: false,
          stepNumber: shouldReplace ? internalEvent.step_number : undefined,
          action: shouldReplace ? internalEvent.action : undefined,
        };
        upsertMessage(turn, speaker, undefined, undefined, undefined, payload);

        setExpandedInternalLogs((prev) => {
          if (prev[key] === false) {
            return prev;
          }
          const next = { ...prev, [key]: true };
          const meetingKey = buildExpandedStorageKey(currentMeetingId);
          setExpandedInternalLogsCache((cachePrev) => {
            const meetingMap = { ...(cachePrev[meetingKey] ?? {}), [key]: true };
            return { ...cachePrev, [meetingKey]: meetingMap };
          });
          return next;
        });
      }
    },
    [clearInternalStream, currentMeetingId, setExpandedInternalLogs, setLogs, setMeetingHistory, upsertMessage]
  );

  // Toggle internal log
  const toggleInternalLog = useCallback(
    (key: string) => {
      setExpandedInternalLogs((prev) => {
        const nextValue = !Boolean(prev[key]);
        const next = { ...prev, [key]: nextValue };
        const meetingKey = buildExpandedStorageKey(currentMeetingId);
        setExpandedInternalLogsCache((cachePrev) => {
          const meetingMap = { ...(cachePrev[meetingKey] ?? {}), [key]: nextValue };
          return { ...cachePrev, [meetingKey]: meetingMap };
        });
        return next;
      });
    },
    [currentMeetingId, setExpandedInternalLogs]
  );

  // Append phase log. Replayed events (re-sent from the server buffer on
  // reconnect) are skipped when an identical phase marker is already shown.
  const appendPhaseLog = useCallback(
    (title: string, description?: string | null, opts?: { replay?: boolean }) => {
      setLogs((prev) => {
        if (
          opts?.replay &&
          prev.some(
            (e) =>
              e.kind === "phase" &&
              e.title === title &&
              (e.description ?? undefined) === (description ?? undefined)
          )
        ) {
          return prev;
        }
        const next = [...prev, { kind: "phase" as const, title, description }];
        if (currentMeetingId) {
          setMeetingHistory((prevHistory) => ({
            ...prevHistory,
            [currentMeetingId]: next,
          }));
        }
        return next;
      });
    },
    [currentMeetingId, setLogs, setMeetingHistory]
  );

  // Merge invitation highlight into the last message from the inviter
  const appendInvitationMessage = useCallback(
    (title: string, description?: string | null, opts?: { replay?: boolean }) => {
      setLogs((prev) => {
        const fallbackSpeaker = findLastMessageEntry(prev)?.name;
        const parsed = parseInvitationPhasePayload(title, description, fallbackSpeaker);
        if (!parsed) {
          return prev;
        }
        if (
          opts?.replay &&
          prev.some(
            (e) =>
              e.kind === "message" &&
              normalizeNameForKey(e.name) === parsed.speaker &&
              (e as MessageOut).invitationHighlight === parsed.highlight
          )
        ) {
          return prev;
        }
        // Find the last message from the inviter
        const next = [...prev];
        // Find the index of the very last message entry
        let lastMsgIdx = -1;
        for (let j = next.length - 1; j >= 0; j--) {
          if (next[j].kind === "message") {
            lastMsgIdx = j;
            break;
          }
        }
        for (let i = next.length - 1; i >= 0; i--) {
          const entry = next[i];
          if (entry.kind === "message" && normalizeNameForKey(entry.name) === parsed.speaker) {
            if ((entry as MessageOut).routePlan || i < lastMsgIdx) {
              // Proposal message OR entry is not the latest message
              // — create a separate entry at the end so it appears after
              //   vote messages / phase markers that came after this entry.
              const lastMsg = findLastMessageEntry(next);
              next.push({
                kind: "message",
                name: entry.name,
                content: "",
                turn: lastMsg?.turn ?? (entry as MessageOut).turn,
                invitationHighlight: parsed.highlight,
                invitationMessage: parsed.reason,
              });
            } else {
              // Regular message and it's the latest — merge into it
              next[i] = { ...(entry as MessageOut), invitationHighlight: parsed.highlight, invitationMessage: parsed.reason };
            }
            break;
          }
        }
        if (currentMeetingId) {
          setMeetingHistory((prevHistory) => ({
            ...prevHistory,
            [currentMeetingId]: next,
          }));
        }
        return next;
      });
    },
    [currentMeetingId, setLogs, setMeetingHistory]
  );

  return {
    // State
    elapsedSeconds,
    setElapsedSeconds,
    nowSeconds,
    expandedInternalLogsCache,
    setExpandedInternalLogsCache,

    // Refs
    meetingStartRef,
    meetingResumeOffsetRef,

    // Callbacks
    tickElapsed,
    restoreExpandedLogs,
    resetLogsState,
    clearInternalStream,
    upsertMessage,
    upsertRoutePlan,
    upsertSearchSection,
    handleInternalEvent,
    toggleInternalLog,
    appendPhaseLog,
    appendInvitationMessage,
  };
}
