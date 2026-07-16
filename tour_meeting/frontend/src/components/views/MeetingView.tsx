import React from "react";
import MeetingHeader from "../meeting/MeetingHeader";
import ChatMessages from "../meeting/ChatMessages";
import UserInputSection from "../meeting/UserInputSection";
import type { Avatar, LogEntry, VotingData, RouteVoteSelection, ConsensusVoteSelection } from "../../types";
import type { ModelOptionGroup } from "../../constants";

interface MeetingViewProps {
  // Header
  meetingTitle: string;
  globalGoals: string;
  connected: boolean;
  status: string;
  onBackToSettings: () => void;
  onViewStatistics: () => void;
  onStopMeeting: () => void;
  onResumeMeeting: () => void;

  // Chat
  logs: LogEntry[];
  expandedObservations: Set<string>;
  setExpandedObservations: React.Dispatch<React.SetStateAction<Set<string>>>;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  handleChatScroll: () => void;
  logsEndRef: React.RefObject<HTMLDivElement | null>;
  showScrollButton: boolean;
  scrollToBottom: () => void;
  routeScrollPositionsRef: React.MutableRefObject<Record<string, number>>;
  participantAvatars?: Record<string, Avatar | null | undefined>;
  /** Whether this meeting casts votes in parallel (vote turn rule). */
  parallelVoting?: boolean;
  /** The proposal-phase voting rule, for the bot's vote tally card. */
  votingRule?: string;
  /** The human participant's engine name, for the "(You)" suffix in chat. */
  humanName?: string;
  humanAvatar?: Avatar | null;

  // User input
  includeHuman: boolean;
  waitingForUser: boolean;
  humanTurnData: { step: number; maxSteps: number; candidates: string[]; canAsk: boolean; canPropose: boolean } | null;
  waitingForVote: boolean;
  votingData: VotingData | null;
  waitingForSelect: boolean;
  selectSpeakerData: { turn: number; candidates: string[] } | null;
  sendUserSelection: (speaker: string) => void;
  waitingForAskAnswer: boolean;
  askAnswerData: { turn: number; asker: string; question: string } | null;
  sendAskAnswer: (answer: string) => void;
  userMessage: string;
  setUserMessage: (message: string) => void;
  needModification: boolean;
  setNeedModification: (need: boolean) => void;
  routeVoteSelections: RouteVoteSelection[];
  setRouteVoteSelections: React.Dispatch<React.SetStateAction<RouteVoteSelection[]>>;
  consensusVoteSelections: ConsensusVoteSelection[];
  setConsensusVoteSelections: React.Dispatch<React.SetStateAction<ConsensusVoteSelection[]>>;
  sendHumanAction: (action: any) => void;
  sendUserVote: (vote: any) => void;
  generateHumanRoute: (
    description: string,
    route: any[],
    model?: string,
    history?: { role: string; content: string }[]
  ) => Promise<any>;
  /** Selectable models for the AI route-draft dialog's model picker (same
   *  groups as the participant "Model" dropdown). */
  modelGroups: ModelOptionGroup[];
  /** Model preselected in the AI route-draft dialog's model picker. */
  defaultModel: string;
}

const MeetingView: React.FC<MeetingViewProps> = ({
  // Header
  meetingTitle,
  globalGoals,
  connected,
  status,
  onBackToSettings,
  onViewStatistics,
  onStopMeeting,
  onResumeMeeting,

  // Chat
  logs,
  expandedObservations,
  setExpandedObservations,
  chatContainerRef,
  handleChatScroll,
  logsEndRef,
  showScrollButton,
  scrollToBottom,
  routeScrollPositionsRef,
  participantAvatars,
  parallelVoting,
  votingRule,
  humanName,
  humanAvatar,

  // User input
  includeHuman,
  waitingForUser,
  humanTurnData,
  waitingForVote,
  votingData,
  waitingForSelect,
  selectSpeakerData,
  sendUserSelection,
  waitingForAskAnswer,
  askAnswerData,
  sendAskAnswer,
  userMessage,
  setUserMessage,
  needModification,
  setNeedModification,
  routeVoteSelections,
  setRouteVoteSelections,
  consensusVoteSelections,
  setConsensusVoteSelections,
  sendHumanAction,
  sendUserVote,
  generateHumanRoute,
  modelGroups,
  defaultModel,
}) => {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <MeetingHeader
        meetingTitle={meetingTitle}
        globalGoals={globalGoals}
        connected={connected}
        status={status}
        onBackToSettings={onBackToSettings}
        onViewStatistics={onViewStatistics}
        onStopMeeting={onStopMeeting}
        onResumeMeeting={onResumeMeeting}
      />

      {/* Full-width scroll area: ChatMessages' pane spans this whole region so
          its scrollbar sits at the page's right edge and the side margins
          scroll natively. The messages stay centered inside the pane. */}
      <div className="flex-1 bg-surface overflow-hidden min-h-0">
        <div className="relative h-full flex flex-col min-h-0">
          <ChatMessages
            logs={logs}
            expandedObservations={expandedObservations}
            setExpandedObservations={setExpandedObservations}
            chatContainerRef={chatContainerRef}
            handleChatScroll={handleChatScroll}
            logsEndRef={logsEndRef}
            showScrollButton={showScrollButton}
            scrollToBottom={scrollToBottom}
            routeScrollPositionsRef={routeScrollPositionsRef}
            avatars={participantAvatars}
            parallelVoting={parallelVoting}
            votingRule={votingRule}
            humanName={humanName}
          />
        </div>
      </div>

      {/* Chat Input for Human Participant */}
      <UserInputSection
        includeHuman={includeHuman}
        connected={connected}
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
        participantAvatars={participantAvatars}
        humanName={humanName}
        humanAvatar={humanAvatar}
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
        logs={logs}
        modelGroups={modelGroups}
        defaultModel={defaultModel}
      />
    </div>
  );
};

export default MeetingView;
