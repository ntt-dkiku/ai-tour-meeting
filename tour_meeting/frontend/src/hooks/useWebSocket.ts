import { useCallback, useRef } from "react";
import type { WsEvent, LogEntry, RoutePlan, SearchSection, InternalLogContext } from "../types";

export interface WebSocketCallbacks {
  // State setters
  setConnected: (connected: boolean) => void;
  setStatus: (status: string | ((prev: string) => string)) => void;
  setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  setWaitingForUser: (waiting: boolean) => void;
  setWaitingForVote: (waiting: boolean) => void;
  setVotingData: (data: any) => void;
  setNeedModification: (need: boolean) => void;
  setConsensusVoteSelections: (selections: any) => void;
  setRouteVoteSelections: (selections: any) => void;
  setMeetings: React.Dispatch<React.SetStateAction<any[]>>;
  setMeetingHistory: React.Dispatch<React.SetStateAction<Record<string, LogEntry[]>>>;
  setStartedMeetings: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setElapsedSeconds: (seconds: number) => void;

  // Action callbacks
  loadMeetings: () => Promise<void>;
  upsertMessage: (turn: number, speaker: string, append?: string, finalText?: string, routePlan?: RoutePlan, internalContext?: InternalLogContext, maxSteps?: number, score?: number) => void;
  appendPhaseLog: (title: string, description?: string) => void;
  appendInvitationMessage: (title: string, description?: string) => void;
  upsertRoutePlan: (turn: number, speaker: string, routePlan: RoutePlan) => void;
  upsertSearchSection: (turn: number, speaker: string, section: SearchSection) => void;
  handleInternalEvent: (turn: number, speaker: string, event: any) => void;
  clearInternalStream: (key: string) => void;
  resetLogsState: (options?: { clearCache?: boolean }) => void;
  restoreExpandedLogs: (meetingId: string) => void;
  tickElapsed: () => void;
  buildInternalKey: (turn: number, speaker: string) => string;
}

export interface UseWebSocketOptions {
  apiBase: string;
  currentMeetingId: string | null;
  meetings: any[];
  meetingHistory: Record<string, LogEntry[]>;
  globalGoals: string;
  maxTurns: number;
  timeLimit: string;
  elapsedSeconds: number;
  callbacks: WebSocketCallbacks;
  meetingStartRef: React.MutableRefObject<Record<string, number>>;
  meetingResumeOffsetRef: React.MutableRefObject<Record<string, number>>;
  invitationPhaseTitles: Set<string>;
}

export interface UseWebSocketReturn {
  wsRef: React.MutableRefObject<WebSocket | null>;
  manualDisconnectRef: React.MutableRefObject<boolean>;
  startMeetingWS: () => Promise<void>;
  stopMeeting: () => void;
  sendUserMessage: (message: string, needModification: boolean) => void;
  sendUserVote: (voteData: any) => void;
}

