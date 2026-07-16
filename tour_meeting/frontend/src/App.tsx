import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { YOU_ID as DND_YOU_ID } from "./components/DnDParticipants";
import ContextMenu from "./components/ContextMenu";
import ApiSettingsModal from "./components/ApiSettingsModal";
import Sidebar from "./components/Sidebar";
import ParticipantModal from "./components/settings/ParticipantModal";
import HumanModal from "./components/settings/HumanModal";
import EmptyState from "./components/EmptyState";
import SettingsView from "./components/views/SettingsView";
import MeetingView from "./components/views/MeetingView";
import StatisticsView from "./components/views/StatisticsView";
import { useChatState } from "./hooks/useChatState";
import { useApiKeys } from "./hooks/useApiKeys";
import { useParticipants, participantKey } from "./hooks/useParticipants";
import { useMeetingLogs } from "./hooks/useMeetingLogs";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { useIntegrations } from "./hooks/useIntegrations";
import { useMeetingContext, type MeetingSettingsCache } from "./context/MeetingContext";

// Import types
import type {
  ParticipantIn,
  MeetingInfo,
  MeetingSettingsFile,
  MeetingHistory,
  RoutePlan,
  InternalLogContext,
  MessageOut,
  LogEntry,
  WsEvent,
  ContextMenuState,
} from "./types";

// Import constants
import {
  DEFAULT_GLOBAL_GOAL,
  createDefaultParticipantForm,
  TURN_RULE_OPTIONS,
  VOTE_TURN_RULE_OPTIONS,
  VOTING_RULE_OPTIONS,
  INVITATION_PHASE_TITLES,
  MEETING_HISTORY_STORAGE_KEY,
  STATUS_STYLES,
  COMMERCIAL_MODELS,
  buildModelOptionGroups,
} from "./constants";

// Import utilities
import {
  normalizeNameForKey,
  buildInternalKey,
  isMessageEntry,
  findLastMessageEntry,
  countMessagesWithTurn,
  parseInvitationPhasePayload,
} from "./utils/helpers";
import {
  toNumber,
} from "./utils/parsing";
import { mergeMeetingData } from "./utils/meetingSync";

const normalizeBalancedTurns = (rule: string, value: boolean) =>
  rule === "round_robin" ? true : value;

