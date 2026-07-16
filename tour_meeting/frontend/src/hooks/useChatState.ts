import { useState, useCallback, useRef } from "react";
import type { LogEntry } from "../types";

export interface ChatState {
  logs: LogEntry[];
  connected: boolean;
  status: string;
  userMessage: string;
  needModification: boolean;
  waitingForUser: boolean;
  humanTurnData: any;
  waitingForVote: boolean;
  votingData: any;
  waitingForSelect: boolean;
  selectSpeakerData: any;
  waitingForAskAnswer: boolean;
  askAnswerData: any;
  expandedInternalLogs: Record<string, boolean>;
  expandedObservations: Record<string, boolean>;
}

export interface VoteSelections {
  consensusVoteSelections: {
    approved: number[];
    rejected: number[];
    scores: { modification_id: number; score: number }[];
    message: string;
  };
  routeVoteSelections: {
    accept: boolean | null;
    score: number | null;
    message: string;
  };
}

export interface ChatStateActions {
  setLogs: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  setConnected: (value: boolean) => void;
  setStatus: (value: string) => void;
  setUserMessage: (value: string) => void;
  setNeedModification: (value: boolean) => void;
  setWaitingForUser: (value: boolean) => void;
  setHumanTurnData: (value: any) => void;
  setWaitingForVote: (value: boolean) => void;
  setVotingData: (value: any) => void;
  setWaitingForSelect: (value: boolean) => void;
  setSelectSpeakerData: (value: any) => void;
  setWaitingForAskAnswer: (value: boolean) => void;
  setAskAnswerData: (value: any) => void;
  setExpandedInternalLogs: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setExpandedObservations: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setConsensusVoteSelections: React.Dispatch<React.SetStateAction<VoteSelections["consensusVoteSelections"]>>;
  setRouteVoteSelections: React.Dispatch<React.SetStateAction<VoteSelections["routeVoteSelections"]>>;
  resetChatState: () => void;
  resetVoteSelections: () => void;
  wsRef: React.MutableRefObject<WebSocket | null>;
}

const DEFAULT_CONSENSUS_VOTE: VoteSelections["consensusVoteSelections"] = {
  approved: [],
  rejected: [],
  scores: [],
  message: "",
};

const DEFAULT_ROUTE_VOTE: VoteSelections["routeVoteSelections"] = {
  accept: null,
  score: null,
  message: "",
};

export function useChatState(): ChatState & VoteSelections & ChatStateActions {
  // Chat/Meeting state
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("idle");
  const [userMessage, setUserMessage] = useState<string>("");
  const [needModification, setNeedModification] = useState<boolean>(false);
  const [waitingForUser, setWaitingForUser] = useState<boolean>(false);
  const [humanTurnData, setHumanTurnData] = useState<any>(null);
  const [waitingForVote, setWaitingForVote] = useState<boolean>(false);
  const [votingData, setVotingData] = useState<any>(null);
  const [waitingForSelect, setWaitingForSelect] = useState<boolean>(false);
  const [selectSpeakerData, setSelectSpeakerData] = useState<any>(null);
  const [waitingForAskAnswer, setWaitingForAskAnswer] = useState<boolean>(false);
  const [askAnswerData, setAskAnswerData] = useState<any>(null);

  // Expanded state for internal logs
  const [expandedInternalLogs, setExpandedInternalLogs] = useState<Record<string, boolean>>({});
  const [expandedObservations, setExpandedObservations] = useState<Record<string, boolean>>({});

  // Vote selections
  const [consensusVoteSelections, setConsensusVoteSelections] = useState<VoteSelections["consensusVoteSelections"]>(DEFAULT_CONSENSUS_VOTE);
  const [routeVoteSelections, setRouteVoteSelections] = useState<VoteSelections["routeVoteSelections"]>(DEFAULT_ROUTE_VOTE);

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);

  const resetChatState = useCallback(() => {
    setLogs([]);
    setConnected(false);
    setStatus("idle");
    setUserMessage("");
    setNeedModification(false);
    setWaitingForUser(false);
    setHumanTurnData(null);
    setWaitingForVote(false);
    setVotingData(null);
    setWaitingForSelect(false);
    setSelectSpeakerData(null);
    setWaitingForAskAnswer(false);
    setAskAnswerData(null);
    setExpandedInternalLogs({});
    setExpandedObservations({});
    setConsensusVoteSelections(DEFAULT_CONSENSUS_VOTE);
    setRouteVoteSelections(DEFAULT_ROUTE_VOTE);
  }, []);

  const resetVoteSelections = useCallback(() => {
    setConsensusVoteSelections(DEFAULT_CONSENSUS_VOTE);
    setRouteVoteSelections(DEFAULT_ROUTE_VOTE);
  }, []);

  return {
    // State
    logs,
    connected,
    status,
    userMessage,
    needModification,
    waitingForUser,
    humanTurnData,
    waitingForVote,
    votingData,
    waitingForSelect,
    selectSpeakerData,
    waitingForAskAnswer,
    askAnswerData,
    expandedInternalLogs,
    expandedObservations,
    consensusVoteSelections,
    routeVoteSelections,
    // Actions
    setLogs,
    setConnected,
    setStatus,
    setUserMessage,
    setNeedModification,
    setWaitingForUser,
    setHumanTurnData,
    setWaitingForVote,
    setVotingData,
    setWaitingForSelect,
    setSelectSpeakerData,
    setWaitingForAskAnswer,
    setAskAnswerData,
    setExpandedInternalLogs,
    setExpandedObservations,
    setConsensusVoteSelections,
    setRouteVoteSelections,
    resetChatState,
    resetVoteSelections,
    wsRef,
  };
}