export function useWebSocket({
  apiBase,
  currentMeetingId,
  meetings,
  meetingHistory,
  globalGoals,
  maxTurns,
  timeLimit,
  elapsedSeconds,
  callbacks,
  meetingStartRef,
  meetingResumeOffsetRef,
  invitationPhaseTitles,
}: UseWebSocketOptions): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const manualDisconnectRef = useRef<boolean>(false);

  const {
    setConnected,
    setStatus,
    setLogs,
    setWaitingForUser,
    setWaitingForVote,
    setVotingData,
    setNeedModification,
    setConsensusVoteSelections,
    setRouteVoteSelections,
    setMeetings,
    setMeetingHistory,
    setStartedMeetings,
    setElapsedSeconds,
    loadMeetings,
    upsertMessage,
    appendPhaseLog,
    appendInvitationMessage,
    upsertRoutePlan,
    handleInternalEvent,
    clearInternalStream,
    resetLogsState,
    restoreExpandedLogs,
    tickElapsed,
    buildInternalKey,
  } = callbacks;

  // Build WebSocket URL
  const wsUrl = currentMeetingId
    ? `${apiBase.replace(/^http/, "ws").replace(/\/+$/, "")}/ws/meeting/${currentMeetingId}`
    : "";

  const startMeetingWS = useCallback(async () => {
    if (!currentMeetingId || !wsUrl) return;

    if (wsRef.current) {
      manualDisconnectRef.current = true;
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    manualDisconnectRef.current = false;

    const currentMeta = meetings.find((m) => m.id === currentMeetingId);
    const metaStatus = (currentMeta?.status ?? "").toLowerCase();
    const shouldWatch = ["running", "stopping"].includes(metaStatus);
    const isResume = metaStatus === "stopped";
    const isFreshStart = !shouldWatch && !isResume;

    const cachedLogs = meetingHistory[currentMeetingId];
    if ((shouldWatch || isResume) && cachedLogs) {
      setLogs(cachedLogs);
      restoreExpandedLogs(currentMeetingId);
    } else {
      resetLogsState({ clearCache: true });
      if (currentMeetingId) {
        setMeetingHistory((prev) => ({ ...prev, [currentMeetingId]: [] }));
      }
    }

    setStatus("connecting");
    setStartedMeetings((prev) => ({
      ...prev,
      [currentMeetingId]: true,
    }));

    if (currentMeetingId) {
      if (!shouldWatch) {
        const hasStoredOffset = Object.prototype.hasOwnProperty.call(
          meetingResumeOffsetRef.current,
          currentMeetingId
        );
        const resumeOffset = hasStoredOffset
          ? meetingResumeOffsetRef.current[currentMeetingId]
          : isFreshStart
          ? 0
          : elapsedSeconds;
        meetingStartRef.current[currentMeetingId] =
          Math.floor(Date.now() / 1000) - resumeOffset;
        delete meetingResumeOffsetRef.current[currentMeetingId];
        setElapsedSeconds(resumeOffset);
      } else if (meetingStartRef.current[currentMeetingId]) {
        tickElapsed();
      }
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      manualDisconnectRef.current = false;
      const payload: any = shouldWatch
        ? { cmd: "watch" }
        : {
            cmd: "start",
            goal: globalGoals,
            max_turns: maxTurns,
          };
      if (!shouldWatch && timeLimit.trim().length > 0) {
        const asInt = parseInt(timeLimit, 10);
        if (!Number.isNaN(asInt)) payload.time_limit = asInt;
      }
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsEvent & {
          meeting_id?: string;
          status?: string;
          reason?: string | null;
          elapsed?: number;
        };

        const targetMeetingId = data.meeting_id ?? currentMeetingId;

        switch (data.type) {
          case "status": {
            if (targetMeetingId) {
              setMeetings((prev) =>
                prev.map((m) =>
                  m.id === targetMeetingId
                    ? {
                        ...m,
                        status: data.status ?? m.status,
                        status_detail:
                          data.reason !== undefined ? data.reason : m.status_detail,
                      }
                    : m
                )
              );
              if (data.status && data.status !== "idle") {
                setStartedMeetings((prev) => ({
                  ...prev,
                  [targetMeetingId]: true,
                }));
              }
              // Handle elapsed time updates based on status
              if (data.status && ["running", "stopping"].includes(data.status.toLowerCase()) && typeof data.elapsed === "number") {
                meetingStartRef.current[targetMeetingId] = Math.floor(Date.now() / 1000) - data.elapsed;
                delete meetingResumeOffsetRef.current[targetMeetingId];
                if (targetMeetingId === currentMeetingId) {
                  tickElapsed();
                }
              } else if (data.status && ["stopped", "finished", "timeout"].includes(data.status.toLowerCase())) {
                const calculatedElapsed = typeof data.elapsed === "number"
                  ? data.elapsed
                  : (() => {
                      const startedAt = meetingStartRef.current[targetMeetingId];
                      if (startedAt) return Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
                      const storedOffset = meetingResumeOffsetRef.current[targetMeetingId];
                      return typeof storedOffset === "number" ? storedOffset : 0;
                    })();
                meetingResumeOffsetRef.current[targetMeetingId] = calculatedElapsed;
                delete meetingStartRef.current[targetMeetingId];
                if (targetMeetingId === currentMeetingId) {
                  setElapsedSeconds(calculatedElapsed);
                }
              }
            }
            if (targetMeetingId === currentMeetingId && data.status) {
              if (data.status === "running") {
                setStatus("running");
                if (typeof data.elapsed === "number") setElapsedSeconds(data.elapsed);
              } else if (data.status === "stopping") {
                setStatus("stopping");
                if (typeof data.elapsed === "number") setElapsedSeconds(data.elapsed);
              } else if (data.status === "stopped") {
                setStatus("stopped");
                if (typeof data.elapsed === "number") setElapsedSeconds(data.elapsed);
                setWaitingForUser(false);
              } else if (data.status === "finished") {
                setStatus("finished");
                if (typeof data.elapsed === "number") setElapsedSeconds(data.elapsed);
                setWaitingForUser(false);
              } else if (data.status === "timeout") {
                setStatus("timeout");
                if (typeof data.elapsed === "number") setElapsedSeconds(data.elapsed);
                setWaitingForUser(false);
              } else if (data.status === "error") {
                setStatus(data.reason ? `error: ${data.reason}` : "error");
                setWaitingForUser(false);
              }
            }
            loadMeetings();
            break;
          }
          case "meeting_started": {
            if (currentMeetingId) {
              setStartedMeetings((prev) => ({
                ...prev,
                [currentMeetingId]: true,
              }));
              setMeetings((prev) =>
                prev.map((m) =>
                  m.id === currentMeetingId
                    ? { ...m, status: "running", status_detail: null }
                    : m
                )
              );
            }
            setStatus("running");
            if (isFreshStart) {
              resetLogsState({ clearCache: true });
              if (currentMeetingId) {
                setMeetingHistory((prev) => ({ ...prev, [currentMeetingId]: [] }));
                meetingStartRef.current[currentMeetingId] = Math.floor(Date.now() / 1000);
                delete meetingResumeOffsetRef.current[currentMeetingId];
                setElapsedSeconds(0);
              }
            } else if (currentMeetingId) {
              const hasStoredOffset = Object.prototype.hasOwnProperty.call(
                meetingResumeOffsetRef.current,
                currentMeetingId
              );
              const resumeOffset = hasStoredOffset
                ? meetingResumeOffsetRef.current[currentMeetingId]
                : elapsedSeconds;
              meetingStartRef.current[currentMeetingId] = Math.floor(Date.now() / 1000) - resumeOffset;
              delete meetingResumeOffsetRef.current[currentMeetingId];
              setElapsedSeconds(resumeOffset);
            }
            break;
          }
          case "turn_start": {
            upsertMessage(data.turn, data.speaker);
            break;
          }
          case "delta": {
            const metadata = data.metadata;
            if (metadata?.internal_event) {
              handleInternalEvent(data.turn, data.speaker, metadata.internal_event);
            }
            if (metadata?.search_start) {
              upsertSearchSection(data.turn, data.speaker, {
                query: metadata.search_start.query,
                searching: true,
              });
            }
            if (metadata?.search_complete) {
              upsertSearchSection(data.turn, data.speaker, {
                query: metadata.search_complete.query,
                result: metadata.search_complete.result,
                searching: false,
              });
            }
            if (data.delta) {
              upsertMessage(data.turn, data.speaker, data.delta);
            }
            break;
          }
          case "retry_notification": {
            setLogs((prev) => {
              const idx = prev.findIndex(
                (m) => m.kind === "message" && m.turn === data.turn && m.name === data.speaker
              );
              if (idx !== -1 && prev[idx].kind === "message") {
                const next = [...prev];
                next[idx] = {
                  ...prev[idx],
                  content: "",
                  retryInfo: {
                    attempt: data.attempt,
                    maxAttempts: data.max_attempts,
                    errorMessage: data.error_message,
                  },
                } as any;
                return next;
              }
              return prev;
            });
            break;
          }
          case "route_plan_update": {
            if (data.route_plan) {
              upsertRoutePlan(data.turn, data.speaker, data.route_plan);
            }
            break;
          }
          case "ask_pending": {
            setLogs((prev) => {
              // Avoid duplicate pending cards if the event is seen twice.
              const exists = prev.some(
                (m) =>
                  m.kind === "ask_exchange" &&
                  m.turn === data.turn &&
                  m.asker === data.asker &&
                  m.question === data.question
              );
              if (exists) return prev;
              return [
                ...prev,
                {
                  kind: "ask_exchange" as const,
                  turn: data.turn,
                  asker: data.asker,
                  target: data.target,
                  question: data.question,
                  response: "",
                  pending: true,
                },
              ];
            });
            break;
          }
          case "ask_exchange": {
            setLogs((prev) => {
              // Fill in the answer on the pending card created by ask_pending.
              const idx = prev.findIndex(
                (m) =>
                  m.kind === "ask_exchange" &&
                  m.turn === data.turn &&
                  m.asker === data.asker &&
                  m.question === data.question
              );
              const filled = {
                kind: "ask_exchange" as const,
                turn: data.turn,
                asker: data.asker,
                target: data.target,
                question: data.question,
                response: data.response,
                pending: false,
              };
              if (idx !== -1) {
                const next = [...prev];
                next[idx] = filled;
                return next;
              }
              return [...prev, filled];
            });
            break;
          }
          case "proposal_vote_result": {
            const accepted = data.accepted;
            setLogs((prev) => [
              ...prev,
              {
                kind: "proposal_vote_result" as const,
                turn: data.turn,
                proposer: data.proposer,
                accepted,
                voteSummary: data.vote_summary,
              },
            ]);
            break;
          }
          case "satisfied_update": {
            setLogs((prev) => [
              ...prev,
              {
                kind: "satisfied_update" as const,
                turn: data.turn,
                speaker: data.speaker,
                satisfied: data.satisfied,
                satisfiedCount: data.satisfied_count,
                totalCount: data.total_count,
              },
            ]);
            break;
          }
          case "round_end": {
            setLogs((prev) => [
              ...prev,
              {
                kind: "round_end" as const,
                roundNumber: data.round_number,
              },
            ]);
            break;
          }
          case "turn_final": {
            const internalContext: InternalLogContext | undefined =
              data.steps_log || data.steps_label
                ? {
                    log: data.steps_log,
                    taskLabel: data.steps_label,
                    replaceLog: true,
                  }
                : undefined;
            const rawScore = (data as any).score;
            const parsedScore =
              typeof rawScore === "number" && Number.isFinite(rawScore)
                ? rawScore
                : typeof rawScore === "string" &&
                  rawScore.trim() !== "" &&
                  Number.isFinite(Number(rawScore))
                ? Number(rawScore)
                : undefined;
            upsertMessage(
              data.turn,
              data.speaker,
              undefined,
              data.text,
              data.route_plan,
              internalContext,
              data.max_steps,
              parsedScore
            );
            const key = buildInternalKey(data.turn, data.speaker);
            clearInternalStream(key);
            break;
          }
          case "phase_message": {
            if (invitationPhaseTitles.has(data.title)) {
              appendInvitationMessage(data.title, data.description ?? undefined);
            } else {
              appendPhaseLog(data.title, data.description ?? undefined);
            }
            break;
          }
          case "deadlock_intervention": {
            appendPhaseLog("Deadlock Intervention", data.message ?? undefined);
            break;
          }
          case "human_turn": {
            setWaitingForUser(true);
            setNeedModification(false);
            break;
          }
          case "human_vote": {
            setWaitingForVote(true);
            setVotingData({
              vote_type: data.vote_type,
              options: data.options,
              turn: data.turn,
            });
            setConsensusVoteSelections({ approved: [], rejected: [], scores: [], message: "" });
            setRouteVoteSelections({ route_id: null, scores: [], message: "" });
            break;
          }
          case "timeout": {
            setStatus("timeout");
            setWaitingForUser(false);
            setWaitingForVote(false);
            if (currentMeetingId) {
              const startedAt = meetingStartRef.current[currentMeetingId];
              const storedOffset = meetingResumeOffsetRef.current[currentMeetingId];
              const finalElapsed = typeof storedOffset === "number"
                ? storedOffset
                : startedAt
                ? Math.max(0, Math.floor(Date.now() / 1000) - startedAt)
                : elapsedSeconds;
              meetingResumeOffsetRef.current[currentMeetingId] = finalElapsed;
              delete meetingStartRef.current[currentMeetingId];
              setElapsedSeconds(finalElapsed);
              setMeetings((prev) =>
                prev.map((m) =>
                  m.id === currentMeetingId ? { ...m, status: "timeout", status_detail: null } : m
                )
              );
            }
            loadMeetings();
            break;
          }
          case "meeting_finished": {
            setStatus("finished");
            setWaitingForUser(false);
            if (currentMeetingId) {
              const startedAt = meetingStartRef.current[currentMeetingId];
              const storedOffset = meetingResumeOffsetRef.current[currentMeetingId];
              const finalElapsed = typeof storedOffset === "number"
                ? storedOffset
                : startedAt
                ? Math.max(0, Math.floor(Date.now() / 1000) - startedAt)
                : elapsedSeconds;
              setMeetings((prev) =>
                prev.map((m) =>
                  m.id === currentMeetingId ? { ...m, status: "finished", status_detail: null } : m
                )
              );
              meetingResumeOffsetRef.current[currentMeetingId] = finalElapsed;
              delete meetingStartRef.current[currentMeetingId];
              setElapsedSeconds(finalElapsed);
            }
            loadMeetings();
            break;
          }
          case "stream_closed": {
            setConnected(false);
            wsRef.current = null;
            manualDisconnectRef.current = false;
            if (targetMeetingId) {
              const startedAt = meetingStartRef.current[targetMeetingId];
              if (startedAt) {
                const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
                meetingResumeOffsetRef.current[targetMeetingId] = elapsed;
                delete meetingStartRef.current[targetMeetingId];
                if (targetMeetingId === currentMeetingId) {
                  setElapsedSeconds(elapsed);
                }
              } else if (
                typeof meetingResumeOffsetRef.current[targetMeetingId] === "number" &&
                targetMeetingId === currentMeetingId
              ) {
                setElapsedSeconds(meetingResumeOffsetRef.current[targetMeetingId]);
              }
            }
            loadMeetings();
            break;
          }
          case "error": {
            setStatus(`error: ${data.message}`);
            break;
          }
          default:
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      setStatus((prev: string) => {
        if (["finished", "timeout", "stopped", "stopping"].includes(prev)) {
          return prev;
        }
        if (manualDisconnectRef.current) {
          return "detached";
        }
        return "closed";
      });
      manualDisconnectRef.current = false;
      setWaitingForUser(false);
      loadMeetings();
    };
  }, [
    currentMeetingId,
    wsUrl,
    meetings,
    meetingHistory,
    globalGoals,
    maxTurns,
    timeLimit,
    elapsedSeconds,
    setConnected,
    setStatus,
    setLogs,
    setWaitingForUser,
    setWaitingForVote,
    setVotingData,
    setNeedModification,
    setConsensusVoteSelections,
    setRouteVoteSelections,
    setMeetings,
    setMeetingHistory,
    setStartedMeetings,
    setElapsedSeconds,
    loadMeetings,
    upsertMessage,
    appendPhaseLog,
    appendInvitationMessage,
    upsertRoutePlan,
    handleInternalEvent,
    clearInternalStream,
    resetLogsState,
    restoreExpandedLogs,
    tickElapsed,
    buildInternalKey,
    meetingStartRef,
    meetingResumeOffsetRef,
    invitationPhaseTitles,
  ]);

  const stopMeeting = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: "stop" }));
      manualDisconnectRef.current = true;
      try {
        ws.close();
      } catch {}
    }
    wsRef.current = null;
  }, []);

  const sendUserMessage = useCallback((message: string, needMod: boolean) => {
    const ws = wsRef.current;
    if (!ws) return;

    ws.send(JSON.stringify({
      cmd: "message",
      message: {
        message: message,
        need_modification: needMod,
      },
    }));
  }, []);

  const sendUserVote = useCallback((voteData: any) => {
    const ws = wsRef.current;
    if (!ws) return;

    ws.send(JSON.stringify({ cmd: "vote", vote_data: voteData }));
  }, []);

  return {
    wsRef,
    manualDisconnectRef,
    startMeetingWS,
    stopMeeting,
    sendUserMessage,
    sendUserVote,
  };
}