export default function App() {
  const [apiBase] = useState<string>(
    import.meta.env.VITE_API_BASE || "http://localhost:8080"
  );
  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [currentMeetingId, setCurrentMeetingId] = useState<string | null>(null);
  const [meetingTitle, setMeetingTitle] = useState<string>("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [meetingHistory, setMeetingHistory] = useLocalStorage<MeetingHistory>(
    MEETING_HISTORY_STORAGE_KEY,
    {}
  );
  const [isEditingTitle, setIsEditingTitle] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  // Chat state from custom hook
  const {
    logs, setLogs,
    connected, setConnected,
    status, setStatus,
    userMessage, setUserMessage,
    needModification, setNeedModification,
    waitingForUser, setWaitingForUser,
    humanTurnData, setHumanTurnData,
    waitingForVote, setWaitingForVote,
    votingData, setVotingData,
    waitingForSelect, setWaitingForSelect,
    selectSpeakerData, setSelectSpeakerData,
    waitingForAskAnswer, setWaitingForAskAnswer,
    askAnswerData, setAskAnswerData,
    expandedInternalLogs, setExpandedInternalLogs,
    expandedObservations, setExpandedObservations,
    consensusVoteSelections, setConsensusVoteSelections,
    routeVoteSelections, setRouteVoteSelections,
    resetChatState,
    wsRef,
  } = useChatState();

  // Participants state from custom hook
  const {
    participants, setParticipants,
    order, setOrder,
    includeHuman, setIncludeHuman,
    humanName, setHumanName,
    humanAvatar, setHumanAvatar,
    humanRole, setHumanRole,
    form, setForm,
    editingParticipant, setEditingParticipant,
    participantError, setParticipantError,
    showModal, setShowModal,
    isDragOverParticipants,
    setIsDragOverParticipants,
    refreshParticipants,
    addParticipant,
    deleteParticipant,
    duplicateParticipant,
    removeAllParticipants,
    downloadParticipants,
    openEditParticipant,
    updateIncludeHuman,
    updateHumanProfile,
    handleParticipantsDragOver,
    handleParticipantsDragLeave,
    handleParticipantsDrop,
    closeModal,
    openAddModal,
  } = useParticipants({ apiBase, currentMeetingId });

  const [startedMeetings, setStartedMeetings] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<"settings" | "meeting" | "statistics">("settings");
  const [showHumanModal, setShowHumanModal] = useState(false);

  // Meeting logs state from custom hook
  const {
    elapsedSeconds,
    setElapsedSeconds,
    nowSeconds,
    meetingStartRef,
    meetingResumeOffsetRef,
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
  } = useMeetingLogs({
    currentMeetingId,
    logs,
    setLogs,
    meetingHistory,
    setMeetingHistory,
    expandedInternalLogs,
    setExpandedInternalLogs,
    meetings,
    status,
  });

  // Get settings from context
  const { settings, updateSetting, settingsCacheRef } = useMeetingContext();

  // Destructure settings values
  const {
    globalGoals,
    maxTurns,
    timeLimit,
    travelDate,
    timeWindowStart,
    timeWindowEnd,
    budget,
    turnRule,
    draftVotingRule,
    volunteerMode,
    balancedTurns,
    voteTurnRule,
    voteSettingsLinked,
    singleDecider,
  } = settings;

  const [isGeneratingSample, setIsGeneratingSample] = useState<boolean>(false);
  const [randomSampleError, setRandomSampleError] = useState<string | null>(null);

  // API Key management
  const {
    showApiSettings,
    setShowApiSettings,
    apiKeyStatus,
    apiKeyInputs,
    apiKeyMessages,
    apiKeyLoading,
    setApiKeyInputs,
    handleApiKeySave,
  } = useApiKeys(apiBase);

  const { integrations, ollamaModels, ollamaLoading, refreshIntegrations } = useIntegrations(apiBase);

  // Models offered by the human's "Generate with AI" route-draft dialog: the
  // same list as the participant "Model" dropdown, defaulting to the first
  // commercial model (gpt-5.4-mini).
  const draftModelGroups = useMemo(
    () => buildModelOptionGroups(integrations, ollamaModels),
    [integrations, ollamaModels]
  );
  const defaultDraftModel = COMMERCIAL_MODELS[0];

  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const manualDisconnectRef = useRef<boolean>(false);
  // Which meeting the current wsRef socket belongs to. Used to drop events
  // from stale sockets and to close orphaned sockets when the user switches
  // meetings, so chat logs never mix across simultaneously running meetings.
  const wsMeetingIdRef = useRef<string | null>(null);
  const goalCacheRef = useRef<Record<string, string>>({});
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [showScrollButton, setShowScrollButton] = useState<boolean>(false);

type RouteScrollState = { pos: number; auto: boolean };
const routeScrollPositionsRef = useRef<Record<string, RouteScrollState>>({});

const YOU_ID = "__YOU__";
const [isDragOverSettings, setIsDragOverSettings] = useState<boolean>(false);

const ensureSettingsCache = useCallback((meetingId: string): MeetingSettingsCache => {
  const existing = settingsCacheRef.current[meetingId];
  if (existing) {
    return existing;
  }
  const created: MeetingSettingsCache = {
    maxTurns,
    timeLimit: (timeLimit || "").trim(),
    travelDate: (travelDate || "").trim(),
    timeWindowStart: (timeWindowStart || "").trim(),
    timeWindowEnd: (timeWindowEnd || "").trim(),
    budget: (budget || "").trim(),
    turnRule,
    votingRule: draftVotingRule,
    volunteerMode,
    balancedTurns: normalizeBalancedTurns(turnRule, balancedTurns),
    voteTurnRule,
    voteSettingsLinked,
    singleDecider,
  };
  settingsCacheRef.current[meetingId] = created;
  return created;
}, [maxTurns, timeLimit, travelDate, timeWindowStart, timeWindowEnd, budget, turnRule, draftVotingRule, volunteerMode, balancedTurns, voteTurnRule, voteSettingsLinked, singleDecider]);

  // meeting 切替時に順序取得
  useEffect(() => {
    if (!currentMeetingId) return;
    fetch(`${apiBase}/meetings/${currentMeetingId}/order`)
      .then(r => r.json())
      .then((o: string[]) => setOrder(o))
      .catch(() => {
        // fallback：現状から推定
        const base = participants.map(participantKey);
        setOrder(includeHuman ? [...base, YOU_ID] : base);
      });
  }, [apiBase, currentMeetingId]); // participants/includeHuman は別で入れ替わるので後で整合取る

  useEffect(() => {
    setOrder(prev => {
      const ids = new Set(participants.map(participantKey));
      let next = prev.filter(x => x === YOU_ID || ids.has(x));
      // 人のON/OFF反映
      if (includeHuman) {
        if (!next.includes(YOU_ID)) next.push(YOU_ID); // 末尾に
      } else {
        next = next.filter(x => x !== YOU_ID);
      }
      // 漏れた参加者を末尾に足す（APIと整合）
      participants.forEach(p => { if (!next.includes(participantKey(p))) next.push(participantKey(p)); });
      return next;
    });
  }, [participants, includeHuman]);

  useEffect(() => {
    if (!currentMeetingId) return;
    const cached = ensureSettingsCache(currentMeetingId);
    if (cached) {
      const cachedTurnRule = cached.turnRule ?? "round_robin";
      updateSetting('maxTurns', cached.maxTurns);
      updateSetting('timeLimit', cached.timeLimit);
      updateSetting('turnRule', cachedTurnRule);
      updateSetting('draftVotingRule', cached.votingRule ?? "majority");
      updateSetting('volunteerMode', cached.volunteerMode ?? false);
      updateSetting('balancedTurns', normalizeBalancedTurns(cachedTurnRule, cached.balancedTurns ?? true));
      updateSetting('voteTurnRule', cached.voteTurnRule ?? "round_robin");
      updateSetting('voteSettingsLinked', cached.voteSettingsLinked ?? true);
      updateSetting('singleDecider', cached.singleDecider ?? "");
    } else {
      updateSetting('maxTurns', 4);
      updateSetting('timeLimit', "");
      updateSetting('turnRule', "round_robin");
      updateSetting('draftVotingRule', "majority");
      updateSetting('volunteerMode', false);
      updateSetting('balancedTurns', true);
      updateSetting('voteTurnRule', "round_robin");
      updateSetting('voteSettingsLinked', true);
      updateSetting('singleDecider', "");
    }
  }, [currentMeetingId, updateSetting]);

  useEffect(() => {
    if (!currentMeetingId) return;

    const cached = goalCacheRef.current[currentMeetingId];
    if (typeof cached === "string") {
      updateSetting('globalGoals', cached);
    } else {
      updateSetting('globalGoals', DEFAULT_GLOBAL_GOAL);
    }

    let aborted = false;
    fetch(`${apiBase}/meetings/${currentMeetingId}/goal`)
      .then((res) => res.json())
      .then((data: { goal?: string }) => {
        if (aborted) return;
        const goal =
          typeof data.goal === "string" && data.goal.trim().length > 0
            ? data.goal
            : DEFAULT_GLOBAL_GOAL;
        goalCacheRef.current[currentMeetingId] = goal;
        updateSetting('globalGoals', goal);
      })
      .catch(() => {
        if (aborted) return;
        goalCacheRef.current[currentMeetingId] = DEFAULT_GLOBAL_GOAL;
        updateSetting('globalGoals', DEFAULT_GLOBAL_GOAL);
      });

    return () => {
      aborted = true;
    };
  }, [apiBase, currentMeetingId, updateSetting]);

  useEffect(() => {
    if (!currentMeetingId) return;
    if (goalCacheRef.current[currentMeetingId] === globalGoals) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}/goal`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: globalGoals }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Failed to save goal: ${res.status}`);
          }
          return res.json() as Promise<{ goal?: string }>;
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          const saved =
            typeof data.goal === "string" && data.goal.trim().length > 0
              ? data.goal
              : globalGoals;
          goalCacheRef.current[currentMeetingId] = saved;
        })
        .catch(() => {});
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, globalGoals]);

  useEffect(() => {
    if (!currentMeetingId) return;
    if (!Number.isFinite(maxTurns) || maxTurns <= 0) return;

    const normalizedMaxTurns = Math.max(1, Math.floor(maxTurns));
    const trimmedTime = timeLimit.trim();
    let normalizedTimeLimit: number | null = null;
    let normalizedTimeString = "";

    if (trimmedTime.length > 0) {
      const parsed = parseInt(trimmedTime, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        normalizedTimeLimit = parsed;
        normalizedTimeString = String(parsed);
      } else {
        return;
      }
    }

    const cached = ensureSettingsCache(currentMeetingId);
    if (
      cached &&
      cached.maxTurns === normalizedMaxTurns &&
      cached.timeLimit === normalizedTimeString
    ) {
      return;
    }

    const cachedTurnRule = cached?.turnRule ?? turnRule;
    const cachedVotingRule = cached?.votingRule ?? draftVotingRule;
    settingsCacheRef.current[currentMeetingId] = {
      maxTurns: normalizedMaxTurns,
      timeLimit: normalizedTimeString,
      travelDate: cached?.travelDate ?? travelDate.trim(),
      timeWindowStart: cached?.timeWindowStart ?? timeWindowStart.trim(),
      timeWindowEnd: cached?.timeWindowEnd ?? timeWindowEnd.trim(),
      budget: cached?.budget ?? budget.trim(),
      turnRule: cachedTurnRule,
      votingRule: cachedVotingRule,
      volunteerMode: cached?.volunteerMode ?? volunteerMode,
      balancedTurns: normalizeBalancedTurns(turnRule, cached?.balancedTurns ?? balancedTurns),
      voteTurnRule: cached?.voteTurnRule ?? voteTurnRule,
      voteSettingsLinked: cached?.voteSettingsLinked ?? voteSettingsLinked,
    };

    const controller = new AbortController();
    const payload: { max_turns: number; time_limit?: number | null } = {
      max_turns: normalizedMaxTurns,
    };
    if (trimmedTime.length === 0) {
      payload.time_limit = null;
    } else if (normalizedTimeLimit !== null) {
      payload.time_limit = normalizedTimeLimit;
    }

    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Failed to save limits: ${res.status}`);
          }
          return res.json() as Promise<{ max_turns?: number; time_limit?: number | null }>;
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          const savedMax =
            typeof data.max_turns === "number" &&
            Number.isFinite(data.max_turns) &&
            data.max_turns > 0
              ? Math.floor(data.max_turns)
              : normalizedMaxTurns;
          const savedTime =
            typeof data.time_limit === "number" &&
            Number.isFinite(data.time_limit) &&
            data.time_limit > 0
              ? Math.floor(data.time_limit)
              : null;
          const savedTimeString = savedTime !== null ? String(savedTime) : "";
          const nextTimeString =
            savedTimeString === "" && normalizedTimeString !== ""
              ? normalizedTimeString
              : savedTimeString;

          settingsCacheRef.current[currentMeetingId] = {
            maxTurns: savedMax,
            timeLimit: nextTimeString,
            travelDate: cached?.travelDate ?? travelDate.trim(),
            timeWindowStart: cached?.timeWindowStart ?? timeWindowStart.trim(),
            timeWindowEnd: cached?.timeWindowEnd ?? timeWindowEnd.trim(),
            budget: cached?.budget ?? budget.trim(),
            turnRule: cachedTurnRule,
            votingRule: cachedVotingRule,
            volunteerMode: cached?.volunteerMode ?? volunteerMode,
            balancedTurns: normalizeBalancedTurns(cachedTurnRule, cached?.balancedTurns ?? balancedTurns),
            voteTurnRule: cached?.voteTurnRule ?? voteTurnRule,
            voteSettingsLinked: cached?.voteSettingsLinked ?? voteSettingsLinked,
          };

          if (savedMax !== normalizedMaxTurns) {
            updateSetting('maxTurns', savedMax);
          }
          if (nextTimeString !== timeLimit) {
            updateSetting('timeLimit', nextTimeString);
          }
        })
        .catch(() => {});
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, maxTurns, timeLimit]);

  useEffect(() => {
    if (!currentMeetingId) return;

    const cached = settingsCacheRef.current[currentMeetingId];
    const cachedTravelDate = cached?.travelDate ?? "";
    const cachedTimeWindowStart = cached?.timeWindowStart ?? "";
    const cachedTimeWindowEnd = cached?.timeWindowEnd ?? "";
    const cachedBudget = cached?.budget ?? "";

    const normalizedTravelDate = travelDate.trim();
    const normalizedTimeWindowStart = timeWindowStart.trim();
    const normalizedTimeWindowEnd = timeWindowEnd.trim();
    const normalizedBudget = budget.trim();

    if (
      cachedTravelDate === normalizedTravelDate &&
      cachedTimeWindowStart === normalizedTimeWindowStart &&
      cachedTimeWindowEnd === normalizedTimeWindowEnd &&
      cachedBudget === normalizedBudget
    ) {
      return;
    }

    // Update only the constraint fields in cache
    if (cached) {
      cached.travelDate = normalizedTravelDate;
      cached.timeWindowStart = normalizedTimeWindowStart;
      cached.timeWindowEnd = normalizedTimeWindowEnd;
      cached.budget = normalizedBudget;
    } else {
      // If cache doesn't exist yet, create it with constraint fields only
      // Other fields will be added when those respective useEffects run
      settingsCacheRef.current[currentMeetingId] = {
        maxTurns,
        timeLimit: timeLimit.trim(),
        travelDate: normalizedTravelDate,
        timeWindowStart: normalizedTimeWindowStart,
        timeWindowEnd: normalizedTimeWindowEnd,
        budget: normalizedBudget,
        turnRule,
        votingRule: draftVotingRule,
        volunteerMode,
        balancedTurns,
        voteTurnRule,
        voteSettingsLinked,
      };
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          travel_date: normalizedTravelDate || null,
          time_window_start: normalizedTimeWindowStart || null,
          time_window_end: normalizedTimeWindowEnd || null,
          budget: normalizedBudget || null,
        }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Failed to save constraints: ${res.status}`);
          }
        })
        .catch(() => {});
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, travelDate, timeWindowStart, timeWindowEnd, budget]);

  useEffect(() => {
    if (!currentMeetingId) return;
    if (!TURN_RULE_OPTIONS.some((opt) => opt.value === turnRule)) return;

    const cached = ensureSettingsCache(currentMeetingId);
    const cachedRule = cached?.turnRule ?? "round_robin";
    if (cachedRule === turnRule) return;

    const nextCache: MeetingSettingsCache = {
      maxTurns: cached?.maxTurns ?? maxTurns,
      timeLimit: cached?.timeLimit ?? timeLimit.trim(),
      travelDate: cached?.travelDate ?? travelDate.trim(),
      timeWindowStart: cached?.timeWindowStart ?? timeWindowStart.trim(),
      timeWindowEnd: cached?.timeWindowEnd ?? timeWindowEnd.trim(),
      budget: cached?.budget ?? budget.trim(),
      turnRule,
      votingRule: cached?.votingRule ?? draftVotingRule,
      volunteerMode: cached?.volunteerMode ?? volunteerMode,
      balancedTurns: normalizeBalancedTurns(turnRule, cached?.balancedTurns ?? balancedTurns),
      voteTurnRule: cached?.voteTurnRule ?? voteTurnRule,
      voteSettingsLinked: cached?.voteSettingsLinked ?? voteSettingsLinked,
    };
    settingsCacheRef.current[currentMeetingId] = nextCache;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initialization_turn_rule: turnRule,
          balanced_turns: normalizeBalancedTurns(turnRule, balancedTurns),
        }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Failed to update turn rule: ${res.status}`);
          }
          return res.json() as Promise<{ initialization_turn_rule?: string }>;
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          const savedRule =
            typeof data.initialization_turn_rule === "string" &&
            TURN_RULE_OPTIONS.some((opt) => opt.value === data.initialization_turn_rule)
              ? data.initialization_turn_rule
              : turnRule;
          settingsCacheRef.current[currentMeetingId] = {
            ...nextCache,
            turnRule: savedRule,
            balancedTurns: normalizeBalancedTurns(savedRule, nextCache.balancedTurns),
          };
          if (savedRule !== turnRule) {
            updateSetting('turnRule', savedRule);
          }
          if (savedRule === "round_robin" && !balancedTurns) {
            updateSetting('balancedTurns', true);
          }
        })
        .catch(() => {});
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, turnRule, maxTurns, timeLimit, balancedTurns]);

  useEffect(() => {
    if (!currentMeetingId) return;
    if (!VOTING_RULE_OPTIONS.some((opt) => opt.value === draftVotingRule)) return;

    const cached = settingsCacheRef.current[currentMeetingId];
    const cachedVoting = cached?.votingRule ?? "majority";
    if (cachedVoting === draftVotingRule) return;

    settingsCacheRef.current[currentMeetingId] = {
      maxTurns: cached?.maxTurns ?? maxTurns,
      timeLimit: cached?.timeLimit ?? timeLimit.trim(),
      travelDate: cached?.travelDate ?? travelDate.trim(),
      timeWindowStart: cached?.timeWindowStart ?? timeWindowStart.trim(),
      timeWindowEnd: cached?.timeWindowEnd ?? timeWindowEnd.trim(),
      budget: cached?.budget ?? budget.trim(),
      turnRule: cached?.turnRule ?? turnRule,
      votingRule: draftVotingRule,
      volunteerMode: cached?.volunteerMode ?? volunteerMode,
      balancedTurns: normalizeBalancedTurns(cached?.turnRule ?? turnRule, cached?.balancedTurns ?? balancedTurns),
      voteTurnRule: cached?.voteTurnRule ?? voteTurnRule,
      voteSettingsLinked: cached?.voteSettingsLinked ?? voteSettingsLinked,
    };

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initialization_voting_rule: draftVotingRule,
        }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Failed to update voting rule: ${res.status}`);
          }
          return res.json() as Promise<{
            initialization_voting_rule?: string;
          }>;
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          const savedVoting =
            typeof data.initialization_voting_rule === "string" &&
            VOTING_RULE_OPTIONS.some((opt) => opt.value === data.initialization_voting_rule)
              ? data.initialization_voting_rule
              : draftVotingRule;
          const currentCache = settingsCacheRef.current[currentMeetingId];
          settingsCacheRef.current[currentMeetingId] = {
            ...currentCache,
            votingRule: savedVoting,
          };
          if (savedVoting !== draftVotingRule) {
            updateSetting('draftVotingRule', savedVoting);
          }
        })
        .catch(() => {});
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, draftVotingRule, maxTurns, timeLimit, turnRule]);

  useEffect(() => {
    if (!currentMeetingId) return;

    const cached = settingsCacheRef.current[currentMeetingId];
    const cachedVolunteer = cached?.volunteerMode ?? false;
    if (cachedVolunteer === volunteerMode) return;

    if (cached) {
      settingsCacheRef.current[currentMeetingId] = { ...cached, volunteerMode };
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volunteer_mode: volunteerMode }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to update volunteer mode: ${res.status}`);
        })
        .catch(() => {});
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, volunteerMode]);

  useEffect(() => {
    if (!currentMeetingId) return;

    const cached = settingsCacheRef.current[currentMeetingId];
    const effectiveBalancedTurns = normalizeBalancedTurns(turnRule, balancedTurns);
    const cachedBalanced = cached?.balancedTurns ?? true;
    if (cachedBalanced === effectiveBalancedTurns) {
      if (turnRule === "round_robin" && !balancedTurns) {
        updateSetting('balancedTurns', true);
      }
      return;
    }

    if (cached) {
      settingsCacheRef.current[currentMeetingId] = { ...cached, balancedTurns: effectiveBalancedTurns };
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ balanced_turns: effectiveBalancedTurns }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to update balanced turns: ${res.status}`);
        })
        .catch(() => {});
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, balancedTurns, turnRule]);

  useEffect(() => {
    if (!currentMeetingId) return;

    const cached = settingsCacheRef.current[currentMeetingId];
    const cachedLinked = cached?.voteSettingsLinked ?? true;
    if (cachedLinked === voteSettingsLinked) return;

    if (cached) {
      settingsCacheRef.current[currentMeetingId] = { ...cached, voteSettingsLinked };
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      const payload: Record<string, unknown> = { vote_settings_linked: voteSettingsLinked };
      if (!voteSettingsLinked) {
        payload.vote_turn_rule = voteTurnRule;
      }
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to update vote settings linked: ${res.status}`);
        })
        .catch(() => {});
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, voteSettingsLinked]);

  useEffect(() => {
    if (!currentMeetingId) return;
    if (voteSettingsLinked) return; // Only sync when unlinked

    const cached = settingsCacheRef.current[currentMeetingId];
    const cachedVoteTurnRule = cached?.voteTurnRule ?? "round_robin";
    if (cachedVoteTurnRule === voteTurnRule) return;

    if (cached) {
      settingsCacheRef.current[currentMeetingId] = { ...cached, voteTurnRule };
    }

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vote_turn_rule: voteTurnRule }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`Failed to update vote turn rule: ${res.status}`);
        })
        .catch(() => {});
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, voteTurnRule, voteSettingsLinked]);

  // A meeting supports at most one facilitator across LLM participants and the
  // human. Instead of blocking role edits, we count them and surface a warning
  // (and block Start) until exactly one remains.
  const facilitatorCount = useMemo(() => {
    const llm = participants.filter(
      (p) => (p.role || "").toLowerCase() === "facilitator"
    ).length;
    const human = includeHuman && (humanRole || "").toLowerCase() === "facilitator" ? 1 : 0;
    return llm + human;
  }, [participants, includeHuman, humanRole]);

  const canStart = useMemo(
    () => {
      const minParticipants = includeHuman ? 1 : 2;
      const hasIncomplete = participants.some(p => p.incomplete);
      return participants.length >= minParticipants && globalGoals.trim().length > 0 && !connected && !hasIncomplete && facilitatorCount <= 1;
    },
    [participants, globalGoals, connected, includeHuman, facilitatorCount]
  );

  const currentMeetingMeta = useMemo(
    () => meetings.find((m) => m.id === currentMeetingId) || null,
    [meetings, currentMeetingId]
  );

  // speaker name → avatar, so chat message headers can show each participant's
  // icon. Chat events use the engine name (unique, possibly " (2)"-suffixed).
  const participantAvatars = useMemo(() => {
    const map: Record<string, ParticipantIn["avatar"]> = {};
    for (const p of participants) map[p.engine_name ?? p.name] = p.avatar;
    if (includeHuman) map[humanName || "You"] = humanAvatar;
    return map;
  }, [participants, includeHuman, humanName, humanAvatar]);

  // Restore constraints when switching meetings
  useEffect(() => {
    if (!currentMeetingId) return;

    const cached = settingsCacheRef.current[currentMeetingId];
    if (cached) {
      // Restore from cache
      updateSetting('travelDate', cached.travelDate || "");
      updateSetting('timeWindowStart', cached.timeWindowStart || "");
      updateSetting('timeWindowEnd', cached.timeWindowEnd || "");
      updateSetting('budget', cached.budget || "");
    } else {
      // Restore from meeting metadata
      const meeting = meetings.find((m) => m.id === currentMeetingId);
      if (meeting) {
        updateSetting('travelDate', meeting.travel_date || "");
        updateSetting('timeWindowStart', meeting.time_window_start || "");
        updateSetting('timeWindowEnd', meeting.time_window_end || "");
        updateSetting('budget', meeting.budget || "");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMeetingId, updateSetting]);

  const currentMeetingHasHistory = useMemo(() => {
    if (!currentMeetingId) return false;
    const cached = meetingHistory[currentMeetingId];
    if (cached && cached.length > 0) return true;
    return currentMeetingMeta?.has_history ?? false;
  }, [currentMeetingId, meetingHistory, currentMeetingMeta]);

  const settingsLocked = useMemo(() => {
    if (!currentMeetingId) return false;
    const hasStarted = startedMeetings[currentMeetingId] ?? false;
    if (connected) return true;
    if (hasStarted) return true;
    const cachedLength = meetingHistory[currentMeetingId]?.length ?? 0;
    if (cachedLength > 0) return true;
    return currentMeetingMeta?.has_history ?? false;
  }, [connected, currentMeetingId, meetingHistory, currentMeetingMeta, startedMeetings]);

  // Default the single-decider pick to the first participant in order when
  // the rule is selected without a (still-)valid decider.
  useEffect(() => {
    if (draftVotingRule !== "single_decider" || settingsLocked) return;
    const validIds = new Set(
      participants
        .filter((p: any) => !p.incomplete)
        .map((p: any) => String(p.id ?? p.name))
    );
    if (includeHuman) validIds.add(YOU_ID);
    if (singleDecider && validIds.has(singleDecider)) return;
    const first = order.find((key) => validIds.has(key)) ?? [...validIds][0];
    if (first && first !== singleDecider) {
      updateSetting('singleDecider', first);
    }
  }, [draftVotingRule, singleDecider, participants, order, includeHuman, settingsLocked, updateSetting]);

  // Persist the single-decider selection.
  useEffect(() => {
    if (!currentMeetingId) return;

    const cached = settingsCacheRef.current[currentMeetingId];
    const cachedDecider = cached?.singleDecider ?? "";
    if (cachedDecider === singleDecider) return;

    settingsCacheRef.current[currentMeetingId] = {
      ...ensureSettingsCache(currentMeetingId),
      singleDecider,
    };

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          single_decider: singleDecider || null,
        }),
        signal: controller.signal,
      })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`Failed to update single decider: ${res.status}`);
          }
          return res.json() as Promise<{ single_decider?: string | null }>;
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          const savedDecider =
            typeof data.single_decider === "string" ? data.single_decider : "";
          const currentCache = settingsCacheRef.current[currentMeetingId];
          settingsCacheRef.current[currentMeetingId] = {
            ...currentCache,
            singleDecider: savedDecider,
          };
          if (savedDecider !== singleDecider) {
            updateSetting('singleDecider', savedDecider);
          }
        })
        .catch(() => {});
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBase, currentMeetingId, singleDecider, ensureSettingsCache, updateSetting]);

  // Auto-scroll to bottom when logs change if auto-scroll is enabled.
  // Set scrollTop directly (vertical only) instead of scrollIntoView: the
  // latter also scrolls the inline axis to bring the target fully into view,
  // which nudges horizontal scroll (e.g. from a wide route box) and reads as
  // the pinned avatar shaking left-right. Instant, so no animation to fight.
  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    if (autoScroll) el.scrollTop = el.scrollHeight;
    // Re-derive the scroll-down button from the real geometry: scroll events
    // alone leave it stale (e.g. showing from the start on a screen whose
    // content doesn't even overflow yet).
    setShowScrollButton(el.scrollHeight - el.scrollTop - el.clientHeight >= 100);
  }, [logs, autoScroll]);

  // Entering the meeting screen remounts the chat container at scrollTop 0
  // while the button/auto-scroll state carries over from last time — jump to
  // the latest message and reset both so the button never shows spuriously.
  useEffect(() => {
    if (view !== "meeting") return;
    const el = chatContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
    setShowScrollButton(false);
  }, [view]);

  // Handle scroll to detect if user scrolled up
  const handleChatScroll = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // If user is near the bottom (within 100px), enable auto-scroll and hide button
    if (distanceFromBottom < 100) {
      setAutoScroll(true);
      setShowScrollButton(false);
    } else {
      // User scrolled up, disable auto-scroll and show button
      setAutoScroll(false);
      setShowScrollButton(true);
    }
  }, []);

  // Scroll to bottom when button is clicked (vertical only, smooth).
  const scrollToBottom = useCallback(() => {
    setAutoScroll(true);
    setShowScrollButton(false);
    const el = chatContainerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  // Load meetings list
  const loadMeetings = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/meetings`);
      const data = await res.json();
      // Strip elapsed_seconds into the timer refs: it changes every poll for
      // running meetings and would defeat the deep-equality check below.
      const parsed = (data as MeetingInfo[]).map(({ elapsed_seconds, ...rest }) => {
        if (typeof elapsed_seconds === "number") {
          const statusLower = (rest.status ?? "").toLowerCase();
          const isActive = statusLower === "running" || statusLower === "stopping";
          const isTracked =
            meetingStartRef.current[rest.id] !== undefined ||
            meetingResumeOffsetRef.current[rest.id] !== undefined;
          // Seed only untracked meetings (e.g. after a page reload) so the
          // server value never fights the live WebSocket timer updates.
          if (!isTracked) {
            if (isActive) {
              meetingStartRef.current[rest.id] =
                Math.floor(Date.now() / 1000) - elapsed_seconds;
            } else {
              meetingResumeOffsetRef.current[rest.id] = elapsed_seconds;
            }
          }
        }
        return rest as MeetingInfo;
      });
      tickElapsed();

      // Only update meetings if data has actually changed
      setMeetings((prevMeetings: MeetingInfo[]) => {
        if (JSON.stringify(prevMeetings) === JSON.stringify(parsed)) {
          return prevMeetings;
        }
        return parsed;
      });

      setStartedMeetings((prev) => {
        const next = { ...prev };
        parsed.forEach((meeting) => {
          if (
            meeting.has_history ||
            (typeof meeting.status === "string" && meeting.status !== "idle")
          ) {
            next[meeting.id] = true;
          }
        });

        // Only update if startedMeetings has actually changed
        if (JSON.stringify(prev) === JSON.stringify(next)) {
          return prev;
        }
        return next;
      });
    } catch (err) {
      console.error("Failed to load meetings:", err);
    }
  }, [apiBase, tickElapsed]);

  useEffect(() => {
    loadMeetings();
  }, [loadMeetings]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      loadMeetings();
    }, 4000);
    return () => window.clearInterval(intervalId);
  }, [loadMeetings]);

  useEffect(() => {
    if (!currentMeetingId) {
      setElapsedSeconds(0);
      return;
    }
    const effectiveStatus = (currentMeetingMeta?.status ?? status).toLowerCase();
    const activeStatuses = new Set(["running", "stopping"]);
    if (activeStatuses.has(effectiveStatus) && !meetingStartRef.current[currentMeetingId]) {
      const offset = meetingResumeOffsetRef.current[currentMeetingId] ?? 0;
      meetingStartRef.current[currentMeetingId] = Math.floor(Date.now() / 1000) - offset;
      delete meetingResumeOffsetRef.current[currentMeetingId];
    }
    tickElapsed();
  }, [currentMeetingId, currentMeetingMeta?.status, status, tickElapsed]);

  // Load participants when meeting changes
  useEffect(() => {
    if (!currentMeetingId) return;

    fetch(`${apiBase}/meetings/${currentMeetingId}`)
      .then((r) => r.json())
      .then((meetingData) => {
        setIncludeHuman(Boolean(meetingData.include_human));
        setHumanName(
          typeof meetingData.human_name === "string" && meetingData.human_name.trim()
            ? meetingData.human_name
            : "You"
        );
        setHumanAvatar(meetingData.human_avatar ?? null);
        setHumanRole(
          meetingData.human_role === "facilitator" ? "facilitator" : "attendee"
        );
        if (typeof meetingData.title === "string") {
          setMeetingTitle(meetingData.title);
        }
        setMeetings((prev) =>
          prev.map((m) =>
            m.id === currentMeetingId ? mergeMeetingData(m, meetingData) : m
          )
        );
        // Update settings cache and state with server data
        const existingCache = settingsCacheRef.current[currentMeetingId];
        const updatedCache: MeetingSettingsCache = existingCache ? {
          ...existingCache,
        } : {
          maxTurns: maxTurns,
          timeLimit: (timeLimit || "").trim(),
          travelDate: (travelDate || "").trim(),
          timeWindowStart: (timeWindowStart || "").trim(),
          timeWindowEnd: (timeWindowEnd || "").trim(),
          budget: (budget || "").trim(),
          turnRule: turnRule,
          votingRule: draftVotingRule,
          volunteerMode: volunteerMode,
          balancedTurns: balancedTurns,
          voteTurnRule: voteTurnRule,
          voteSettingsLinked: voteSettingsLinked,
        };

        // Update voting rule if present in server response
        if (typeof meetingData.initialization_voting_rule === "string") {
          updatedCache.votingRule = meetingData.initialization_voting_rule;
          updateSetting('draftVotingRule', meetingData.initialization_voting_rule);
        }

        // Update turn rule if present
        if (typeof meetingData.initialization_turn_rule === "string") {
          updatedCache.turnRule = meetingData.initialization_turn_rule;
        }

        // Update volunteer mode if present
        if (typeof meetingData.volunteer_mode === "boolean") {
          updatedCache.volunteerMode = meetingData.volunteer_mode;
          updateSetting('volunteerMode', meetingData.volunteer_mode);
        }

        // Update balanced turns if present
        if (typeof meetingData.balanced_turns === "boolean") {
          const currentTurnRule = updatedCache.turnRule ?? "round_robin";
          const normalizedBalanced = normalizeBalancedTurns(currentTurnRule, meetingData.balanced_turns);
          updatedCache.balancedTurns = normalizedBalanced;
          updateSetting('balancedTurns', normalizedBalanced);
        }

        // Update vote settings if present
        if (typeof meetingData.vote_settings_linked === "boolean") {
          updatedCache.voteSettingsLinked = meetingData.vote_settings_linked;
          updateSetting('voteSettingsLinked', meetingData.vote_settings_linked);
        }
        if (typeof meetingData.vote_turn_rule === "string") {
          updatedCache.voteTurnRule = meetingData.vote_turn_rule;
          updateSetting('voteTurnRule', meetingData.vote_turn_rule);
        }
        {
          const serverDecider =
            typeof meetingData.single_decider === "string" ? meetingData.single_decider : "";
          updatedCache.singleDecider = serverDecider;
          updateSetting('singleDecider', serverDecider);
        }

        settingsCacheRef.current[currentMeetingId] = updatedCache;

        if (meetingData?.has_history) {
          setStartedMeetings((prev) => ({
            ...prev,
            [currentMeetingId]: true,
          }));
        }
        if (
          typeof meetingData.status === "string" &&
          meetingData.status !== "idle"
        ) {
          setStartedMeetings((prev) => ({
            ...prev,
            [currentMeetingId]: true,
          }));
        }

        const serverMaxTurns =
          typeof meetingData.max_turns === "number" &&
          Number.isFinite(meetingData.max_turns) &&
          meetingData.max_turns > 0
            ? Math.floor(meetingData.max_turns)
            : 20;
        let serverTimeLimit =
          typeof meetingData.time_limit === "number" &&
          Number.isFinite(meetingData.time_limit) &&
          meetingData.time_limit > 0
            ? String(Math.floor(meetingData.time_limit))
            : "";
        if (
          serverTimeLimit === "" &&
          typeof meetingData.time_limit === "string" &&
          meetingData.time_limit.trim().length > 0
        ) {
          serverTimeLimit = meetingData.time_limit.trim();
        }
        const serverTurnRule =
          typeof meetingData.initialization_turn_rule === "string" &&
          TURN_RULE_OPTIONS.some((opt) => opt.value === meetingData.initialization_turn_rule)
            ? meetingData.initialization_turn_rule
            : "round_robin";
        const serverVotingRule =
          typeof meetingData.initialization_voting_rule === "string" &&
          VOTING_RULE_OPTIONS.some((opt) => opt.value === meetingData.initialization_voting_rule)
            ? meetingData.initialization_voting_rule
            : "majority";

        const serverVolunteerMode = typeof meetingData.volunteer_mode === "boolean"
          ? meetingData.volunteer_mode : false;
        const serverBalancedTurns = normalizeBalancedTurns(
          serverTurnRule,
          typeof meetingData.balanced_turns === "boolean"
            ? meetingData.balanced_turns : true,
        );
        const serverVoteSettingsLinked = typeof meetingData.vote_settings_linked === "boolean"
          ? meetingData.vote_settings_linked : true;
        const serverVoteTurnRule = typeof meetingData.vote_turn_rule === "string" &&
          VOTE_TURN_RULE_OPTIONS.some((opt) => opt.value === meetingData.vote_turn_rule)
            ? meetingData.vote_turn_rule : "round_robin";
        settingsCacheRef.current[currentMeetingId] = {
          maxTurns: serverMaxTurns,
          timeLimit: serverTimeLimit,
          travelDate: updatedCache.travelDate ?? "",
          timeWindowStart: updatedCache.timeWindowStart ?? "",
          timeWindowEnd: updatedCache.timeWindowEnd ?? "",
          budget: updatedCache.budget ?? "",
          turnRule: serverTurnRule,
          votingRule: serverVotingRule,
          volunteerMode: serverVolunteerMode,
          balancedTurns: serverBalancedTurns,
          voteTurnRule: serverVoteTurnRule,
          voteSettingsLinked: serverVoteSettingsLinked,
          singleDecider: updatedCache.singleDecider ?? "",
        };
        updateSetting('maxTurns', serverMaxTurns);
        updateSetting('timeLimit', serverTimeLimit);
        updateSetting('turnRule', serverTurnRule);
        updateSetting('draftVotingRule', serverVotingRule);
        updateSetting('volunteerMode', serverVolunteerMode);
        updateSetting('balancedTurns', serverBalancedTurns);
        updateSetting('voteTurnRule', serverVoteTurnRule);
        updateSetting('voteSettingsLinked', serverVoteSettingsLinked);
      })
      .catch(() => {});

    refreshParticipants().catch(() => {});

    fetch(`${apiBase}/meetings/${currentMeetingId}/history`)
      .then((r) => r.json())
      .then((historyData) => {
        if (!Array.isArray(historyData)) {
          // Invalid/error response: clear the cache but keep whatever chat is
          // on screen — wiping the live log over a failed fetch loses content.
          setMeetingHistory((prev) => ({ ...prev, [currentMeetingId]: [] }));
          return;
        }

        const normalized: LogEntry[] = [];
        let messageCount = 0; // Track actual message count for turn fallback
        historyData.forEach((entry: any, index: number) => {
          const name = typeof entry.name === "string" ? entry.name : "";
          const content = typeof entry.content === "string" ? entry.content : "";
          const routePlan =
            entry.route_plan && typeof entry.route_plan === "object"
              ? (entry.route_plan as RoutePlan)
              : undefined;
          if (name === "System") {
            // If System message has a route_plan, treat it as a regular message
            if (routePlan) {
              console.log("[DEBUG] System message with route_plan found:", { content, turn: entry.turn, routePlan });
              messageCount++; // Increment for actual messages
              const messageEntry: MessageOut = {
                kind: "message",
                name,
                content,
                turn:
                  typeof entry.turn === "number" && Number.isFinite(entry.turn)
                    ? entry.turn
                    : messageCount,
                routePlan,
              };
              normalized.push(messageEntry);
              return;
            }
            console.log("[DEBUG] System message without route_plan:", { content, turn: entry.turn });
            if (!content) {
              normalized.push({ kind: "phase", title: "System" });
              return;
            }
            const [titleLine, ...rest] = content.split("\n");
            const title = titleLine || "System";
            const description = rest.length > 0 ? rest.join("\n").trim() : undefined;
            const parsed = parseInvitationPhasePayload(
              title,
              description,
              findLastMessageEntry(normalized)?.name,
            );
            if (parsed) {
              // Find the last message from the inviter
              for (let i = normalized.length - 1; i >= 0; i--) {
                const nEntry = normalized[i];
                if (nEntry.kind === "message" && normalizeNameForKey(nEntry.name) === parsed.speaker) {
                  if ((nEntry as MessageOut).routePlan) {
                    // Proposal message — separate entry (invitation comes after voting)
                    const lastMsg = findLastMessageEntry(normalized);
                    messageCount++;
                    normalized.push({
                      kind: "message",
                      name: nEntry.name,
                      content: "",
                      turn: lastMsg?.turn ?? (nEntry as MessageOut).turn,
                      invitationHighlight: parsed.highlight,
                      invitationMessage: parsed.reason,
                    });
                  } else {
                    // Regular message — merge into it
                    (nEntry as MessageOut).invitationHighlight = parsed.highlight;
                    (nEntry as MessageOut).invitationMessage = parsed.reason;
                  }
                  break;
                }
              }
            } else {
              normalized.push({ kind: "phase", title, description });
            }
            return;
          }
          messageCount++; // Increment for actual messages
          const messageEntry: MessageOut = {
            kind: "message",
            name,
            content,
            turn:
              typeof entry.turn === "number" && Number.isFinite(entry.turn)
                ? entry.turn
                : messageCount,
            routePlan,
          };

          // Add steps fields if present
          if (entry.steps_log) {
            messageEntry.stepsLog = entry.steps_log;
          }
          if (entry.steps_label) {
            messageEntry.stepsLabel = entry.steps_label;
          }
          if (typeof entry.max_steps === "number" && Number.isFinite(entry.max_steps)) {
            messageEntry.maxSteps = entry.max_steps;
          }
          const rawScore = (entry as any).score;
          const parsedScore =
            typeof rawScore === "number" && Number.isFinite(rawScore)
              ? rawScore
              : typeof rawScore === "string" &&
                rawScore.trim() !== "" &&
                Number.isFinite(Number(rawScore))
              ? Number(rawScore)
              : undefined;
          if (typeof parsedScore === "number" && Number.isFinite(parsedScore)) {
            messageEntry.score = parsedScore;
          }
          normalized.push(messageEntry);
        });

        const meetingId = currentMeetingId;
        if (meetingId) {
          // Update logs if not connected — preserve invitation data and non-message entries from current streaming logs
          if (!connected) {
            setLogs((currentLogs) => {
              // Keep the live streamed chat rather than replacing it with the
              // sparser server history: on a stop, the API only has completed
              // turns, so a wholesale replace wipes in-progress turns (or the
              // whole chat when stopped early). Merge updated contents in and
              // append any messages we don't have yet.
              if (currentLogs.length > 0) {
                const normalizedMap = new Map<string, MessageOut>();
                normalized.forEach((e) => {
                  if (e.kind === "message") {
                    const mo = e as MessageOut;
                    normalizedMap.set(`${mo.turn}-${mo.name}`, mo);
                  }
                });
                const mergedLogs = currentLogs.map((e) => {
                  if (e.kind === "message") {
                    const mo = e as MessageOut;
                    const updated = normalizedMap.get(`${mo.turn}-${mo.name}`);
                    if (updated) {
                      return {
                        ...mo,
                        content: updated.content || mo.content,
                        stepsLog: updated.stepsLog || mo.stepsLog,
                        stepsLabel: updated.stepsLabel || mo.stepsLabel,
                        maxSteps: updated.maxSteps ?? mo.maxSteps,
                        score: updated.score ?? mo.score,
                      };
                    }
                  }
                  return e;
                });
                const seenKeys = new Set(
                  currentLogs
                    .filter((e) => e.kind === "message")
                    .map((e) => `${(e as MessageOut).turn}-${(e as MessageOut).name}`)
                );
                const missing = normalized.filter(
                  (e) =>
                    e.kind === "message" &&
                    !seenKeys.has(`${(e as MessageOut).turn}-${(e as MessageOut).name}`)
                );
                return missing.length > 0 ? [...mergedLogs, ...missing] : mergedLogs;
              }
              // Cold start: no streaming logs, use normalized from API
              const invitationMap = new Map<string, { highlight: string; message?: string }>();
              currentLogs.forEach((e) => {
                if (e.kind === "message") {
                  const mo = e as MessageOut;
                  if (mo.invitationHighlight) {
                    invitationMap.set(`${mo.turn}-${mo.name}`, {
                      highlight: mo.invitationHighlight,
                      message: mo.invitationMessage,
                    });
                  }
                }
              });
              if (invitationMap.size > 0) {
                normalized.forEach((e) => {
                  if (e.kind === "message" && !(e as MessageOut).invitationHighlight) {
                    const mo = e as MessageOut;
                    const inv = invitationMap.get(`${mo.turn}-${mo.name}`);
                    if (inv) {
                      mo.invitationHighlight = inv.highlight;
                      mo.invitationMessage = inv.message;
                    }
                  }
                });
              }
              return normalized;
            });
            restoreExpandedLogs(currentMeetingId);
          }

          // Save to meetingHistory — keep entries the server history doesn't
          // return (in-progress turns, round_end, etc.); merge updated message
          // contents in and append messages the cache doesn't have yet.
          setMeetingHistory((prev) => {
            const prevLogs = prev[meetingId];
            if (prevLogs && prevLogs.length > 0) {
              const normalizedMap = new Map<string, MessageOut>();
              normalized.forEach((e) => {
                if (e.kind === "message") {
                  const mo = e as MessageOut;
                  normalizedMap.set(`${mo.turn}-${mo.name}`, mo);
                }
              });
              const merged = prevLogs.map((e) => {
                if (e.kind === "message") {
                  const mo = e as MessageOut;
                  const updated = normalizedMap.get(`${mo.turn}-${mo.name}`);
                  if (updated) {
                    return {
                      ...mo,
                      content: updated.content || mo.content,
                      stepsLog: updated.stepsLog || mo.stepsLog,
                      stepsLabel: updated.stepsLabel || mo.stepsLabel,
                      maxSteps: updated.maxSteps ?? mo.maxSteps,
                      score: updated.score ?? mo.score,
                    };
                  }
                }
                return e;
              });
              const seenKeys = new Set(
                prevLogs
                  .filter((e) => e.kind === "message")
                  .map((e) => `${(e as MessageOut).turn}-${(e as MessageOut).name}`)
              );
              const missing = normalized.filter(
                (e) =>
                  e.kind === "message" &&
                  !seenKeys.has(`${(e as MessageOut).turn}-${(e as MessageOut).name}`)
              );
              return {
                ...prev,
                [meetingId]: missing.length > 0 ? [...merged, ...missing] : merged,
              };
            }
            return { ...prev, [meetingId]: normalized };
          });
        }
        if (normalized.length > 0) {
          setStartedMeetings((prev) => ({
            ...prev,
            [currentMeetingId]: true,
          }));
        }
      })
      .catch(() => {});
  }, [apiBase, currentMeetingId, connected, refreshParticipants, resetLogsState]);

  const createNewMeeting = async () => {
    try {
      const res = await fetch(`${apiBase}/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Meeting ${meetings.length + 1}` })
      });
      const newMeeting = await res.json();
      await loadMeetings();
      setCurrentMeetingId(newMeeting.id);
      setMeetingTitle(newMeeting.title);
      goalCacheRef.current[newMeeting.id] = DEFAULT_GLOBAL_GOAL;
      updateSetting('globalGoals', DEFAULT_GLOBAL_GOAL);
      settingsCacheRef.current[newMeeting.id] = {
        maxTurns: 100,
        timeLimit: "",
        travelDate: "",
        timeWindowStart: "",
        timeWindowEnd: "",
        budget: "",
        turnRule: "round_robin",
        votingRule: "majority",
        volunteerMode: false,
        balancedTurns: true,
        voteTurnRule: "round_robin",
        voteSettingsLinked: true,
        singleDecider: "",
      };
      delete meetingStartRef.current[newMeeting.id];
      delete meetingResumeOffsetRef.current[newMeeting.id];
      updateSetting('maxTurns', 4);
      updateSetting('timeLimit', "");
      setParticipants([]);
      setView("settings");
    } catch (err) {
      console.error("Failed to create meeting:", err);
    }
  };

  const duplicateMeeting = async (meetingId: string) => {
    try {
      const sourceMeeting = meetings.find((m) => m.id === meetingId);
      if (!sourceMeeting) {
        console.error("Source meeting not found");
        return;
      }

      const newTitle = `Copy of ${sourceMeeting.title}`;
      const res = await fetch(`${apiBase}/meetings/${meetingId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle }),
      });
      if (!res.ok) {
        throw new Error(`Failed to duplicate meeting: ${res.status}`);
      }
      const newMeeting = await res.json();

      await loadMeetings();
      setCurrentMeetingId(newMeeting.id);
      setMeetingTitle(newMeeting.title);

      await refreshParticipants();

      delete meetingStartRef.current[newMeeting.id];
      delete meetingResumeOffsetRef.current[newMeeting.id];

      setView("settings");
    } catch (err) {
      console.error("Failed to duplicate meeting:", err);
    }
  };

  const generateRandomSample = async () => {
    try {
      setRandomSampleError(null);
      // First, create an empty meeting
      const res = await fetch(`${apiBase}/meetings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Generating..." })
      });
      const newMeeting = await res.json();
      const meetingId = newMeeting.id;

      // Switch to settings view immediately and show loading state
      await loadMeetings();
      setCurrentMeetingId(meetingId);
      setMeetingTitle("Generating...");
      setParticipants([]);
      updateSetting('globalGoals', "Generating random sample...");
      setIsGeneratingSample(true);
      setView("settings");

      // Reset all settings
      goalCacheRef.current[meetingId] = "";
      settingsCacheRef.current[meetingId] = {
        maxTurns: 100,
        timeLimit: "",
        travelDate: "",
        timeWindowStart: "",
        timeWindowEnd: "",
        budget: "",
        turnRule: "round_robin",
        votingRule: "majority",
        volunteerMode: false,
        balancedTurns: true,
        voteTurnRule: "round_robin",
        voteSettingsLinked: true,
        singleDecider: "",
      };
      delete meetingStartRef.current[meetingId];
      delete meetingResumeOffsetRef.current[meetingId];
      updateSetting('maxTurns', 20);
      updateSetting('timeLimit', "");
      updateSetting('travelDate', "");
      updateSetting('timeWindowStart', "");
      updateSetting('timeWindowEnd', "");
      updateSetting('budget', "");

      // Now generate sample in background
      console.log("Generating random sample...");

      const generateRes = await fetch(`${apiBase}/meetings/generate-random-sample`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!generateRes.ok) {
        const errorData = await generateRes.json();
        setIsGeneratingSample(false);
        setRandomSampleError(`Failed to generate random sample: ${errorData.detail || 'Unknown error'}`);
        // Clean up the empty meeting
        await deleteMeeting(meetingId);
        return;
      }

      const sampleData = await generateRes.json();
      console.log("Generated sample:", sampleData);
      const sampleTurnRule = sampleData.initialization_turn_rule ?? "round_robin";
      const sampleBalancedTurns = normalizeBalancedTurns(
        sampleTurnRule,
        sampleData.balanced_turns ?? true,
      );
      const normalizedParticipants = Array.isArray(sampleData.participants)
        ? sampleData.participants.map((p: any) => {
            const modelName = typeof p?.model_name === "string" ? p.model_name : "";
            const defaultTemp = modelName.startsWith("openai/gpt-5") ? 1 : 0.7;
            const parsedTemp = Number(p?.temperature);
            const temperature = Number.isFinite(parsedTemp) ? parsedTemp : defaultTemp;
            return {
              ...p,
              temperature: modelName.startsWith("openai/gpt-5") ? 1 : temperature,
            };
          })
        : [];

      // Update meeting title
      await fetch(`${apiBase}/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: sampleData.title })
      });

      // Update meeting settings
      const updateData: any = {
        max_turns: sampleData.max_turns || 100,
        include_human: sampleData.include_human ?? false,
        time_limit: sampleData.time_limit ?? null,
        initialization_turn_rule: sampleData.initialization_turn_rule ?? "round_robin",
        initialization_voting_rule: sampleData.initialization_voting_rule ?? "majority",
        volunteer_mode: sampleData.volunteer_mode ?? false,
        balanced_turns: sampleBalancedTurns,
        vote_turn_rule: sampleData.vote_turn_rule ?? "round_robin",
        vote_settings_linked: sampleData.vote_settings_linked ?? true,
      };

      if (sampleData.travel_date) {
        updateData.travel_date = sampleData.travel_date;
        updateSetting('travelDate', sampleData.travel_date);
      }

      if (sampleData.budget) {
        updateData.budget = sampleData.budget;
        updateSetting('budget', sampleData.budget);
      }

      if (sampleData.time_window_start) {
        updateData.time_window_start = sampleData.time_window_start;
        updateSetting('timeWindowStart', sampleData.time_window_start);
      }

      if (sampleData.time_window_end) {
        updateData.time_window_end = sampleData.time_window_end;
        updateSetting('timeWindowEnd', sampleData.time_window_end);
      }

      await fetch(`${apiBase}/meetings/${meetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updateData)
      });

      // Import participants
      await fetch(`${apiBase}/meetings/${meetingId}/participants/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participants: normalizedParticipants })
      });

      // Update global goal
      await fetch(`${apiBase}/meetings/${meetingId}/goal`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: sampleData.global_goal })
      });

      // Update UI with generated data
      await loadMeetings();
      setMeetingTitle(sampleData.title);
      goalCacheRef.current[meetingId] = sampleData.global_goal;
      updateSetting('globalGoals', sampleData.global_goal);
      updateSetting('maxTurns', sampleData.max_turns || 100);
      updateSetting('timeLimit', sampleData.time_limit ?? "");
      updateSetting('turnRule', sampleData.initialization_turn_rule ?? "round_robin");
      updateSetting('votingRule', sampleData.initialization_voting_rule ?? "majority");
      updateSetting('volunteerMode', sampleData.volunteer_mode ?? false);
      updateSetting('balancedTurns', sampleBalancedTurns);
      updateSetting('voteTurnRule', sampleData.vote_turn_rule ?? "round_robin");
      updateSetting('voteSettingsLinked', sampleData.vote_settings_linked ?? true);
      updateSetting('singleDecider', "");
      setIncludeHuman(sampleData.include_human ?? false);
      setHumanName("You");
      setHumanAvatar(null);
      setHumanRole("attendee");
      setParticipants(normalizedParticipants);

      settingsCacheRef.current[meetingId] = {
        maxTurns: sampleData.max_turns || 100,
        timeLimit: sampleData.time_limit ?? "",
        travelDate: sampleData.travel_date || "",
        timeWindowStart: sampleData.time_window_start || "",
        timeWindowEnd: sampleData.time_window_end || "",
        budget: sampleData.budget || "",
        turnRule: sampleData.initialization_turn_rule ?? "round_robin",
        votingRule: sampleData.initialization_voting_rule ?? "majority",
        volunteerMode: sampleData.volunteer_mode ?? false,
        balancedTurns: sampleBalancedTurns,
        voteTurnRule: sampleData.vote_turn_rule ?? "round_robin",
        voteSettingsLinked: sampleData.vote_settings_linked ?? true,
        singleDecider: "",
      };

      setIsGeneratingSample(false);
      console.log("Random sample meeting created successfully!");
    } catch (err) {
      console.error("Failed to generate random sample:", err);
      setIsGeneratingSample(false);
      setRandomSampleError(`Failed to generate random sample: ${err}`);
    }
  };

  const deleteMeeting = async (meetingId: string) => {
    try {
      await fetch(`${apiBase}/meetings/${meetingId}`, {
        method: "DELETE"
      });
      await loadMeetings();
      delete goalCacheRef.current[meetingId];
      delete settingsCacheRef.current[meetingId];
      delete meetingStartRef.current[meetingId];
      delete meetingResumeOffsetRef.current[meetingId];
      setStartedMeetings((prev) => {
        const next = { ...prev };
        delete next[meetingId];
        return next;
      });

      // If we deleted the current meeting, select another one
      if (currentMeetingId === meetingId) {
        const remaining = meetings.filter(m => m.id !== meetingId);
        if (remaining.length > 0) {
          setCurrentMeetingId(remaining[0].id);
        } else {
          setCurrentMeetingId(null);
          setMeetingTitle("");
          updateSetting('globalGoals', DEFAULT_GLOBAL_GOAL);
          updateSetting('maxTurns', 4);
          updateSetting('timeLimit', "");
        }
      }
    } catch (err) {
      console.error("Failed to delete meeting:", err);
    }
  };

  const toExportableLogs = (logs: LogEntry[]) =>
    logs.map((entry: LogEntry) => {
      if (entry.kind === "message") {
        const exported: any = {
          kind: entry.kind,
          name: entry.name,
          turn: entry.turn,
        };
        if (entry.stepsLog || entry.stepsLabel) {
          exported.internal_thoughts = {
            log: entry.stepsLog || "",
            task_label: entry.stepsLabel || "",
          };
        }
        exported.content = entry.content;
        if (entry.turnLabel !== undefined) exported.turnLabel = entry.turnLabel;
        if (entry.routePlan) exported.routePlan = entry.routePlan;
        if (entry.invitationHighlight) exported.invitationHighlight = entry.invitationHighlight;
        if (entry.invitationMessage) exported.invitationMessage = entry.invitationMessage;
        if (entry.retryInfo) exported.retryInfo = entry.retryInfo;
        if (typeof entry.maxSteps === "number" && Number.isFinite(entry.maxSteps)) {
          exported.maxSteps = entry.maxSteps;
        }
        if (typeof entry.score === "number" && Number.isFinite(entry.score)) {
          exported.score = entry.score;
        }
        return exported;
      }
      return entry;
    });

  const exportMeetingData = async (meetingId: string) => {
    const meeting = meetings.find((m: MeetingInfo) => m.id === meetingId);
    if (!meeting) {
      alert("Meeting not found.");
      return;
    }

    try {
      const [meetingRes, goalRes, participantsRes, orderRes, historyRes, analyticsRes] = await Promise.all([
        fetch(`${apiBase}/meetings/${meetingId}`),
        fetch(`${apiBase}/meetings/${meetingId}/goal`),
        fetch(`${apiBase}/meetings/${meetingId}/participants`),
        fetch(`${apiBase}/meetings/${meetingId}/order`),
        fetch(`${apiBase}/meetings/${meetingId}/history`),
        fetch(`${apiBase}/meetings/${meetingId}/analytics/export`),
      ]);

      if (!meetingRes.ok || !goalRes.ok || !participantsRes.ok || !orderRes.ok || !historyRes.ok) {
        throw new Error("Failed to fetch meeting data.");
      }

      const [meetingData, goalData, participantsData, orderData, historyData] = await Promise.all([
        meetingRes.json(),
        goalRes.json(),
        participantsRes.json(),
        orderRes.json(),
        historyRes.json(),
      ]);

      const analyticsData = analyticsRes.ok ? await analyticsRes.json() : null;
      const logs = meetingHistory[meetingId] ?? [];
      const logsPayload =
        logs.length > 0
          ? toExportableLogs(logs)
          : (Array.isArray(historyData) ? historyData : []);
      const sanitizedTitle = (meeting.title || `meeting_${meetingId}`)
        .replace(/[^a-z0-9]/gi, "_")
        .toLowerCase();
      const folderName = `${sanitizedTitle}_data`;

      const exportFiles: Record<string, string> = {
        "meeting.json": JSON.stringify(
          {
            id: meetingId,
            title: meeting.title,
            exported_at: new Date().toISOString(),
            include_human: Boolean(meetingData?.include_human),
            human_name: meetingData?.human_name ?? "You",
            human_avatar: meetingData?.human_avatar ?? null,
            human_role: meetingData?.human_role ?? "attendee",
            settings: {
              global_goal: goalData?.goal ?? DEFAULT_GLOBAL_GOAL,
              max_turns: meetingData?.max_turns ?? 100,
              time_limit: meetingData?.time_limit ?? null,
              travel_date: meetingData?.travel_date ?? null,
              time_window_start: meetingData?.time_window_start ?? null,
              time_window_end: meetingData?.time_window_end ?? null,
              budget: meetingData?.budget ?? null,
              initialization_turn_rule: meetingData?.initialization_turn_rule ?? "round_robin",
              initialization_voting_rule: meetingData?.initialization_voting_rule ?? "majority",
              volunteer_mode: Boolean(meetingData?.volunteer_mode),
              balanced_turns: normalizeBalancedTurns(
                meetingData?.initialization_turn_rule ?? "round_robin",
                meetingData?.balanced_turns === undefined ? true : Boolean(meetingData?.balanced_turns),
              ),
              vote_turn_rule: meetingData?.vote_turn_rule ?? null,
              vote_settings_linked:
                meetingData?.vote_settings_linked === undefined
                  ? true
                  : Boolean(meetingData?.vote_settings_linked),
              single_decider: meetingData?.single_decider ?? null,
            },
          },
          null,
          2
        ),
        "participants.json": JSON.stringify(
          { participants: Array.isArray(participantsData) ? participantsData : [] },
          null,
          2
        ),
        "order.json": JSON.stringify({ order: Array.isArray(orderData) ? orderData : [] }, null, 2),
        "logs.json": JSON.stringify(logsPayload, null, 2),
        "analytics.json": JSON.stringify(
          analyticsData ?? { unavailable: true, reason: `analytics endpoint returned ${analyticsRes.status}` },
          null,
          2
        ),
      };

      const hasDirectoryPicker = typeof (window as any).showDirectoryPicker === "function";
      if (hasDirectoryPicker) {
        const rootHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
        const folderHandle = await rootHandle.getDirectoryHandle(folderName, { create: true });
        for (const [fileName, content] of Object.entries(exportFiles)) {
          const fileHandle = await folderHandle.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(content);
          await writable.close();
        }
        alert(`Export completed: ${folderName}`);
        return;
      }

      // Fallback for browsers without File System Access API.
      const blob = new Blob([JSON.stringify(exportFiles, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${folderName}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      alert("Exported as a single JSON file because folder export is not supported in this browser.");
    } catch (err) {
      console.error("Failed to export meeting data:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      alert(`Failed to export data: ${message}`);
    }
  };

  const deleteAllMeetings = async () => {
    if (meetings.length === 0) return;
    const confirmed = window.confirm("Delete all meetings? This action cannot be undone.");
    if (!confirmed) return;

    if (wsRef.current) {
      manualDisconnectRef.current = true;
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    setConnected(false);
    setWaitingForUser(false);

    try {
      for (const meeting of meetings) {
        const res = await fetch(`${apiBase}/meetings/${meeting.id}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          console.error("Failed to delete meeting:", errorData);
          throw new Error("Failed to delete all meetings");
        }
      }
    } catch (err) {
      console.error(err);
      await loadMeetings();
      return;
    }

    goalCacheRef.current = {};
    settingsCacheRef.current = {};
    meetingStartRef.current = {};
    meetingResumeOffsetRef.current = {};
    setMeetings([]);
    setCurrentMeetingId(null);
    setMeetingTitle("");
    updateSetting('globalGoals', DEFAULT_GLOBAL_GOAL);
    updateSetting('maxTurns', 4);
    updateSetting('timeLimit', "");
    setIncludeHuman(false);
    setParticipants([]);
    setOrder([]);
    setMeetingHistory({});
    resetLogsState({ clearCache: true });
    setStartedMeetings({});
    setElapsedSeconds(0);
    setStatus("idle");
    setView("settings");
    setContextMenu(null);
    setIsEditingTitle(false);
    setEditingParticipant(null);
    setForm(createDefaultParticipantForm());
    setShowModal(false);
    setUserMessage("");
    manualDisconnectRef.current = false;
    await loadMeetings();
  };

  const updateMeetingTitle = async () => {
    if (!currentMeetingId || !meetingTitle.trim()) return;
    
    try {
      await fetch(`${apiBase}/meetings/${currentMeetingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: meetingTitle })
      });
      
      setMeetings(prev => prev.map(m => 
        m.id === currentMeetingId ? { ...m, title: meetingTitle } : m
      ));
    } catch (err) {
      console.error("Failed to update meeting title:", err);
      setMeetings(prev => prev.map(m => 
        m.id === currentMeetingId ? { ...m, title: meetingTitle } : m
      ));
    }
  };

  const selectMeeting = async (meetingId: string) => {
    if (wsRef.current && currentMeetingId && currentMeetingId !== meetingId) {
      manualDisconnectRef.current = true;
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
      setConnected(false);
      setStatus((prev) =>
        ["finished", "timeout", "stopped", "stopping"].includes(prev) ? prev : "detached"
      );
    }

    setCurrentMeetingId(meetingId);

    const meetingMeta = meetings.find((m) => m.id === meetingId);
    if (meetingMeta) {
      setMeetingTitle(meetingMeta.title);
      if (typeof meetingMeta.include_human === "boolean") {
        setIncludeHuman(meetingMeta.include_human);
      }
      setHumanName(
        typeof meetingMeta.human_name === "string" && meetingMeta.human_name.trim()
          ? meetingMeta.human_name
          : "You"
      );
      setHumanAvatar(meetingMeta.human_avatar ?? null);
      setHumanRole(
        meetingMeta.human_role === "facilitator" ? "facilitator" : "attendee"
      );
      if (meetingMeta.has_history) {
        setStartedMeetings((prev) => ({ ...prev, [meetingId]: true }));
      }
      if (
        typeof meetingMeta.status === "string" &&
        meetingMeta.status !== "idle"
      ) {
        setStartedMeetings((prev) => ({ ...prev, [meetingId]: true }));
      }
      const start = meetingStartRef.current[meetingId];
      if (start) {
        setElapsedSeconds(Math.max(0, Math.floor(Date.now() / 1000) - start));
      } else {
        const offset = meetingResumeOffsetRef.current[meetingId] ?? 0;
        setElapsedSeconds(offset);
      }
    }

    const cachedHistory = meetingHistory[meetingId];
    const activeStatuses = ["running", "stopping", "timeout"];
    const isActive = Boolean(
      meetingMeta?.status && activeStatuses.includes(meetingMeta.status.toLowerCase())
    );
    const shouldShowHistory =
      (cachedHistory && cachedHistory.length > 0) || Boolean(meetingMeta?.has_history) || isActive;
    setView(shouldShowHistory ? "meeting" : "settings");

    if (shouldShowHistory && cachedHistory && cachedHistory.length > 0) {
      setLogs(cachedHistory);
      restoreExpandedLogs(meetingId);
    } else if (!shouldShowHistory) {
      resetLogsState();
    }
  };

  const downloadMeetingSettings = useCallback(() => {
    if (!currentMeetingId) {
      alert("Please select a meeting before downloading settings.");
      return;
    }

    const sanitizedParticipants = participants.map((p) => ({ ...p }));
    const trimmedTimeLimit = timeLimit.trim();
    const timeLimitValue =
      trimmedTimeLimit.length > 0 && Number.isFinite(Number(trimmedTimeLimit))
        ? Number(trimmedTimeLimit)
        : null;

    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      meetingId: currentMeetingId,
      title: meetingTitle,
      globalGoals,
      maxTurns,
      timeLimit: timeLimitValue,
      travelDate: travelDate.trim() || null,
      timeWindowStart: timeWindowStart.trim() || null,
      timeWindowEnd: timeWindowEnd.trim() || null,
      budget: budget.trim() || null,
      includeHuman,
      order,
      turnRule,
      votingRule: draftVotingRule,
      volunteerMode,
      balancedTurns,
      voteTurnRule,
      voteSettingsLinked,
      participants: sanitizedParticipants,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });

    const baseName = (meetingTitle || "meeting-settings")
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const filename = `${baseName || "meeting-settings"}.json`;

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [
    currentMeetingId,
    meetingTitle,
    globalGoals,
    maxTurns,
    timeLimit,
    travelDate,
    timeWindowStart,
    timeWindowEnd,
    budget,
    turnRule,
    includeHuman,
    order,
    participants,
    draftVotingRule,
  ]);

  const handleMeetingSettingsImport = useCallback(
    async (file: File) => {
      if (!currentMeetingId) {
        alert("Please select a meeting before importing settings.");
        return;
      }

      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as MeetingSettingsFile;
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("Invalid file format.");
        }

        const sanitizeParticipant = (raw: any): ParticipantIn | null => {
          if (!raw || typeof raw !== "object") return null;
          const name =
            typeof raw.name === "string" ? raw.name.trim() : "";
          const background =
            typeof raw.background === "string" ? raw.background : "";
          const personality =
            typeof raw.personality === "string" ? raw.personality : "";
          const preferences =
            typeof raw.preferences === "string" ? raw.preferences : "";
          const personalGoals =
            typeof raw.personal_goals === "string" ? raw.personal_goals : "";
          if (!name || !background || !personality || !preferences || !personalGoals) return null;

          const fallbackModel =
            typeof raw.model_name === "string"
              ? raw.model_name
              : "openai/gpt-5.4-mini";
          const fallbackTemperature = fallbackModel.startsWith("openai/gpt-5") ? 1 : 0.7;

          return {
            model_name: fallbackModel,
            temperature: toNumber(raw.temperature, fallbackTemperature),
            reasoning_effort:
              typeof raw.reasoning_effort === "string"
                ? raw.reasoning_effort
                : fallbackModel.startsWith("openai/gpt-5")
                  ? "medium"
                  : null,
            seed: Math.round(toNumber(raw.seed, 42)),
            name,
            background,
            personality,
            preferences,
            personal_goals: personalGoals,
            role: typeof raw.role === "string" ? (raw.role === "atendee" ? "attendee" : raw.role) : "attendee",
            speaking_style: typeof raw.speaking_style === "string" ? raw.speaking_style : "friendly",
            explanation_style:
              typeof raw.explanation_style === "string"
                ? raw.explanation_style
                : "auto",
            web_search: typeof raw.web_search === "boolean" ? raw.web_search : (raw.web_search_init !== false),
          };
        };

        const nextTitle =
          typeof parsed.title === "string" ? parsed.title : meetingTitle;
        const nextGoal =
          typeof parsed.globalGoals === "string"
            ? parsed.globalGoals
            : globalGoals;
        const nextMaxTurns =
          typeof parsed.maxTurns === "number" &&
          Number.isFinite(parsed.maxTurns) &&
          parsed.maxTurns > 0
            ? Math.floor(parsed.maxTurns)
            : maxTurns;

        let nextTimeLimit = timeLimit;
        if (parsed.timeLimit === null || parsed.timeLimit === undefined) {
          nextTimeLimit = "";
        } else if (typeof parsed.timeLimit === "number") {
          nextTimeLimit =
            Number.isFinite(parsed.timeLimit) && parsed.timeLimit > 0
              ? String(Math.floor(parsed.timeLimit))
              : "";
        } else if (typeof parsed.timeLimit === "string") {
          nextTimeLimit = parsed.timeLimit.trim();
        }

        const nextTravelDate =
          typeof parsed.travelDate === "string" ? parsed.travelDate.trim() : "";
        const nextTimeWindowStart =
          typeof parsed.timeWindowStart === "string" ? parsed.timeWindowStart.trim() : "";
        const nextTimeWindowEnd =
          typeof parsed.timeWindowEnd === "string" ? parsed.timeWindowEnd.trim() : "";
        const nextBudget =
          typeof parsed.budget === "string" ? parsed.budget.trim() : "";

        const importedTurnRule =
          typeof parsed.initializationTurnRule === "string" &&
          TURN_RULE_OPTIONS.some((opt) => opt.value === parsed.initializationTurnRule)
            ? parsed.initializationTurnRule
            : (typeof parsed.turnRule === "string" &&
               TURN_RULE_OPTIONS.some((opt) => opt.value === parsed.turnRule)
                ? parsed.turnRule
                : turnRule);

        const importedVotingRule =
          typeof parsed.initializationVotingRule === "string" &&
          VOTING_RULE_OPTIONS.some((opt) => opt.value === parsed.initializationVotingRule)
            ? parsed.initializationVotingRule
            : (typeof parsed.votingRule === "string" &&
               VOTING_RULE_OPTIONS.some((opt) => opt.value === parsed.votingRule)
                ? parsed.votingRule
                : draftVotingRule);

        const nextIncludeHuman =
          parsed.includeHuman === undefined
            ? includeHuman
            : Boolean(parsed.includeHuman);

        const rawParticipants = Array.isArray(parsed.participants)
          ? parsed.participants
          : [];
        const sanitizedParticipants = rawParticipants
          .map(sanitizeParticipant)
          .filter((p): p is ParticipantIn => p !== null);

        const importedVolunteerMode = typeof parsed.volunteerMode === "boolean" ? parsed.volunteerMode : false;
        const importedBalancedTurns = normalizeBalancedTurns(
          importedTurnRule,
          typeof parsed.balancedTurns === "boolean" ? parsed.balancedTurns : true,
        );
        const importedVoteTurnRule = typeof parsed.voteTurnRule === "string" &&
          VOTE_TURN_RULE_OPTIONS.some((opt) => opt.value === parsed.voteTurnRule)
            ? parsed.voteTurnRule : "round_robin";
        const importedVoteSettingsLinked = typeof parsed.voteSettingsLinked === "boolean" ? parsed.voteSettingsLinked : true;
        settingsCacheRef.current[currentMeetingId] = {
          maxTurns: nextMaxTurns,
          timeLimit: nextTimeLimit,
          travelDate: nextTravelDate,
          timeWindowStart: nextTimeWindowStart,
          timeWindowEnd: nextTimeWindowEnd,
          budget: nextBudget,
          turnRule: importedTurnRule,
          votingRule: importedVotingRule,
          volunteerMode: importedVolunteerMode,
          balancedTurns: importedBalancedTurns,
          voteTurnRule: importedVoteTurnRule,
          voteSettingsLinked: importedVoteSettingsLinked,
          singleDecider: "",
        };

        setMeetingTitle(nextTitle);
        updateSetting('globalGoals', nextGoal);
        updateSetting('maxTurns', nextMaxTurns);
        updateSetting('timeLimit', nextTimeLimit);
        updateSetting('travelDate', nextTravelDate);
        updateSetting('timeWindowStart', nextTimeWindowStart);
        updateSetting('timeWindowEnd', nextTimeWindowEnd);
        updateSetting('budget', nextBudget);
        updateSetting('turnRule', importedTurnRule);
        updateSetting('draftVotingRule', importedVotingRule);
        updateSetting('volunteerMode', importedVolunteerMode);
        updateSetting('balancedTurns', importedBalancedTurns);
        updateSetting('voteTurnRule', importedVoteTurnRule);
        updateSetting('voteSettingsLinked', importedVoteSettingsLinked);
        updateSetting('singleDecider', "");

        if (nextTitle.trim().length > 0) {
          try {
            await fetch(`${apiBase}/meetings/${currentMeetingId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: nextTitle.trim() }),
            });
            await loadMeetings();
          } catch (err) {
            console.error("Failed to update meeting title during import:", err);
          }
        }

        await updateIncludeHuman(nextIncludeHuman);

        // Remove existing participants
        try {
          const existingIds = participants.map(participantKey);
          for (const pid of existingIds) {
            await fetch(
              `${apiBase}/meetings/${currentMeetingId}/participants/${encodeURIComponent(
                pid
              )}`,
              {
                method: "DELETE",
              }
            ).catch(() => {});
          }
        } catch (err) {
          console.error("Failed to clear existing participants:", err);
        }

        // Add imported participants
        const addedParticipants: ParticipantIn[] = [];
        for (const participant of sanitizedParticipants) {
          try {
            const response = await fetch(
              `${apiBase}/meetings/${currentMeetingId}/participants`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(participant),
              }
            );
            if (response.ok) {
              // The server assigns the participant its stable id; the order
              // below is expressed in those ids.
              const json = await response.json().catch(() => null);
              addedParticipants.push(
                json?.id ? { ...participant, id: json.id } : participant
              );
            } else {
              console.warn(
                "Failed to add participant during import:",
                participant.name
              );
            }
          } catch (err) {
            console.error(
              "Error while adding participant during import:",
              participant.name,
              err
            );
          }
        }

        setParticipants(addedParticipants);

        // Order entries are participant ids; legacy settings files stored
        // display names instead, so map those onto the new ids.
        const participantIds = new Set(addedParticipants.map(participantKey));
        const idByName = new Map(
          addedParticipants.map((p) => [p.name, participantKey(p)])
        );
        let desiredOrder = Array.isArray(parsed.order)
          ? parsed.order
              .map((x) =>
                x === DND_YOU_ID || participantIds.has(x) ? x : idByName.get(x)
              )
              .filter((x): x is string => Boolean(x))
          : [];

        addedParticipants.forEach((p) => {
          if (!desiredOrder.includes(participantKey(p))) {
            desiredOrder.push(participantKey(p));
          }
        });

        if (nextIncludeHuman) {
          if (!desiredOrder.includes(DND_YOU_ID)) {
            desiredOrder.push(DND_YOU_ID);
          }
        } else {
          desiredOrder = desiredOrder.filter((id) => id !== DND_YOU_ID);
        }

        try {
          const res = await fetch(
            `${apiBase}/meetings/${currentMeetingId}/order`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ order: desiredOrder }),
            }
          );
          if (res.ok) {
            const json = await res.json();
            if (Array.isArray(json.order)) {
              setOrder(json.order);
            } else {
              setOrder(desiredOrder);
            }
          } else {
            setOrder(desiredOrder);
          }
        } catch (err) {
          console.error("Failed to update order during import:", err);
          setOrder(desiredOrder);
        }

        alert("Meeting settings imported successfully.");
      } catch (err) {
        console.error("Failed to import meeting settings:", err);
        alert("Failed to import meeting settings. Please check the file format.");
      }
    },
    [
      apiBase,
      currentMeetingId,
      includeHuman,
      globalGoals,
      maxTurns,
      meetingTitle,
      participants,
      timeLimit,
      turnRule,
      loadMeetings,
      updateIncludeHuman,
      draftVotingRule,
    ]
  );

  const handleFileInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        await handleMeetingSettingsImport(file);
      }
      event.target.value = "";
    },
    [handleMeetingSettingsImport]
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (settingsLocked) return;
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setIsDragOverSettings(true);
    }
  }, [settingsLocked]);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (settingsLocked) return;
    const related = event.relatedTarget as Node | null;
    if (!related || !event.currentTarget.contains(related)) {
      setIsDragOverSettings(false);
    }
  }, [settingsLocked]);

  const handleDrop = useCallback(
    async (event: React.DragEvent<HTMLDivElement>) => {
      if (settingsLocked) return;
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      setIsDragOverSettings(false);
      const file = event.dataTransfer.files[0];
      if (file) {
        await handleMeetingSettingsImport(file);
      }
    },
    [handleMeetingSettingsImport, settingsLocked]
  );

  const triggerFilePicker = useCallback(() => {
    if (settingsLocked) return;
    fileInputRef.current?.click();
  }, [settingsLocked]);

  const showParticipantMenu = useCallback((participantId: string, rect: DOMRect) => {
    setContextMenu({
      participantId,
      x: rect.left,
      y: rect.bottom + 4,
      type: 'participant',
    });
  }, []);

  const showHumanMenu = useCallback((rect: DOMRect) => {
    setContextMenu({
      x: rect.left,
      y: rect.bottom + 4,
      type: 'human',
    });
  }, []);

  // "Delete" on the human card simply removes the human seat.
  const deleteHuman = useCallback(() => {
    void updateIncludeHuman(false);
  }, [updateIncludeHuman]);

  // Open the participant modal in read-only mode (locked meetings: contents
  // are viewable from the card, but nothing is editable).
  const viewParticipant = useCallback(
    (participantId: string) => {
      const byId = (p: ParticipantIn) => (p.id ?? p.name) === participantId;
      const participant = participants.find(byId);
      const index = participants.findIndex(byId);
      if (participant) {
        openEditParticipant(participant, index);
      }
    },
    [participants, openEditParticipant]
  );

  const wsUrl = useMemo(() => {
    if (!currentMeetingId) return "";
    try {
      const u = new URL(apiBase);
      const proto = u.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${u.host}/ws/meeting/${currentMeetingId}`;
    } catch {
      const isHttps = apiBase.startsWith("https");
      return `${isHttps ? "wss" : "ws"}://${apiBase.replace(
        /^https?:\/\//,
        ""
      )}/ws/meeting/${currentMeetingId}`;
    }
  }, [apiBase, currentMeetingId]);

  const startMeetingWS = useCallback(async () => {
    if (!currentMeetingId) return;

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
      // Seed from the localStorage cache only when nothing is on screen yet
      // (e.g. watching right after a page reload). When `logs` already holds
      // content — the live chat, or the server history fetched on mount —
      // replacing it with the sparser cache snapshot loses recent turns; the
      // WS replay buffer only covers the last ~200 events, so they would not
      // come back.
      setLogs((prev) => (prev.length > 0 ? prev : cachedLogs));
      restoreExpandedLogs(currentMeetingId);
    } else {
      resetLogsState({ clearCache: true });
      if (currentMeetingId) {
        setMeetingHistory((prev) => ({ ...prev, [currentMeetingId]: [] }));
      }
    }

    setStatus("connecting");
    setView("meeting");
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
    wsMeetingIdRef.current = currentMeetingId;

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
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
      // Ignore events from sockets that are no longer the active one —
      // otherwise a stale socket for another meeting keeps writing into
      // the currently displayed chat.
      if (wsRef.current !== ws) return;
      try {
        const data = JSON.parse(event.data) as WsEvent & {
          meeting_id?: string;
          status?: string;
          reason?: string | null;
          elapsed?: number;
        };

        // Log all incoming messages (especially human_turn and turn_start for You)
        if (data.type === "human_turn" || data.type === "human_vote" ||
            (data.type === "turn_start" && (data as any).speaker === "You")) {
          console.log("📨 WebSocket message:", data.type, data);
        }

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
              if (
                data.status &&
                data.status.toLowerCase() === "running" &&
                typeof data.elapsed === "number"
              ) {
                meetingStartRef.current[targetMeetingId] =
                  Math.floor(Date.now() / 1000) - data.elapsed;
                delete meetingResumeOffsetRef.current[targetMeetingId];
                if (targetMeetingId === currentMeetingId) {
                  tickElapsed();
                }
              } else if (
                data.status &&
                data.status.toLowerCase() === "stopping" &&
                typeof data.elapsed === "number"
              ) {
                meetingStartRef.current[targetMeetingId] =
                  Math.floor(Date.now() / 1000) - data.elapsed;
                delete meetingResumeOffsetRef.current[targetMeetingId];
                if (targetMeetingId === currentMeetingId) {
                  tickElapsed();
                }
              } else if (
                data.status &&
                data.status.toLowerCase() === "stopped" &&
                (typeof data.elapsed === "number" ||
                  meetingStartRef.current[targetMeetingId] !== undefined ||
                  typeof meetingResumeOffsetRef.current[targetMeetingId] === "number")
              ) {
                const calculatedElapsed =
                  typeof data.elapsed === "number"
                    ? data.elapsed
                    : (() => {
                        const startedAt = meetingStartRef.current[targetMeetingId];
                        if (startedAt) {
                          return Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
                        }
                        const storedOffset = meetingResumeOffsetRef.current[targetMeetingId];
                        return typeof storedOffset === "number" ? storedOffset : 0;
                      })();
                meetingResumeOffsetRef.current[targetMeetingId] = calculatedElapsed;
                delete meetingStartRef.current[targetMeetingId];
                if (targetMeetingId === currentMeetingId) {
                  setElapsedSeconds(calculatedElapsed);
                }
              } else if (
                data.status &&
                ["finished", "timeout"].includes(data.status.toLowerCase()) &&
                (typeof data.elapsed === "number" ||
                  meetingStartRef.current[targetMeetingId] !== undefined ||
                  typeof meetingResumeOffsetRef.current[targetMeetingId] === "number")
              ) {
                const calculatedElapsed =
                  typeof data.elapsed === "number"
                    ? data.elapsed
                    : (() => {
                        const startedAt = meetingStartRef.current[targetMeetingId];
                        if (startedAt) {
                          return Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
                        }
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
                if (typeof data.elapsed === "number") {
                  setElapsedSeconds(data.elapsed);
                }
              } else if (data.status === "stopping") {
                setStatus("stopping");
                if (typeof data.elapsed === "number") {
                  setElapsedSeconds(data.elapsed);
                }
              } else if (data.status === "stopped") {
                setStatus("stopped");
                if (typeof data.elapsed === "number") {
                  setElapsedSeconds(data.elapsed);
                }
                setWaitingForUser(false);
              } else if (data.status === "finished") {
                setStatus("finished");
                if (typeof data.elapsed === "number") {
                  setElapsedSeconds(data.elapsed);
                }
                setWaitingForUser(false);
              } else if (data.status === "timeout") {
                setStatus("timeout");
                if (typeof data.elapsed === "number") {
                  setElapsedSeconds(data.elapsed);
                }
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
            // A new turn supersedes any pending human prompt from an earlier
            // turn. This matters on reload, where past human_turn/human_vote
            // events replay and would otherwise stack up (e.g. a stale vote
            // prompt showing over the current speaking turn); the human_turn /
            // human_vote that legitimately follow this turn_start re-set the
            // correct one.
            setWaitingForUser(false);
            setHumanTurnData(null);
            setWaitingForVote(false);
            setVotingData(null);
            setWaitingForSelect(false);
            setSelectSpeakerData(null);
            setWaitingForAskAnswer(false);
            setAskAnswerData(null);
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
            // Store retry info in the message and reset content for new retry
            setLogs((prev) => {
              const idx = prev.findIndex(
                (m) =>
                  m.kind === "message" &&
                  m.turn === data.turn &&
                  m.name === data.speaker
              );
              if (idx !== -1 && prev[idx].kind === "message") {
                const next = [...prev];
                next[idx] = {
                  ...prev[idx],
                  content: "", // Reset content to avoid duplicate streaming
                  retryInfo: {
                    attempt: data.attempt,
                    maxAttempts: data.max_attempts,
                    errorMessage: data.error_message,
                  },
                } as MessageOut;
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
            const opts = data.replay ? { replay: true } : undefined;
            if (INVITATION_PHASE_TITLES.has(data.title)) {
              appendInvitationMessage(data.title, data.description ?? undefined, opts);
            } else {
              appendPhaseLog(data.title, data.description ?? undefined, opts);
            }
            break;
          }
          case "deadlock_intervention": {
            const opts = data.replay ? { replay: true } : undefined;
            appendPhaseLog("Deadlock Intervention", data.message ?? undefined, opts);
            break;
          }
          case "human_turn": {
            // The four human prompts are mutually exclusive; clear the others
            // so a replayed earlier prompt can't linger over this one.
            setWaitingForVote(false);
            setVotingData(null);
            setWaitingForSelect(false);
            setSelectSpeakerData(null);
            setWaitingForAskAnswer(false);
            setAskAnswerData(null);
            setWaitingForUser(true);
            setNeedModification(false);
            setHumanTurnData({
              step: data.step ?? 1,
              maxSteps: data.max_steps ?? 1,
              candidates: Array.isArray(data.candidates) ? data.candidates : [],
              canAsk: data.can_ask !== false,
              canPropose: data.can_propose !== false,
              currentRoute: Array.isArray(data.current_route) ? data.current_route : [],
            });
            break;
          }
          case "human_vote": {
            setWaitingForUser(false);
            setHumanTurnData(null);
            setWaitingForSelect(false);
            setSelectSpeakerData(null);
            setWaitingForAskAnswer(false);
            setAskAnswerData(null);
            setWaitingForVote(true);
            setVotingData({
              vote_type: data.vote_type,
              options: data.options,
              turn: data.turn,
              step: data.step ?? 1,
              maxSteps: data.max_steps ?? 1,
              candidates: Array.isArray(data.candidates) ? data.candidates : [],
              canAsk: data.can_ask !== false,
            });
            setConsensusVoteSelections({approved: [], rejected: [], scores: [], message: ""});
            setRouteVoteSelections({accept: null, score: null, message: ""});
            break;
          }
          case "human_select_speaker": {
            setWaitingForUser(false);
            setHumanTurnData(null);
            setWaitingForVote(false);
            setVotingData(null);
            setWaitingForAskAnswer(false);
            setAskAnswerData(null);
            setWaitingForSelect(true);
            setSelectSpeakerData({
              turn: data.turn,
              candidates: Array.isArray(data.candidates) ? data.candidates : [],
            });
            break;
          }
          case "human_ask": {
            setWaitingForUser(false);
            setHumanTurnData(null);
            setWaitingForVote(false);
            setVotingData(null);
            setWaitingForSelect(false);
            setSelectSpeakerData(null);
            setWaitingForAskAnswer(true);
            setAskAnswerData({
              turn: data.turn,
              asker: data.asker,
              question: data.question,
            });
            break;
          }
          case "ask_exchange": {
            // An answered ask (live or replayed) dismisses the ask header when
            // an LLM asked the human. Human/LLM asks themselves render inline in
            // the asker's step box (streamed as internal events), not here.
            setWaitingForAskAnswer(false);
            setAskAnswerData(null);
            break;
          }
          case "timeout": {
            setStatus("timeout");
            setWaitingForUser(false);
            setWaitingForVote(false);
            setWaitingForSelect(false);
            setWaitingForAskAnswer(false);
            if (currentMeetingId) {
              const startedAt = meetingStartRef.current[currentMeetingId];
              const storedOffset = meetingResumeOffsetRef.current[currentMeetingId];
              const finalElapsed =
                typeof storedOffset === "number"
                  ? storedOffset
                  : startedAt
                  ? Math.max(0, Math.floor(Date.now() / 1000) - startedAt)
                  : elapsedSeconds;
              meetingResumeOffsetRef.current[currentMeetingId] = finalElapsed;
              delete meetingStartRef.current[currentMeetingId];
              setElapsedSeconds(finalElapsed);
              setMeetings((prev) =>
                prev.map((m) =>
                  m.id === currentMeetingId
                    ? { ...m, status: "timeout", status_detail: null }
                    : m
                )
              );
            }
            loadMeetings();
            break;
          }
          case "meeting_finished": {
            setStatus("finished");
            setWaitingForUser(false);
            setWaitingForVote(false);
            setWaitingForSelect(false);
            setWaitingForAskAnswer(false);
            if (currentMeetingId) {
              const startedAt = meetingStartRef.current[currentMeetingId];
              const storedOffset = meetingResumeOffsetRef.current[currentMeetingId];
              const finalElapsed =
                typeof storedOffset === "number"
                  ? storedOffset
                  : startedAt
                  ? Math.max(0, Math.floor(Date.now() / 1000) - startedAt)
                  : elapsedSeconds;
              setMeetings((prev) =>
                prev.map((m) =>
                  m.id === currentMeetingId
                    ? { ...m, status: "finished", status_detail: null }
                    : m
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
            wsMeetingIdRef.current = null;
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
          case "round_end": {
            setLogs((prev) => {
              if (
                data.replay &&
                prev.some((e) => e.kind === "round_end" && e.roundNumber === data.round_number)
              ) {
                return prev;
              }
              const next = [
                ...prev,
                {
                  kind: "round_end" as const,
                  roundNumber: data.round_number,
                },
              ];
              if (currentMeetingId) {
                setMeetingHistory((prevHistory) => ({
                  ...prevHistory,
                  [currentMeetingId]: next,
                }));
              }
              return next;
            });
            break;
          }
          case "error": {
            setStatus(`error: ${data.message}`);
            break;
          }
          default:
            break;
        }
      } catch (e) {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setStatus("error");
    };

    ws.onclose = () => {
      // A stale socket closing must not clobber the state (or the wsRef
      // handle) of a newer socket opened for another meeting.
      if (wsRef.current !== ws) return;
      setConnected(false);
      wsRef.current = null;
      wsMeetingIdRef.current = null;
      setStatus((prev) => {
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
  }, [currentMeetingId, meetingHistory, meetings, wsUrl, globalGoals, maxTurns, timeLimit, setMeetingHistory, setMeetings, loadMeetings, setStartedMeetings, elapsedSeconds, tickElapsed, upsertMessage, appendPhaseLog, appendInvitationMessage, upsertRoutePlan, upsertSearchSection, handleInternalEvent, clearInternalStream, resetLogsState]);

  const backToMeeting = () => {
    if (!currentMeetingId) return;
    // While a socket is live (or the chat is already populated), `logs` is the
    // current state — the meeting view was merely unmounted. Overwriting it
    // with the cached meetingHistory snapshot would wipe everything since the
    // cache's last checkpoint and leave later deltas merging into the wrong
    // entries. Only restore the cache when there is nothing on screen (e.g.
    // returning to a meeting after a page reload).
    if (!connected && logs.length === 0 && meetingHistory[currentMeetingId]) {
      setLogs(meetingHistory[currentMeetingId]);
      restoreExpandedLogs(currentMeetingId);
    }
    setView("meeting");
  };

  // The human's speaking turn is an LLM-like action loop: ask (intermediate)
  // then speak/propose/satisfied (final). Each action is sent as a dict; after
  // an ask, the engine emits the next human_turn step.
  const sendHumanAction = (action: any) => {
    const ws = wsRef.current;
    if (!ws || !waitingForUser) return;

    ws.send(JSON.stringify({ cmd: "message", message: action }));
    setWaitingForUser(false);
    setHumanTurnData(null);
    setUserMessage("");
    if (action?.action !== "ask") {
      setNeedModification(false);
    }
  };

  // Voting is also a loop: ask (intermediate) then judge (final). Both are sent
  // as dicts through the same channel.
  const sendUserVote = (voteData: any) => {
    const ws = wsRef.current;
    if (!ws || !waitingForVote) return;

    ws.send(JSON.stringify({ cmd: "vote", vote_data: voteData }));
    setWaitingForVote(false);
    setVotingData(null);
    setUserMessage("");
  };

  // Ask the backend to generate/complete a route from the human's description
  // (and any partial route they have started). Returns the drafted route.
  const generateHumanRoute = async (
    description: string,
    route: any[],
    model?: string,
    history?: { role: string; content: string }[]
  ): Promise<{ message: string; route: any[] } | null> => {
    if (!currentMeetingId) return null;
    try {
      const res = await fetch(
        `${apiBase}/meetings/${currentMeetingId}/human_route_draft`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description,
            route,
            history: history ?? [],
            ...(model ? { model_name: model } : {}),
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Request failed (${res.status})`);
      }
      return await res.json();
    } catch (err) {
      console.error("Route generation failed:", err);
      throw err;
    }
  };

  const sendUserSelection = (speaker: string) => {
    const ws = wsRef.current;
    if (!ws || !waitingForSelect) return;

    ws.send(JSON.stringify({ cmd: "select_speaker", speaker }));
    setWaitingForSelect(false);
    setSelectSpeakerData(null);
  };

  const sendAskAnswer = (answer: string) => {
    const ws = wsRef.current;
    if (!ws || !waitingForAskAnswer) return;

    ws.send(JSON.stringify({ cmd: "ask_answer", answer }));
    setWaitingForAskAnswer(false);
    setAskAnswerData(null);
  };

  const stopMeeting = () => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: "stop" }));
      manualDisconnectRef.current = true;
      try {
        ws.close();
      } catch {}
    }
    wsRef.current = null;
    setConnected(false);
    setStatus("stopping");
    setWaitingForUser(false);
    setWaitingForVote(false);
    setWaitingForSelect(false);
    setWaitingForAskAnswer(false);
    if (currentMeetingId) {
      const startedAt = meetingStartRef.current[currentMeetingId];
      if (startedAt) {
        const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - startedAt);
        meetingResumeOffsetRef.current[currentMeetingId] = elapsed;
        setElapsedSeconds(elapsed);
      } else {
        meetingResumeOffsetRef.current[currentMeetingId] = elapsedSeconds;
        setElapsedSeconds(elapsedSeconds);
      }
      setMeetings((prev) =>
        prev.map((m) =>
          m.id === currentMeetingId
            ? { ...m, status: "stopping", status_detail: "Stopping meeting…" }
            : m
        )
      );
      setStartedMeetings((prev) => ({ ...prev, [currentMeetingId]: true }));
    }
    loadMeetings();
  };

  const handleResetMeeting = useCallback(async () => {
    if (!currentMeetingId) return;

    if (connected) {
      stopMeeting();
    }

    try {
      const res = await fetch(`${apiBase}/meetings/${currentMeetingId}/reset`, {
        method: "POST",
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error("Failed to reset meeting:", errorData);
        return;
      }

      setMeetingHistory((prev) => ({
        ...prev,
        [currentMeetingId]: [],
      }));
      resetLogsState({ meetingId: currentMeetingId, clearCache: true });
      setStatus("idle");
      setView("settings");
      setMeetings((prev) =>
        prev.map((m) =>
          m.id === currentMeetingId
            ? { ...m, has_history: false }
            : m
        )
      );
      setStartedMeetings((prev) => {
        const next = { ...prev };
        delete next[currentMeetingId];
        return next;
      });
      delete meetingStartRef.current[currentMeetingId];
      delete meetingResumeOffsetRef.current[currentMeetingId];
      setElapsedSeconds(0);
      await loadMeetings();
    } catch (err) {
      console.error("Failed to reset meeting:", err);
    }
  }, [apiBase, connected, currentMeetingId, loadMeetings, stopMeeting, resetLogsState]);

  const backToSettings = () => {
    if (wsRef.current) {
      manualDisconnectRef.current = true;
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    setConnected(false);
    setStatus((prev) =>
      ["finished", "timeout", "stopped", "stopping"].includes(prev) ? prev : "detached"
    );
    setView("settings");
    loadMeetings();
  };

  const goToHome = useCallback(() => {
    if (wsRef.current) {
      manualDisconnectRef.current = true;
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    setConnected(false);
    setWaitingForUser(false);
    setStatus("idle");
    setCurrentMeetingId(null);
    setMeetingTitle("");
    updateSetting('globalGoals', DEFAULT_GLOBAL_GOAL);
    setParticipants([]);
    setOrder([]);
    resetLogsState();
    setIncludeHuman(false);
    setUserMessage("");
    setView("settings");
    setContextMenu(null);
    setIsEditingTitle(false);
    setEditingParticipant(null);
    setShowModal(false);
    setElapsedSeconds(0);
    loadMeetings();
  }, [loadMeetings, resetLogsState]);

  useEffect(() => {
    return () => {
      try {
        manualDisconnectRef.current = true;
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
      } catch {}
    };
  }, []);

  useEffect(() => {
    if (!currentMeetingId) {
      setElapsedSeconds(0);
      return;
    }
    tickElapsed();
  }, [currentMeetingId, status, tickElapsed]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  useEffect(() => {
    if (settingsLocked && isEditingTitle) {
      setIsEditingTitle(false);
    }
    if (settingsLocked) {
      setContextMenu((prev) =>
        prev && (prev.type === 'participant' || prev.type === 'human') ? null : prev
      );
    }
  }, [settingsLocked, isEditingTitle]);

  useEffect(() => {
    if (settingsLocked) {
      setIsDragOverSettings(false);
      setIsDragOverParticipants(false);
    }
  }, [settingsLocked]);

  // Close a socket left over from another meeting whenever the selected
  // meeting changes. Some paths (create/duplicate/sample generation) switch
  // currentMeetingId without closing the socket; without this, that socket
  // keeps streaming its meeting's events into the newly displayed chat.
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && wsMeetingIdRef.current && wsMeetingIdRef.current !== currentMeetingId) {
      manualDisconnectRef.current = true;
      try {
        ws.close();
      } catch {}
      wsRef.current = null;
      wsMeetingIdRef.current = null;
      setConnected(false);
    }
  }, [currentMeetingId, setConnected]);

  useEffect(() => {
    if (!currentMeetingId) return;
    if (connected) return;
    if (view !== "meeting") return;
    if (wsRef.current) return;
    const meta = meetings.find((m) => m.id === currentMeetingId);
    if (!meta) return;
    const activeStatuses = ["running", "stopping"];
    if (meta.status && activeStatuses.includes(meta.status.toLowerCase())) {
      startMeetingWS();
    }
  }, [currentMeetingId, connected, view, meetings, startMeetingWS]);

  return (
    <div className="h-screen bg-surface flex overflow-hidden relative">
      <Sidebar
        isSidebarOpen={isSidebarOpen}
        setIsSidebarOpen={setIsSidebarOpen}
        meetings={meetings}
        currentMeetingId={currentMeetingId}
        elapsedSeconds={elapsedSeconds}
        nowSeconds={nowSeconds}
        meetingStartRef={meetingStartRef}
        meetingResumeOffsetRef={meetingResumeOffsetRef}
        onGoHome={goToHome}
        onCreateNewMeeting={createNewMeeting}
        onGenerateRandomSample={generateRandomSample}
        onSelectMeeting={selectMeeting}
        onDeleteAllMeetings={deleteAllMeetings}
        onOpenApiSettings={() => setShowApiSettings(true)}
        setContextMenu={setContextMenu}
      />

      {/* Main Content */}
      <main
        className="flex-1 flex flex-col min-h-0 overflow-hidden bg-surface"
      >
        {!currentMeetingId ? (
          <EmptyState onStart={createNewMeeting} />
        ) : view === "settings" ? (
          <SettingsView
            settingsLocked={settingsLocked}
            currentMeetingHasHistory={currentMeetingHasHistory}
            canStart={canStart}
            onBackToMeeting={backToMeeting}
            onStartMeeting={startMeetingWS}
            onViewStatistics={() => setView("statistics")}
            onDownloadSettings={downloadMeetingSettings}
            onImportSettings={triggerFilePicker}
            onResetMeeting={handleResetMeeting}
            isDragOverSettings={isDragOverSettings}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            isGeneratingSample={isGeneratingSample}
            randomSampleError={randomSampleError}
            onOpenApiSettings={() => setShowApiSettings(true)}
            onDismissRandomSampleError={() => setRandomSampleError(null)}
            fileInputRef={fileInputRef}
            onFileInputChange={handleFileInputChange}
            meetingTitle={meetingTitle}
            setMeetingTitle={setMeetingTitle}
            isEditingTitle={isEditingTitle}
            setIsEditingTitle={setIsEditingTitle}
            updateMeetingTitle={updateMeetingTitle}
            participants={participants}
            order={order}
            setOrder={setOrder}
            includeHuman={includeHuman}
            updateIncludeHuman={updateIncludeHuman}
            humanName={humanName}
            humanAvatar={humanAvatar}
            humanRole={humanRole}
            onEditHuman={() => setShowHumanModal(true)}
            onHumanMenuOpen={showHumanMenu}
            tooManyFacilitators={facilitatorCount >= 2}
            currentMeetingId={currentMeetingId}
            connected={connected}
            apiBase={apiBase}
            isDragOverParticipants={isDragOverParticipants}
            onAddParticipant={openAddModal}
            onDownloadParticipants={downloadParticipants}
            onRemoveAllParticipants={removeAllParticipants}
            onParticipantsDragOver={handleParticipantsDragOver}
            onParticipantsDragLeave={handleParticipantsDragLeave}
            onParticipantsDrop={handleParticipantsDrop}
            showParticipantMenu={showParticipantMenu}
            onViewParticipant={viewParticipant}
          />
        ) : view === "statistics" ? (
          <StatisticsView
            meetingId={currentMeetingId}
            apiBase={apiBase}
            onBackToSettings={backToSettings}
            onViewMeeting={() => setView("meeting")}
          />
        ) : (
          <MeetingView
            meetingTitle={meetingTitle}
            globalGoals={globalGoals}
            connected={connected}
            // The live status state resets to "idle" on a page reload and is
            // only updated by WS events, which a stopped meeting never sends.
            // Fall back to the server-side meta status so e.g. the header's
            // Resume button stays clickable after a reload.
            status={
              status === "idle"
                ? meetings.find((m) => m.id === currentMeetingId)?.status ?? status
                : status
            }
            onBackToSettings={backToSettings}
            onViewStatistics={() => setView("statistics")}
            onStopMeeting={stopMeeting}
            onResumeMeeting={startMeetingWS}
            logs={logs}
            expandedObservations={expandedObservations}
            setExpandedObservations={setExpandedObservations}
            chatContainerRef={chatContainerRef}
            handleChatScroll={handleChatScroll}
            logsEndRef={logsEndRef}
            showScrollButton={showScrollButton}
            scrollToBottom={scrollToBottom}
            routeScrollPositionsRef={routeScrollPositionsRef}
            participantAvatars={participantAvatars}
            parallelVoting={!voteSettingsLinked && voteTurnRule === "parallel"}
            votingRule={draftVotingRule}
            humanName={humanName}
            humanAvatar={humanAvatar}
            includeHuman={includeHuman}
            waitingForUser={waitingForUser}
            humanTurnData={humanTurnData}
            waitingForVote={waitingForVote}
            votingData={votingData}
            waitingForSelect={waitingForSelect}
            selectSpeakerData={selectSpeakerData}
            sendUserSelection={sendUserSelection}
            waitingForAskAnswer={waitingForAskAnswer}
            askAnswerData={askAnswerData}
            sendAskAnswer={sendAskAnswer}
            userMessage={userMessage}
            setUserMessage={setUserMessage}
            needModification={needModification}
            setNeedModification={setNeedModification}
            routeVoteSelections={routeVoteSelections}
            setRouteVoteSelections={setRouteVoteSelections}
            consensusVoteSelections={consensusVoteSelections}
            setConsensusVoteSelections={setConsensusVoteSelections}
            sendHumanAction={sendHumanAction}
            sendUserVote={sendUserVote}
            generateHumanRoute={generateHumanRoute}
            modelGroups={draftModelGroups}
            defaultModel={defaultDraftModel}
          />
        )}
      </main>

      {/* Add Participant Modal */}
      <ParticipantModal
        showModal={showModal}
        editingParticipant={editingParticipant}
        form={form}
        setForm={setForm}
        participantError={participantError}
        onClose={closeModal}
        onSave={addParticipant}
        integrations={integrations}
        ollamaModels={ollamaModels}
        apiBase={apiBase}
        readOnly={settingsLocked}
      />

      {/* Human (You) name & icon Modal */}
      <HumanModal
        show={showHumanModal}
        initialName={humanName}
        initialAvatar={humanAvatar}
        initialRole={humanRole}
        onSave={updateHumanProfile}
        onClose={() => setShowHumanModal(false)}
      />

      {/* API Settings Modal */}
      <ApiSettingsModal
        showApiSettings={showApiSettings}
        apiKeyStatus={apiKeyStatus}
        apiKeyInputs={apiKeyInputs}
        apiKeyMessages={apiKeyMessages}
        apiKeyLoading={apiKeyLoading}
        apiBase={apiBase}
        onClose={() => setShowApiSettings(false)}
        onApiKeyInputChange={(provider, value) =>
          setApiKeyInputs((prev) => ({ ...prev, [provider]: value }))
        }
        onApiKeySave={handleApiKeySave}
        integrations={integrations}
        ollamaModels={ollamaModels}
        ollamaLoading={ollamaLoading}
        refreshIntegrations={refreshIntegrations}
      />

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          contextMenu={contextMenu}
          settingsLocked={settingsLocked}
          participants={participants}
          onClose={() => setContextMenu(null)}
          onEditMeeting={() => {
            setIsEditingTitle(true);
            setView("settings");
          }}
          onDuplicateMeeting={duplicateMeeting}
          onDeleteMeeting={deleteMeeting}
          onExportData={exportMeetingData}
          onEditParticipant={openEditParticipant}
          onDuplicateParticipant={duplicateParticipant}
          onDeleteParticipant={deleteParticipant}
          onEditHuman={() => setShowHumanModal(true)}
          onDeleteHuman={deleteHuman}
        />
      )}
    </div>
  );
}
