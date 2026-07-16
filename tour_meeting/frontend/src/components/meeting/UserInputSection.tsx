import React from "react";
import { Vote } from "lucide-react";
import type { Avatar, LogEntry } from "../../types";
import CharacterAvatar from "../CharacterAvatar";
import { humanDisplayLabel } from "../../utils/human";
import HumanRouteEditor, { EditableDestination, toEditableDestination } from "./HumanRouteEditor";
import ChatComposer from "./ChatComposer";
import type { ModelOptionGroup } from "../../constants";

interface RouteVoteSelections {
  accept: boolean | null;
  score: number | null;
  message: string;
}

interface ConsensusVoteSelections {
  approved: number[];
  rejected: number[];
  scores: { modification_id: number; score: number }[];
  message: string;
}

interface HumanTurnData {
  step: number;
  maxSteps: number;
  candidates: string[];
  canAsk: boolean;
  canPropose: boolean;
  /** The currently accepted route, used to seed the propose editor. */
  currentRoute?: Partial<EditableDestination>[];
}

interface UserInputSectionProps {
  includeHuman: boolean;
  connected: boolean;
  waitingForUser: boolean;
  humanTurnData: HumanTurnData | null;
  waitingForVote: boolean;
  votingData: any;
  waitingForSelect: boolean;
  selectSpeakerData: { turn: number; candidates: string[] } | null;
  sendUserSelection: (speaker: string) => void;
  waitingForAskAnswer: boolean;
  askAnswerData: { turn: number; asker: string; question: string } | null;
  sendAskAnswer: (answer: string) => void;
  participantAvatars?: Record<string, Avatar | null | undefined>;
  humanName?: string;
  humanAvatar?: Avatar | null;
  userMessage: string;
  setUserMessage: (message: string) => void;
  needModification: boolean;
  setNeedModification: (need: boolean) => void;
  routeVoteSelections: RouteVoteSelections;
  setRouteVoteSelections: (selections: RouteVoteSelections) => void;
  consensusVoteSelections: ConsensusVoteSelections;
  setConsensusVoteSelections: (selections: ConsensusVoteSelections) => void;
  sendHumanAction: (action: any) => void;
  sendUserVote: (vote: any) => void;
  generateHumanRoute: (
    description: string,
    route: any[],
    model?: string,
    history?: { role: string; content: string }[]
  ) => Promise<any>;
  logs: LogEntry[];
  /** Selectable models for the AI route-draft dialog's model picker (same
   *  groups as the participant "Model" dropdown). */
  modelGroups: ModelOptionGroup[];
  /** Model preselected in the AI route-draft dialog's model picker. */
  defaultModel: string;
}

type SpeakAction = "speak" | "ask" | "propose" | "satisfied";
type VoteAction = "judge" | "ask";

const UserInputSection: React.FC<UserInputSectionProps> = ({
  includeHuman,
  connected,
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
  participantAvatars = {},
  humanName = "You",
  humanAvatar = null,
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
  logs,
  modelGroups,
  defaultModel,
}) => {
  // ── Local interaction state (an LLM-like action chooser) ──
  const [speakAction, setSpeakAction] = React.useState<SpeakAction>("speak");
  const [voteAction, setVoteAction] = React.useState<VoteAction>("judge");
  const [askTarget, setAskTarget] = React.useState<string>("");
  const [route, setRoute] = React.useState<EditableDestination[]>([]);

  const speaking = waitingForUser && !!humanTurnData;
  const voting = waitingForVote && !!votingData;
  const answering = waitingForAskAnswer && !!askAnswerData;

  // Reset the speaking action chooser whenever a new speaking step begins.
  React.useEffect(() => {
    if (speaking) {
      setSpeakAction("speak");
      const cands = humanTurnData?.candidates ?? [];
      setAskTarget(cands[0] ?? "");
      // At the start of the turn, seed the propose editor with the currently
      // accepted route (if any) as an editable starting point. Only on step 1
      // so an intermediate ask doesn't wipe edits made this turn.
      if (humanTurnData?.step === 1) {
        setRoute((humanTurnData?.currentRoute ?? []).map(toEditableDestination));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForUser, humanTurnData?.step]);

  // Reset the voting action chooser whenever a new voting step begins.
  React.useEffect(() => {
    if (voting) {
      setVoteAction("judge");
      const cands = votingData?.candidates ?? [];
      setAskTarget(cands[0] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingForVote, votingData?.step]);

  if (!includeHuman || !connected) {
    return null;
  }

  // Refinement-phase flag (kept for the "needs modification" checkbox).
  const phaseEntries = logs.filter((e) => e.kind === "phase");
  const hasRefinementPhase = phaseEntries.some((e: any) => e.title === "Route Refinement Phase");
  const hasDraftingPhase = phaseEntries.some((e: any) => e.title === "Route Drafting");
  const lastDraftingIndex = phaseEntries.findLastIndex((e: any) => e.title === "Route Drafting");
  const lastRefinementIndex = phaseEntries.findLastIndex((e: any) => e.title === "Route Refinement Phase");
  const isRefinementPhase =
    hasRefinementPhase && (!hasDraftingPhase || lastRefinementIndex > lastDraftingIndex);

  const speakCandidates = humanTurnData?.candidates ?? [];
  const voteCandidates = votingData?.candidates ?? [];

  // ── Submit handlers ──
  const submitSpeakComposer = () => {
    if (!speaking) return;
    const text = userMessage.trim();
    if (speakAction === "ask") {
      if (!askTarget || !text) return;
      sendHumanAction({ action: "ask", target: askTarget, message: text });
    } else if (speakAction === "speak") {
      if (!text) return;
      sendHumanAction({ action: "speak", message: text, need_modification: needModification });
    }
  };

  const submitSatisfied = () => {
    if (!speaking) return;
    sendHumanAction({ action: "satisfied", message: userMessage.trim() });
  };

  const submitProposal = () => {
    if (!speaking) return;
    // Drop the client-only drag id; send just the schema fields.
    const cleaned = route
      .filter((d) => d.name.trim())
      .map(({ id: _id, ...d }) => d);
    if (cleaned.length < 2) return;
    sendHumanAction({ action: "propose", message: userMessage.trim(), route: cleaned });
  };

  const submitVoteAsk = () => {
    if (!voting) return;
    const text = userMessage.trim();
    if (!askTarget || !text) return;
    sendUserVote({ action: "ask", target: askTarget, message: text });
  };

  const submitJudge = () => {
    if (!voting) return;
    const isScoreBased = ["most_pleasure", "least_misery"].includes(
      votingData?.options?.voting_rule || ""
    );
    if (isScoreBased) {
      if (routeVoteSelections.score === null) return;
      sendUserVote({ action: "judge", score: routeVoteSelections.score, message: userMessage.trim() });
    } else {
      if (routeVoteSelections.accept === null) return;
      sendUserVote({ action: "judge", accept: routeVoteSelections.accept, message: userMessage.trim() });
    }
  };

  const scoreBased = ["most_pleasure", "least_misery"].includes(
    votingData?.options?.voting_rule || ""
  );
  const judgeReady = scoreBased
    ? routeVoteSelections.score !== null
    : routeVoteSelections.accept !== null;
  // A proposal needs at least two named stops before it can be sent.
  const proposeReady = route.filter((d) => d.name.trim()).length >= 2;

  // ── Composer wiring ──
  let composerPlaceholder = "Waiting for your turn to speak...";
  let composerDisabled = true;
  let composerOnSubmit: () => void = () => {};
  let composerHideSend = true;
  let composerSendIcon: React.ReactNode | undefined = undefined;
  let composerSendEnabled: boolean | undefined = undefined;

  if (answering) {
    composerDisabled = false;
    composerPlaceholder = "Type your answer...";
    composerHideSend = false;
    composerOnSubmit = () => {
      const text = userMessage.trim();
      if (!text) return;
      sendAskAnswer(text);
      setUserMessage("");
    };
  } else if (speaking) {
    composerDisabled = false;
    if (speakAction === "ask") {
      composerPlaceholder = "Type your question...";
      composerHideSend = false;
      composerOnSubmit = submitSpeakComposer;
    } else if (speakAction === "speak") {
      composerPlaceholder = "Type your message...";
      composerHideSend = false;
      composerOnSubmit = submitSpeakComposer;
    } else if (speakAction === "propose") {
      // Submit the route from the composer's send button (no separate "Propose
      // route" button); it enables once the route has at least two named stops.
      composerPlaceholder = "Describe your proposal (optional)...";
      composerHideSend = false;
      composerOnSubmit = submitProposal;
      composerSendEnabled = proposeReady;
    } else if (speakAction === "satisfied") {
      // Conclude from the normal composer: a comment is optional, so the send
      // button is always enabled.
      composerPlaceholder = "Add a comment (optional)...";
      composerHideSend = false;
      composerOnSubmit = submitSatisfied;
      composerSendEnabled = true;
    }
  } else if (voting) {
    composerDisabled = false;
    if (voteAction === "ask") {
      composerPlaceholder = "Type your question...";
      composerHideSend = false;
      composerOnSubmit = submitVoteAsk;
    } else {
      // Judge: keep the composer's shape but swap the send icon for a vote
      // mark; a comment is optional, so it enables once a choice is made.
      composerPlaceholder = "Add a comment (optional)...";
      composerHideSend = false;
      composerOnSubmit = submitJudge;
      composerSendIcon = <Vote className="w-4 h-4" />;
      composerSendEnabled = judgeReady;
    }
  }

  // The speaking action tabs live in the composer's footer (bottom-left) so
  // they stay put while the header above grows/shrinks with the chosen action.
  const speakTabs = (
    <ActionTabs
      options={[
        { key: "speak", label: "Speak" },
        ...(humanTurnData?.canAsk && speakCandidates.length
          ? [{ key: "ask", label: "Ask" }]
          : []),
        ...(humanTurnData?.canPropose ? [{ key: "propose", label: "Propose" }] : []),
        { key: "satisfied", label: "Satisfied" },
      ]}
      value={speakAction}
      onChange={(v) => setSpeakAction(v as SpeakAction)}
    />
  );
  // The voting action tabs live in the same composer footer as the speaking
  // tabs, so they stay put while the judge/ask controls above change.
  const voteTabs = (
    <ActionTabs
      options={[
        { key: "judge", label: "Judge" },
        ...(votingData?.canAsk && voteCandidates.length ? [{ key: "ask", label: "Ask" }] : []),
      ]}
      value={voteAction}
      onChange={(v) => setVoteAction(v as VoteAction)}
    />
  );
  // The header above the composer is shown only when the chosen action has
  // extra controls; otherwise the composer stands alone.
  const showSpeakHeader =
    speaking &&
    (speakAction === "ask" ||
      speakAction === "propose" ||
      speakAction === "satisfied" ||
      (speakAction === "speak" && isRefinementPhase));

  return (
    <div className="py-4">
      <div className="max-w-5xl mx-auto w-full px-6 space-y-4">
        {/* Facilitator: pick the next speaker (bypasses the action chooser). */}
        {waitingForSelect && selectSpeakerData && (
          <SelectSpeakerPanel
            candidates={selectSpeakerData.candidates}
            avatars={participantAvatars}
            humanName={humanName}
            humanAvatar={humanAvatar}
            sendUserSelection={sendUserSelection}
          />
        )}

        {/* Persistent composer + optional header that grows from behind the
            chat box (speaking action chooser, ask-answer question, or the
            voting controls). */}
        <div className="relative">
          {answering && (
            <div className="rounded-t-lg border border-b-0 border-outline bg-surface-secondary px-3 pt-2.5 pb-5 -mb-3">
              <div className="flex items-center gap-2 -ml-0.5">
                <div className="w-5 h-5 flex-shrink-0 overflow-hidden">
                  <CharacterAvatar
                    avatar={participantAvatars[askAnswerData!.asker]}
                    name={askAnswerData!.asker}
                    size={20}
                  />
                </div>
                <div className="text-sm font-semibold text-on-surface leading-5">
                  {askAnswerData!.asker} asked you a question
                </div>
              </div>
              <div className="mt-1.5 text-sm text-on-surface-secondary whitespace-pre-wrap">
                {askAnswerData!.question}
              </div>
            </div>
          )}
          {voting && (
            <div className="rounded-t-lg border border-b-0 border-outline bg-surface-secondary px-3 pt-3 pb-5 -mb-3 space-y-3 max-h-[60vh] overflow-y-auto">
              {voteAction === "judge" && votingData.vote_type === "route" && (
                <RouteJudgeControls
                  votingData={votingData}
                  routeVoteSelections={routeVoteSelections}
                  setRouteVoteSelections={setRouteVoteSelections}
                />
              )}
              {voteAction === "judge" &&
                votingData.vote_type === "consensus" &&
                votingData.options?.candidates && (
                  <ConsensusVotingPanel
                    votingData={votingData}
                    consensusVoteSelections={consensusVoteSelections}
                    setConsensusVoteSelections={setConsensusVoteSelections}
                    sendUserVote={sendUserVote}
                  />
                )}
              {voteAction === "ask" && (
                <AskTargetPicker
                  candidates={voteCandidates}
                  value={askTarget}
                  onChange={setAskTarget}
                  avatars={participantAvatars}
                />
              )}
            </div>
          )}
          {/* Action-specific content only (the tabs live in the composer's
              footer so they stay put while this header grows/shrinks). */}
          {showSpeakHeader && (
            <div className="rounded-t-lg border border-b-0 border-outline bg-surface-secondary px-3 pt-3 pb-5 -mb-3 space-y-3 max-h-[60vh] overflow-y-auto">
              {speakAction === "ask" && (
                <AskTargetPicker
                  candidates={speakCandidates}
                  value={askTarget}
                  onChange={setAskTarget}
                  avatars={participantAvatars}
                />
              )}
              {speakAction === "propose" && (
                <HumanRouteEditor
                  route={route}
                  setRoute={setRoute}
                  generateHumanRoute={generateHumanRoute}
                  canGenerate={true}
                  modelGroups={modelGroups}
                  defaultModel={defaultModel}
                />
              )}
              {speakAction === "satisfied" && (
                <p className="text-sm text-on-surface-secondary">
                  End your turn while agreeing to conclude the meeting on the
                  current route. The meeting ends once everyone agrees.
                </p>
              )}
              {isRefinementPhase && speakAction === "speak" && (
                <div className="flex items-center gap-3 px-4 py-2 bg-surface border border-outline rounded-lg">
                  <input
                    type="checkbox"
                    id="needModification"
                    checked={needModification}
                    onChange={(e) => setNeedModification(e.target.checked)}
                    className="w-4 h-4 text-zinc-700 dark:text-zinc-300 border-outline-secondary rounded focus:ring-zinc-400"
                  />
                  <label
                    htmlFor="needModification"
                    className="text-sm font-medium text-on-surface-secondary cursor-pointer"
                  >
                    Need further modification
                  </label>
                </div>
              )}
            </div>
          )}
          <div className="relative z-10">
            <ChatComposer
              value={composerDisabled ? "" : userMessage}
              disabled={composerDisabled}
              placeholder={composerPlaceholder}
              hideSend={composerHideSend}
              sendIcon={composerSendIcon}
              sendEnabled={composerSendEnabled}
              onChange={setUserMessage}
              onSubmit={composerOnSubmit}
              footerLeft={voting ? voteTabs : speaking ? speakTabs : undefined}
              tall={answering}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Segmented action chooser ──
interface ActionTabsProps {
  options: { key: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

// Individually-bordered buttons matching the "To:" participant picker, so the
// action chooser and the ask target share one visual language.
const ActionTabs: React.FC<ActionTabsProps> = ({ options, value, onChange }) => (
  <div className="flex flex-wrap gap-2">
    {options.map((opt) => (
      <button
        key={opt.key}
        type="button"
        onClick={() => onChange(opt.key)}
        className={`flex items-center h-9 rounded-lg border px-3 text-sm transition-colors ${
          value === opt.key
            ? "border-accent bg-accent-soft text-accent-soft-text"
            : "border-outline bg-surface text-on-surface hover:border-accent"
        }`}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

// ── Ask target picker ──
interface AskTargetPickerProps {
  candidates: string[];
  value: string;
  onChange: (value: string) => void;
  avatars: Record<string, Avatar | null | undefined>;
}

const AskTargetPicker: React.FC<AskTargetPickerProps> = ({ candidates, value, onChange, avatars }) => (
  <div className="flex min-h-[2.25rem] items-center gap-2">
    <span className="text-sm text-on-surface-secondary">To:</span>
    <div className="flex flex-wrap gap-2">
      {candidates.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => onChange(name)}
          className={`flex items-center gap-2 h-9 rounded-lg border px-3 text-sm transition-colors ${
            value === name
              ? "border-accent bg-accent-soft text-accent-soft-text"
              : "border-outline bg-surface text-on-surface hover:border-accent"
          }`}
        >
          <div className="w-5 h-5 flex-shrink-0 overflow-hidden">
            <CharacterAvatar avatar={avatars[name]} name={name} size={20} />
          </div>
          {name}
        </button>
      ))}
    </div>
  </div>
);

// ── Select-Next-Speaker Panel (human facilitator) ──
interface SelectSpeakerPanelProps {
  candidates: string[];
  avatars: Record<string, Avatar | null | undefined>;
  humanName: string;
  humanAvatar: Avatar | null;
  sendUserSelection: (speaker: string) => void;
}

const SelectSpeakerPanel: React.FC<SelectSpeakerPanelProps> = ({
  candidates,
  avatars,
  humanName,
  humanAvatar,
  sendUserSelection,
}) => {
  const isHuman = (name: string) => name === "__YOU__";
  const labelFor = (name: string) => (isHuman(name) ? humanDisplayLabel(humanName) : name);
  const avatarFor = (name: string) => (isHuman(name) ? humanAvatar : avatars[name]);
  const avatarName = (name: string) => (isHuman(name) ? humanName : name);

  return (
    <div className="bg-surface-secondary border border-outline rounded-lg p-4 space-y-3">
      <h3 className="font-semibold text-on-surface">Choose who speaks next</h3>
      <p className="text-sm text-on-surface-tertiary">
        As the facilitator, pick who speaks next (you can pick yourself).
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {candidates.map((name) => (
          <button
            key={name}
            onClick={() => sendUserSelection(name)}
            className="flex items-center gap-3 rounded-lg border border-outline bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft"
          >
            <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
              <CharacterAvatar avatar={avatarFor(name)} name={avatarName(name)} size={26} />
            </div>
            <span className="font-medium text-on-surface truncate">{labelFor(name)}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

// ── Route judge controls (accept/reject or score; no proposal card — the
// proposal is already visible in the chat. The message comes from the composer
// and this renders inside the header that grows from behind the chat box). ──
interface RouteJudgeControlsProps {
  votingData: any;
  routeVoteSelections: RouteVoteSelections;
  setRouteVoteSelections: (selections: RouteVoteSelections) => void;
}

const RouteJudgeControls: React.FC<RouteJudgeControlsProps> = ({
  votingData,
  routeVoteSelections,
  setRouteVoteSelections,
}) => {
  const votingRule = votingData.options?.voting_rule || "";
  const isScoreBased = ["most_pleasure", "least_misery"].includes(votingRule);

  if (isScoreBased) {
    return (
      <div className="flex h-9 items-center gap-3">
        <label htmlFor="humanVoteScore" className="text-sm font-medium text-on-surface-secondary">
          Score (1-10):
        </label>
        <input
          id="humanVoteScore"
          type="number"
          min="1"
          max="10"
          step="1"
          value={routeVoteSelections.score ?? ""}
          onChange={(e) => {
            const value = e.target.value;
            let score: number | null = null;
            if (value !== "") {
              const numValue = parseInt(value, 10);
              if (!isNaN(numValue) && numValue >= 1 && numValue <= 10) score = numValue;
            }
            setRouteVoteSelections({ ...routeVoteSelections, score });
          }}
          className="w-24 h-9 px-3 border border-outline-secondary rounded focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <button
        onClick={() => setRouteVoteSelections({ ...routeVoteSelections, accept: true })}
        className={`w-28 h-9 flex items-center justify-center px-4 text-sm font-medium rounded-lg border transition-colors ${
          routeVoteSelections.accept === true
            ? "border-emerald-600 bg-emerald-100 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-900/30 dark:text-emerald-400"
            : "border-outline bg-surface text-on-surface-secondary hover:bg-surface-secondary"
        }`}
      >
        {routeVoteSelections.accept === true ? "✓ Accept" : "Accept"}
      </button>
      <button
        onClick={() => setRouteVoteSelections({ ...routeVoteSelections, accept: false })}
        className={`w-28 h-9 flex items-center justify-center px-4 text-sm font-medium rounded-lg border transition-colors ${
          routeVoteSelections.accept === false
            ? "border-red-600 bg-red-100 text-red-700 dark:border-red-500 dark:bg-red-900/30 dark:text-red-400"
            : "border-outline bg-surface text-on-surface-secondary hover:bg-surface-secondary"
        }`}
      >
        {routeVoteSelections.accept === false ? "✗ Reject" : "Reject"}
      </button>
    </div>
  );
};

// ── Consensus (modification) voting panel ──
interface ConsensusVotingPanelProps {
  votingData: any;
  consensusVoteSelections: ConsensusVoteSelections;
  setConsensusVoteSelections: (selections: ConsensusVoteSelections) => void;
  sendUserVote: (vote: any) => void;
}

const ConsensusVotingPanel: React.FC<ConsensusVotingPanelProps> = ({
  votingData,
  consensusVoteSelections,
  setConsensusVoteSelections,
  sendUserVote,
}) => {
  const consensusRule = votingData.options?.consensus_rule || "";
  const isScoreBased = ["most_pleasure_threshold", "least_misery_threshold"].includes(consensusRule);

  return (
    <div className="bg-surface-secondary border border-outline rounded-lg p-4 space-y-4">
      <h3 className="font-semibold text-on-surface">Vote on Modifications</h3>
      <div className="space-y-3">
        {votingData.options.candidates.map((candidate: any, idx: number) => {
          const candidateId = candidate.id !== undefined ? candidate.id : idx;
          const isApproved = consensusVoteSelections.approved.includes(candidateId);
          const isRejected = consensusVoteSelections.rejected.includes(candidateId);

          return (
            <div
              key={idx}
              className={`bg-surface border-2 rounded p-3 transition-colors ${
                isApproved
                  ? "border-zinc-600 bg-surface-secondary"
                  : isRejected
                  ? "border-zinc-300 bg-surface-tertiary"
                  : "border-outline"
              }`}
            >
              <div className="flex justify-between items-start mb-2">
                <div className="font-medium text-on-surface">Modification {candidateId}</div>
                {!isScoreBased && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const newApproved = isApproved
                          ? consensusVoteSelections.approved.filter((id) => id !== candidateId)
                          : [...consensusVoteSelections.approved, candidateId];
                        const newRejected = consensusVoteSelections.rejected.filter((id) => id !== candidateId);
                        setConsensusVoteSelections({
                          ...consensusVoteSelections,
                          approved: newApproved,
                          rejected: newRejected,
                        });
                      }}
                      className={`px-3 py-1 text-sm rounded transition-colors ${
                        isApproved
                          ? "bg-accent text-white hover:bg-accent-hover"
                          : "bg-gray-200 text-on-surface-secondary hover:bg-gray-300"
                      }`}
                    >
                      {isApproved ? "✓ Approved" : "Approve"}
                    </button>
                    <button
                      onClick={() => {
                        const newRejected = isRejected
                          ? consensusVoteSelections.rejected.filter((id) => id !== candidateId)
                          : [...consensusVoteSelections.rejected, candidateId];
                        const newApproved = consensusVoteSelections.approved.filter((id) => id !== candidateId);
                        setConsensusVoteSelections({
                          ...consensusVoteSelections,
                          approved: newApproved,
                          rejected: newRejected,
                        });
                      }}
                      className={`px-3 py-1 text-sm rounded transition-colors ${
                        isRejected
                          ? "bg-zinc-500 text-white hover:bg-zinc-600 dark:bg-zinc-400 dark:text-zinc-900 dark:hover:bg-zinc-500"
                          : "bg-gray-200 text-on-surface-secondary hover:bg-gray-300"
                      }`}
                    >
                      {isRejected ? "✓ Rejected" : "Reject"}
                    </button>
                  </div>
                )}
              </div>
              <div className="text-sm text-on-surface-tertiary">
                {candidate.description || "No description"}
              </div>
              {isScoreBased && (
                <div className="mt-3 flex items-center gap-3">
                  <label className="text-sm font-medium text-on-surface-secondary">Score (0-10):</label>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    step="0.1"
                    value={
                      consensusVoteSelections.scores.find((s) => s.modification_id === candidateId)?.score ?? ""
                    }
                    onChange={(e) => {
                      const value = e.target.value;
                      const newScores = consensusVoteSelections.scores.filter(
                        (s) => s.modification_id !== candidateId
                      );
                      if (value !== "") {
                        const numValue = parseFloat(value);
                        if (!isNaN(numValue) && numValue >= 0 && numValue <= 10) {
                          newScores.push({ modification_id: candidateId, score: numValue });
                        }
                      }
                      setConsensusVoteSelections({ ...consensusVoteSelections, scores: newScores });
                    }}
                    placeholder="Optional"
                    className="w-24 px-3 py-1 border border-outline-secondary rounded focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={() => {
          if (isScoreBased) {
            sendUserVote({
              action: "judge",
              approved: [],
              rejected: [],
              scores: consensusVoteSelections.scores,
              message:
                consensusVoteSelections.message ||
                `Submitted ${consensusVoteSelections.scores.length} scores`,
            });
          } else {
            sendUserVote({
              action: "judge",
              approved: consensusVoteSelections.approved,
              rejected: consensusVoteSelections.rejected,
              scores: [],
              message:
                consensusVoteSelections.message ||
                `Approved ${consensusVoteSelections.approved.length}, Rejected ${consensusVoteSelections.rejected.length}`,
            });
          }
        }}
        disabled={isScoreBased ? consensusVoteSelections.scores.length === 0 : false}
        className={`w-full px-4 py-3 font-medium rounded-lg transition-colors ${
          (isScoreBased ? consensusVoteSelections.scores.length > 0 : true)
            ? "bg-accent text-white hover:bg-accent-hover"
            : "bg-gray-300 text-on-surface-tertiary cursor-not-allowed"
        }`}
      >
        {isScoreBased
          ? `Submit Vote (${consensusVoteSelections.scores.length} scored)`
          : `Submit Vote (${consensusVoteSelections.approved.length} approved, ${consensusVoteSelections.rejected.length} rejected)`}
      </button>
    </div>
  );
};

export default UserInputSection;
