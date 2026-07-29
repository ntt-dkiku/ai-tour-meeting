import React from "react";
import { ChevronDown, ChevronUp, AlertTriangle, Reply, CheckCircle2, XCircle, Vote } from "lucide-react";
import RoutePlanView from "../RoutePlanView";
import CharacterAvatar, { SystemBotAvatar } from "../CharacterAvatar";
import { humanDisplayLabel, normalizeHumanName } from "../../utils/human";
import type { AskExchangeEntry, Avatar, LogEntry, RoutePlan } from "../../types";
import { INVITATION_PHASE_TITLES } from "../../constants";
import { getDisplayContent } from "../../utils/formatting";
import { buildInternalKey } from "../../utils/helpers";
import { normalizeStepsLogForDisplay } from "../../utils/textProcessing";

/** Animated "typing" indicator: three dots bouncing in sequence, shown while
 *  an agent's reply is still being generated (message created but no content). */
function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="Generating reply" role="status">
      {[0, 1, 2].map((n) => (
        <span
          key={n}
          className="typing-dot inline-block w-2 h-2 rounded-full bg-on-surface-tertiary"
          style={{ animationDelay: `${n * 0.18}s` }}
        />
      ))}
    </div>
  );
}

type RetryInfo = { attempt: number; maxAttempts: number; errorMessage: string };

/** Warning marker for a turn that hit a generation retry: a yellow triangle
 *  plus the attempt count. Click to see the error that triggered the retry. */
function RetryBadge({ retryInfo }: { retryInfo: RetryInfo }) {
  return (
    <button
      type="button"
      onClick={() =>
        alert(
          `Retry ${retryInfo.attempt}/${retryInfo.maxAttempts}\n\nError: ${retryInfo.errorMessage}`
        )
      }
      className="inline-flex items-center gap-0.5 text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300 transition-colors"
      title={`Retry ${retryInfo.attempt}/${retryInfo.maxAttempts}: click to see the error`}
      aria-label={`Retry ${retryInfo.attempt} of ${retryInfo.maxAttempts}`}
    >
      <AlertTriangle className="w-3.5 h-3.5" />
      <span className="text-xs font-medium">
        {retryInfo.attempt}/{retryInfo.maxAttempts}
      </span>
    </button>
  );
}

// Key for matching an internal "Ask: X" step against a pending ask exchange.
// Targets are normalized (underscores→spaces) since the thinking step may carry
// a sanitized name while the exchange carries the resolved display name.
const askKey = (turn: number, asker: string, target: string) =>
  `${turn}::${asker}::${(target || "").replace(/_/g, " ").trim().toLowerCase()}`;

// The spoken text of a turn or vote. Some messages carry their whole internal
// log in `content` ("[Steps]\n[Step 1/5 - …]\n…\n[Message]\n<final>"); the
// final statement follows the last "[Message]" marker. Without a marker the
// content is already the statement — strip any stray step markers so a plain
// message never shows raw "[Steps]"/"[Step n/m]" tags.
const extractSpokenText = (raw: string): string => {
  let text = (raw || "").trim();
  if (text.includes("[Message]")) {
    text = text.split("[Message]").pop()!.trim();
  } else if (text.includes("[Step")) {
    text = text
      .replace(/\[Steps?\]/gi, "")
      .replace(/\[Step\s+\d+\s*\/\s*\d+[^\]]*\]/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return text;
};

interface InternalStep {
  stepNumber: number;
  maxSteps: number;
  action?: string;
  thought: string;
  searchQuery?: string;
  askTarget?: string;
  askQuestion?: string;
  askResponse?: string;
  observation?: string;
}

interface ChatMessagesProps {
  logs: LogEntry[];
  expandedObservations: Record<string, boolean>;
  setExpandedObservations: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  chatContainerRef: React.RefObject<HTMLDivElement>;
  handleChatScroll: () => void;
  logsEndRef: React.RefObject<HTMLDivElement>;
  showScrollButton: boolean;
  scrollToBottom: () => void;
  routeScrollPositionsRef: React.MutableRefObject<Record<string, number>>;
  /** Map of participant name → avatar, for message headers. */
  avatars?: Record<string, Avatar | null | undefined>;
  /** Whether votes are cast in parallel (vote turn rule), which picks how the
      vote replies' connectors are drawn: parallel gives every voter a rounded
      branch off the proposal; sequential elbows only the first voter and then
      threads the rest straight down from the first voter's avatar. */
  parallelVoting?: boolean;
  /** The proposal-phase voting rule (majority, unanimous, most_pleasure,
      least_misery, single_decider) — picks the tally explanation shown on the
      bot's result card under a voted proposal. */
  votingRule?: string;
  /** The human participant's engine name (chat events carry it as speaker);
      shown with a "(You)" suffix in the UI. */
  humanName?: string;
  /** The reason the meeting stopped on an error; rendered at the end of the
      log, and the typing dots are suppressed — no final message is coming
      for the in-progress turn. */
  errorMessage?: string | null;
}

const ChatMessages: React.FC<ChatMessagesProps> = ({
  logs,
  expandedObservations,
  setExpandedObservations,
  chatContainerRef,
  handleChatScroll,
  logsEndRef,
  showScrollButton,
  scrollToBottom,
  routeScrollPositionsRef,
  avatars = {},
  parallelVoting = false,
  votingRule = "majority",
  humanName = "You",
  errorMessage = null,
}) => {
  const humanRealName = normalizeHumanName(humanName);
  // Speaker label with the "(You)" suffix for the human participant.
  const speakerLabel = (name: string) =>
    name === humanRealName ? humanDisplayLabel(humanRealName) : name;

  const toggleObservation = (key: string) => {
    setExpandedObservations((prev: Record<string, boolean>) => ({ ...prev, [key]: !prev[key] }));
  };

  // Which message's header is currently pinned at the top (the "stuck" speaker
  // row), or -1 when none is. While a header is stuck we drop the top fade
  // (it would show as a gradient band above the pinned row) and instead fade
  // content out just below that row, as it scrolls under it.
  const [stuckIndex, setStuckIndex] = React.useState(-1);
  const messageBoxRefs = React.useRef<Map<number, HTMLDivElement>>(new Map());

  // Entrance "pop" bookkeeping: decide ONCE per box (step boxes, main message,
  // invitation, route — anything that streams in) whether it should play the
  // pop. Only boxes that appear after the initial mount pop — i.e. streamed
  // live, not loaded from history. The decision is frozen so a later re-render
  // never strips the class mid-animation (which would cut it to an instant).
  const hasMountedRef = React.useRef(false);
  React.useEffect(() => {
    hasMountedRef.current = true;
  }, []);
  const popDecisionRef = React.useRef<Map<string, boolean>>(new Map());
  const popClass = (key: string): string => {
    if (!popDecisionRef.current.has(key)) {
      popDecisionRef.current.set(key, hasMountedRef.current);
    }
    return popDecisionRef.current.get(key) === true ? " chat-pop" : "";
  };

  const recomputeStuck = React.useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    // At the very top nothing is pinned — keep the normal top fade.
    if (container.scrollTop <= 2) {
      setStuckIndex((prev) => (prev === -1 ? prev : -1));
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    let found = -1;
    // The pinned header belongs to the message box straddling the top edge.
    messageBoxRefs.current.forEach((el, idx) => {
      if (found !== -1) return;
      const rect = el.getBoundingClientRect();
      if (rect.top <= containerTop + 1 && rect.bottom > containerTop + 1) {
        found = idx;
      }
    });
    setStuckIndex((prev) => (prev === found ? prev : found));
  }, [chatContainerRef]);

  const onScroll = React.useCallback(() => {
    handleChatScroll();
    recomputeStuck();
  }, [handleChatScroll, recomputeStuck]);

  // Recompute when the log set changes (streaming shifts layout).
  React.useEffect(() => {
    recomputeStuck();
  }, [logs, recomputeStuck]);

  // Ask exchanges by (turn, asker, target), so an "ask" step can render the
  // answer (or a typing indicator while it's pending) inline in its own box.
  const askExchanges = new Map<string, AskExchangeEntry>();
  // Votes are pulled OUT of the top-level flow and re-rendered as threaded
  // replies under the proposal box (like an ask answer). votesByProposal maps a
  // proposal's log index → the indices of the vote messages cast on it; every
  // relocated vote index is tracked so the main map skips it. A vote belongs to
  // the nearest prior participant message carrying a routePlan (the proposal),
  // since phase banners / invitations sit between them in the log.
  const votesByProposal = new Map<number, number[]>();
  const relocatedVotes = new Set<number>();
  // The voting outcome per proposal index, once it's known — either from the
  // streamed proposal_vote_result entry (richest: carries the summary) or,
  // for reloaded history, from the "… Proposal Accepted/Rejected" banner.
  // Drives the bot's tally card appended after the vote replies.
  const voteResultByProposal = new Map<
    number,
    { accepted: boolean; voteSummary?: Record<string, any> }
  >();
  // A "Proposal Skipped" notice threads under its proposal as a System reply
  // (like a vote would), instead of rendering as a standalone banner.
  const skipNoticeByProposal = new Map<number, string>();
  let lastMessageIndex = -1;
  let lastProposalIndex = -1;
  // While a vote is still being generated its stepsLabel isn't set yet, so it
  // can't be recognised by label alone — track the open "… Proposal Voting"
  // phase window instead, and treat any participant message inside it as a
  // vote. That nests the in-progress voter (avatar + typing dots) under the
  // proposal right away instead of flashing it at the top level.
  let inProposalVoting = false;
  logs.forEach((l, idx) => {
    if (l.kind === "ask_exchange") {
      askExchanges.set(askKey(l.turn, l.asker, l.target), l);
      return;
    }
    if (l.kind === "phase") {
      const t = l.title.trim().toLowerCase();
      if (t.includes("proposal skipped")) {
        if (lastProposalIndex >= 0 && !skipNoticeByProposal.has(lastProposalIndex)) {
          skipNoticeByProposal.set(
            lastProposalIndex,
            (l.description ?? "").trim() || "This proposal was skipped."
          );
        }
      } else if (t.includes("proposal voting")) inProposalVoting = true;
      else if (t.includes("proposal accepted") || t.includes("proposal rejected")) {
        inProposalVoting = false;
        // Reloaded histories have no proposal_vote_result entry — the banner
        // is the fallback verdict for the bot's tally card.
        if (lastProposalIndex >= 0 && !voteResultByProposal.has(lastProposalIndex)) {
          voteResultByProposal.set(lastProposalIndex, {
            accepted: t.includes("proposal accepted"),
          });
        }
      }
      return;
    }
    if (l.kind === "proposal_vote_result") {
      if (lastProposalIndex >= 0) {
        voteResultByProposal.set(lastProposalIndex, {
          accepted: l.accepted,
          voteSummary: l.voteSummary,
        });
      }
      return;
    }
    if (l.kind !== "message") return;
    lastMessageIndex = idx;
    const isVote =
      l.stepsLabel === "accept" ||
      l.stepsLabel === "reject" ||
      l.stepsLabel === "scoring" ||
      (inProposalVoting && l.name !== "System");
    if (l.routePlan && l.name !== "System") {
      lastProposalIndex = idx;
    } else if (isVote && lastProposalIndex >= 0) {
      if (!votesByProposal.has(lastProposalIndex)) votesByProposal.set(lastProposalIndex, []);
      votesByProposal.get(lastProposalIndex)!.push(idx);
      relocatedVotes.add(idx);
    }
  });

  // To thread the speaker avatars together with a connector line (the reply
  // rule), mark which log entries actually render and which of those are
  // speaker message boxes. A box draws a line down to the next speaker only when
  // the next thing that renders is itself a speaker box, so the line never
  // dangles toward a phase divider or the end of the log.
  const rendersSomething: boolean[] = new Array(logs.length).fill(false);
  const isSpeakerBox: boolean[] = new Array(logs.length).fill(false);
  // Slim dividers (the "X is satisfied" pill and the "Cycle N" rule) don't
  // break the conversation visually, so the connector line runs straight
  // through them instead of stopping — otherwise every satisfied update or
  // cycle boundary would cut the speaker thread.
  const isPassThrough: boolean[] = new Array(logs.length).fill(false);
  logs.forEach((l, idx) => {
    if (l.kind === "phase") {
      const t = l.title.trim().toLowerCase();
      rendersSomething[idx] = !(
        t === "tour meeting started" ||
        t.includes("proposal voting") ||
        t.includes("proposal accepted") ||
        t.includes("proposal rejected") ||
        // Skip notices thread under their proposal as a System reply.
        t.includes("proposal skipped")
      );
      // Every remaining phase renders as a top-level System speaker box
      // (consensus, and the generic phase announcements), so the previous
      // speaker's trunk threads down to its avatar too. Invitation phases
      // keep their own "Next Speaker" card and stay off the speaker line.
      if (rendersSomething[idx] && !INVITATION_PHASE_TITLES.has(l.title)) {
        isSpeakerBox[idx] = true;
      }
    } else if (l.kind === "satisfied_update" || l.kind === "round_end") {
      rendersSomething[idx] = true;
      isPassThrough[idx] = true;
    } else if (l.kind === "message") {
      if (relocatedVotes.has(idx)) return;
      if (l.name === "System" && l.routePlan) return;
      rendersSomething[idx] = true;
      isSpeakerBox[idx] = true;
    }
  });
  const nextRenderedIsSpeaker = (i: number): boolean => {
    for (let j = i + 1; j < logs.length; j += 1) {
      if (!rendersSomething[j] || isPassThrough[j]) continue;
      return isSpeakerBox[j];
    }
    return false;
  };
  // A pass-through divider carries the connector segment only when it sits on
  // the line between two speakers — a speaker before it and a speaker after it
  // (ignoring other pass-through dividers) — so no segment dangles past the
  // last speaker or leads in from a phase banner.
  const passThroughConnects = (i: number): boolean => {
    if (!isPassThrough[i]) return false;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (!rendersSomething[j] || isPassThrough[j]) continue;
      if (!isSpeakerBox[j]) return false;
      return nextRenderedIsSpeaker(i);
    }
    return false;
  };

  const parseStepsLog = (stepsLog: string): { steps: InternalStep[]; summary?: string } => {
    const normalizedInternalLog = normalizeStepsLogForDisplay(stepsLog);
    const lines = normalizedInternalLog.split("\n");
    const steps: InternalStep[] = [];
    let currentStep: InternalStep | null = null;
    let currentStepKey: string | null = null;
    let thoughtLines: string[] = [];
    let observationLines: string[] = [];
    let inObservation = false;

    const buildStepKey = (stepNumber: number, action?: string) =>
      `${stepNumber}-${action ?? ""}`;

    const commitStep = () => {
      if (!currentStep) return;
      currentStep.thought = thoughtLines.join("\n").trim();
      if (observationLines.length > 0) {
        currentStep.observation = observationLines.join("\n").trim();
      }
      steps.push(currentStep);
    };

    for (const line of lines) {
      const stepMatch = line.match(/^\[Step (\d+)\/(\d+)(?:\s*-\s*(.+))?\]$/);
      if (stepMatch) {
        const stepNumber = parseInt(stepMatch[1]);
        const maxSteps = parseInt(stepMatch[2]);
        const actionLabel = stepMatch[3]?.trim();
        const key = buildStepKey(stepNumber, actionLabel);

        if (currentStep && key === currentStepKey) {
          thoughtLines = [];
          observationLines = [];
          inObservation = false;
          currentStep.stepNumber = stepNumber;
          currentStep.maxSteps = maxSteps;
          currentStep.action = actionLabel;
          continue;
        }

        if (currentStep) {
          commitStep();
        }

        currentStep = {
          stepNumber,
          maxSteps,
          action: actionLabel,
          thought: "",
        };
        currentStepKey = key;
        thoughtLines = [];
        observationLines = [];
        inObservation = false;
        continue;
      }

      const searchMatch = line.match(/^Search:\s*(.+)$/);
      if (searchMatch && currentStep) {
        currentStep.searchQuery = searchMatch[1].trim();
        inObservation = true;
        continue;
      }

      const askMatch = line.match(/^Ask:\s*(.+)$/);
      if (askMatch && currentStep) {
        currentStep.askTarget = askMatch[1].trim();
        continue;
      }

      const askQMatch = line.match(/^AskQ:\s*(.+)$/);
      if (askQMatch && currentStep) {
        currentStep.askQuestion = askQMatch[1].trim();
        continue;
      }

      const askAMatch = line.match(/^AskA:\s*(.+)$/);
      if (askAMatch && currentStep) {
        currentStep.askResponse = askAMatch[1].trim();
        continue;
      }

      if (inObservation) {
        observationLines.push(line);
      } else {
        thoughtLines.push(line);
      }
    }

    if (currentStep) {
      commitStep();
    }

    return { steps };
  };

  const extractScoreFromText = (text?: string): number | undefined => {
    if (!text) return undefined;
    const slashMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*10\b/);
    if (slashMatch) {
      const value = Number(slashMatch[1]);
      return Number.isFinite(value) ? value : undefined;
    }
    const bracketMatch = text.match(/\[\s*score\s*:\s*(\d+(?:\.\d+)?)\s*\]/i);
    if (bracketMatch) {
      const value = Number(bracketMatch[1]);
      return Number.isFinite(value) ? value : undefined;
    }
    return undefined;
  };

  const renderPhaseEntry = (entry: { kind: "phase"; title: string; description?: string | null }, i: number) => {
    // Hidden in the GUI (kept in history for the model's context).
    if (entry.title.trim().toLowerCase() === "tour meeting started") {
      return null;
    }
    // Proposal-voting banners ("1st Proposal Voting", "Proposal Accepted",
    // "Proposal Rejected") are dropped: votes now thread under the proposal box,
    // so these separators/results would just be noise.
    const bannerTitle = entry.title.trim().toLowerCase();
    if (
      bannerTitle.includes("proposal voting") ||
      bannerTitle.includes("proposal accepted") ||
      bannerTitle.includes("proposal rejected") ||
      // Rendered as a System reply threaded under the skipped proposal.
      bannerTitle.includes("proposal skipped")
    ) {
      return null;
    }
    // The "Consensus Reached" banner is replaced by a top-level System box —
    // threaded onto the speaker line from the previous speaker — announcing
    // the agreement and re-showing the final route below a divider (the same
    // one-bubble layout as the vote tally card).
    if (bannerTitle === "consensus reached") {
      let finalRoutePlan: RoutePlan | null = null;
      for (let idx = i - 1; idx >= 0; idx -= 1) {
        const candidate = logs[idx];
        if (candidate.kind === "message" && candidate.routePlan) {
          finalRoutePlan = candidate.routePlan;
          break;
        }
      }
      return (
        <div key={`phase-consensus-${i}`} className="relative rounded-lg p-4 bg-surface">
          <div className="relative z-10 -mx-4 -mt-4 pl-0 pr-4 pt-4 pb-3 rounded-t-lg bg-surface flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
              <SystemBotAvatar size={30} />
            </div>
            <div className="font-semibold text-on-surface">System</div>
          </div>
          <div className="pl-[36px]">
            <div className="rounded-md bg-surface-secondary px-3 py-2.5 text-on-surface-secondary leading-relaxed">
              <div className="flex items-center gap-2">
                <CheckCircle2
                  className="w-5 h-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-label="Consensus reached"
                />
                <span className="font-medium text-on-surface">Consensus Reached!</span>
              </div>
              {finalRoutePlan && (
                <div className="mt-2 pt-1 border-t border-outline">
                  <RoutePlanView
                    plan={finalRoutePlan}
                    scrollKey={`consensus-route-${i}`}
                    routeScrollPositionsRef={routeScrollPositionsRef}
                    className="!mt-2 !px-0"
                    headerSlot={
                      <span
                        className="inline-block px-1.5 py-0.5 rounded text-xs font-medium text-white"
                        style={{
                          background:
                            "linear-gradient(90deg,#f87171,#fbbf24,#34d399,#60a5fa,#a78bfa)",
                        }}
                      >
                        Final route
                      </span>
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
    // Deadlock interventions render as a top-level System box: the System
    // character "speaks" the mediation message to the whole meeting.
    if (bannerTitle === "deadlock intervention") {
      return (
        <div key={`phase-deadlock-${i}`} className="relative rounded-lg p-4 bg-surface">
          {nextRenderedIsSpeaker(i) && (
            <div
              aria-hidden
              className="absolute left-5 top-0 -bottom-4 border-l-2 border-outline"
            />
          )}
          <div className="relative z-10 -mx-4 -mt-4 pl-0 pr-4 pt-4 pb-3 rounded-t-lg bg-surface flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
              <SystemBotAvatar size={30} />
            </div>
            <div className="font-semibold text-on-surface">System</div>
          </div>
          <div className="pl-[36px]">
            <div className="rounded-md border border-amber-300/60 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3 py-2.5 text-on-surface-secondary leading-relaxed">
              <div className="flex items-center gap-2">
                <AlertTriangle
                  className="w-5 h-5 flex-shrink-0 text-amber-600 dark:text-amber-400"
                  aria-label="Deadlock intervention"
                />
                <span className="font-medium text-on-surface">Deadlock Intervention</span>
              </div>
              {entry.description ? (
                <div className="mt-2 text-sm whitespace-pre-wrap">{entry.description}</div>
              ) : null}
            </div>
          </div>
        </div>
      );
    }
    if (INVITATION_PHASE_TITLES.has(entry.title)) {
      const rawDescription = entry.description ?? "";
      const descriptionLines = rawDescription
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const highlightLine = descriptionLines[0] ?? entry.title;
      const reasonLine = descriptionLines
        .slice(1)
        .find((line) => line.length > 0);
      const reasonText = reasonLine
        ? reasonLine.replace(/^Reason:\s*/i, "")
        : rawDescription || "A participant selected the next speaker.";
      return (
        <div
          key={`phase-invite-${i}-${entry.title}`}
          className="rounded-lg border p-4 bg-surface border-outline"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center font-bold text-base bg-zinc-700 dark:bg-zinc-300 text-white dark:text-zinc-900">
              NS
            </div>
            <div className="font-semibold text-on-surface">{entry.title}</div>
            <span className="ml-auto text-xs text-on-surface-tertiary">System</span>
          </div>
          <div className="text-on-surface-secondary whitespace-pre-wrap leading-relaxed pl-[52px]">
            {reasonText || highlightLine}
          </div>
          <div className="mt-3 pl-[52px] text-sm font-semibold text-on-surface-secondary">
            {highlightLine}
          </div>
        </div>
      );
    }

    const normalizedPhaseTitle = entry.title.toLowerCase();
    const isInitialRouteSelectedPhase = normalizedPhaseTitle === "initial route selected";
    const isRouteRefinementPhase = normalizedPhaseTitle === "route refinement phase";
    const isRouteRefinementCompletedPhase = normalizedPhaseTitle === "route refinement completed";
    const isSingleProposerPhase = normalizedPhaseTitle === "single proposer draft started";
    const isDraftingPhaseStarted = normalizedPhaseTitle === "drafting phase started";
    let selectedRoutePlan: RoutePlan | null = null;
    if (isInitialRouteSelectedPhase) {
      const descriptionText = entry.description ?? "";
      const match = descriptionText.match(/proposed by\s+(.+?)\./i);
      const participantName = match ? match[1].trim() : null;
      for (let idx = i - 1; idx >= 0; idx -= 1) {
        const candidate = logs[idx];
        if (candidate.kind === "message" && candidate.routePlan) {
          if (!participantName || candidate.name === participantName) {
            selectedRoutePlan = candidate.routePlan;
            break;
          }
        }
      }
      if (!selectedRoutePlan) {
        for (let idx = logs.length - 1; idx >= 0; idx -= 1) {
          const candidate = logs[idx];
          if (candidate.kind === "message" && candidate.routePlan) {
            selectedRoutePlan = candidate.routePlan;
            break;
          }
        }
      }
    }

    if (isRouteRefinementCompletedPhase) {
      for (let idx = i - 1; idx >= 0; idx -= 1) {
        const candidate = logs[idx];
        if (candidate.kind === "message" && candidate.routePlan && candidate.name === "System") {
          selectedRoutePlan = candidate.routePlan;
          break;
        }
      }
    }

    let sanitizedDescription = entry.description ?? "";
    let phaseSettings: { workflow?: string; turn_rule?: string; consensus?: string; proposer?: string } = {};

    if (sanitizedDescription) {
      const workflowMatch = sanitizedDescription.match(/workflow=([a-z_]+)/);
      const turnRuleMatch = sanitizedDescription.match(/turn_rule=([a-z_]+)/);
      const consensusMatch = sanitizedDescription.match(/consensus=([a-z_]+)/);

      if (workflowMatch || turnRuleMatch || consensusMatch) {
        if (workflowMatch) phaseSettings.workflow = workflowMatch[1];
        if (turnRuleMatch) phaseSettings.turn_rule = turnRuleMatch[1];
        if (consensusMatch) phaseSettings.consensus = consensusMatch[1];
      }
    }

    if (isSingleProposerPhase && sanitizedDescription) {
      const proposerMatch = sanitizedDescription.match(/^(.+?)\s+is drafting/);
      if (proposerMatch) {
        phaseSettings.workflow = "single_proposer";
        phaseSettings.proposer = proposerMatch[1];
      }
    }

    if (sanitizedDescription && (isInitialRouteSelectedPhase || isRouteRefinementPhase || isRouteRefinementCompletedPhase)) {
      const lines = sanitizedDescription.split("\n");
      const filtered = lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (isInitialRouteSelectedPhase && /^route\s*:/i.test(trimmed)) return false;
        if (isRouteRefinementPhase && /^current\s+route\s*:/i.test(trimmed)) return false;
        if (isRouteRefinementCompletedPhase && /^final\s+route\s*:/i.test(trimmed)) return false;
        return true;
      });
      sanitizedDescription = filtered.join("\n").trim();
    }

    const hasSettings = Object.keys(phaseSettings).length > 0;
    let displayTitle = entry.title;
    if (isSingleProposerPhase || isDraftingPhaseStarted) {
      displayTitle = "Route Drafting";
    }

    // Every remaining phase renders as a top-level System speaker box on the
    // conversation line (the same layout as the consensus/vote-tally cards):
    // System speaks the phase title, with the description, settings chips and
    // any route re-shown inside the one bubble below a divider.
    const settingsRow = hasSettings ? (
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {phaseSettings.workflow && (
          <div className="inline-flex items-center gap-1.5">
            <span className="font-semibold text-on-surface-secondary">Workflow</span>
            <span className="text-on-surface-tertiary">{phaseSettings.workflow.replace(/_/g, ' ')}</span>
          </div>
        )}
        {phaseSettings.turn_rule && (
          <div className="inline-flex items-center gap-1.5">
            <span className="font-semibold text-on-surface-secondary">Turn rule</span>
            <span className="text-on-surface-tertiary">{phaseSettings.turn_rule.replace(/_/g, ' ')}</span>
          </div>
        )}
        {phaseSettings.consensus && (
          <div className="inline-flex items-center gap-1.5">
            <span className="font-semibold text-on-surface-secondary">Consensus</span>
            <span className="text-on-surface-tertiary">{phaseSettings.consensus.replace(/_/g, ' ')}</span>
          </div>
        )}
        {phaseSettings.proposer && (
          <div className="inline-flex items-center gap-1.5">
            <span className="font-semibold text-on-surface-secondary">Proposer</span>
            <span className="text-on-surface-tertiary">{phaseSettings.proposer}</span>
          </div>
        )}
      </div>
    ) : null;

    return (
      <div key={`phase-${i}-${entry.title}`} className="relative rounded-lg p-4 bg-surface">
        {nextRenderedIsSpeaker(i) && (
          <div
            aria-hidden
            className="absolute left-5 top-0 -bottom-4 border-l-2 border-outline"
          />
        )}
        <div className="relative z-10 -mx-4 -mt-4 pl-0 pr-4 pt-4 pb-3 rounded-t-lg bg-surface flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
            <SystemBotAvatar size={30} />
          </div>
          <div className="font-semibold text-on-surface">System</div>
        </div>
        <div className="pl-[36px]">
          <div className="rounded-md bg-surface-secondary px-3 py-2.5 text-on-surface-secondary leading-relaxed">
            <div className="font-medium text-on-surface">{displayTitle}</div>
            {settingsRow}
            {!hasSettings && sanitizedDescription ? (
              <div className="mt-1 text-sm whitespace-pre-wrap">{sanitizedDescription}</div>
            ) : null}
            {selectedRoutePlan ? (
              <div className="mt-2 pt-1 border-t border-outline">
                <RoutePlanView
                  plan={selectedRoutePlan}
                  scrollKey={`phase-route-${entry.title}-${i}`}
                  routeScrollPositionsRef={routeScrollPositionsRef}
                  className="!mt-2 !px-0"
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderMessageEntry = (entry: LogEntry & { kind: "message" }, i: number) => {
    // Skip System messages that only contain route plan (for visualization)
    if (entry.name === "System" && entry.routePlan) {
      return null;
    }

    const displayContent = extractSpokenText(getDisplayContent(entry));
    const internalKey = buildInternalKey(entry.turn, entry.name);

    const hasStepsLog =
      typeof entry.stepsLog === "string" &&
      entry.stepsLog.trim().length > 0;

    let internalSteps: InternalStep[] = [];

    if (hasStepsLog && entry.stepsLog) {
      const parsed = parseStepsLog(entry.stepsLog);
      internalSteps = parsed.steps;
    }

    // Action badge from stepsLabel (accept/reject for votes, satisfied for consensus, pass for volunteer mode)
    const actionBadge = entry.stepsLabel === "accept" || entry.stepsLabel === "reject" || entry.stepsLabel === "satisfied" || entry.stepsLabel === "pass"
      ? entry.stepsLabel
      : undefined;
    const isVoteTurn =
      entry.stepsLabel === "accept" ||
      entry.stepsLabel === "reject" ||
      entry.stepsLabel === "scoring";
    const isConcludeFinalAction = actionBadge === "satisfied" || actionBadge === "pass";
    const scoreValue =
      (typeof entry.score === "number" && Number.isFinite(entry.score) ? entry.score : undefined) ??
      (entry.stepsLabel === "scoring"
        ? extractScoreFromText(displayContent) ??
          extractScoreFromText(entry.content) ??
          extractScoreFromText(entry.stepsLog)
        : undefined);
    const lastStep = internalSteps.length > 0 ? internalSteps[internalSteps.length - 1] : null;
    // A "conclude" step is streamed as soon as the agent decides to propose,
    // before the route JSON is generated. Once the final message arrives, the
    // main box (with its own conclude badge) replaces that step, so it is
    // dropped from rendering to avoid showing the message twice.
    const hasConcludeStep = lastStep?.action === "conclude";
    const concludeStepNum = hasConcludeStep
      ? lastStep!.stepNumber
      : lastStep
      ? lastStep.stepNumber + 1
      : 1;
    const concludeMaxSteps = entry.maxSteps ?? lastStep?.maxSteps;
    const showConcludeBadge =
      !isVoteTurn &&
      (Boolean(displayContent) || isConcludeFinalAction) &&
      (concludeMaxSteps != null || internalSteps.length > 0);
    const shouldRenderMainBox = Boolean(displayContent) || Boolean(actionBadge) || entry.needModification !== undefined || isVoteTurn || showConcludeBadge;

    // The agent is still generating: its final message hasn't arrived and this
    // is the newest speaker message (ask_exchange entries may follow it in the
    // log, so "newest message" — not "last log entry" — is the right gate).
    // The human counts too: while it's their turn and they're preparing an
    // action, their box shows the same typing dots as an LLM in progress.
    const isGenerating =
      !errorMessage &&
      entry.name !== "System" &&
      !shouldRenderMainBox &&
      !entry.invitationHighlight &&
      !entry.routePlan &&
      i === lastMessageIndex;
    // Nothing at all yet → dots at the top of the bubble.
    const isAwaitingReply = isGenerating && internalSteps.length === 0;
    // Steps exist and the next action (or the final message) is being
    // generated → dots below the last step. Suppressed while the last step is
    // an ask still waiting for its answer — the ask box shows its own dots.
    const lastStepAwaitingAsk = Boolean(
      lastStep &&
        lastStep.action === "ask" &&
        lastStep.askTarget &&
        !(
          askExchanges.get(askKey(entry.turn, entry.name, lastStep.askTarget))?.response ||
          lastStep.askResponse ||
          ""
        ).trim()
    );
    const isAwaitingNextStep =
      isGenerating && internalSteps.length > 0 && !lastStepAwaitingAsk;

    // Where to surface the retry warning marker (yellow triangle): on the
    // route's top-left corner when this turn produced a route, otherwise to the
    // right of the conclude/judge badge. While the turn is still regenerating
    // (typing dots showing) it rides to the right of the dots; a standalone
    // marker is the last resort when there's nothing to hang it on.
    const hasBadgeLine = isVoteTurn || showConcludeBadge;
    const retryPlacement = !entry.retryInfo
      ? "none"
      : entry.routePlan
      ? "route"
      : hasBadgeLine
      ? "badge"
      : isAwaitingReply || isAwaitingNextStep
      ? "dots"
      : "standalone";

    // Shared box style for all sub-sections (internal steps, main content, invitation)
    // Fill matches the sidebar (surface-secondary shares its value in both themes).
    const boxClass = "rounded-md bg-surface-secondary px-3 py-2.5 text-on-surface-secondary leading-relaxed";
    // Opaque background matching the message box, used behind the sticky header
    // so scrolled content doesn't show through while it's pinned. The human's
    // turns use the same surface fill as everyone else (no distinct tint).
    const headerBgClass = "bg-surface";

    const isStuck = i === stuckIndex;
    // Gradient (matching the header bg) used below the pinned row so scrolled
    // content dissolves as it slides under it. Uses --surface so it adapts to
    // the theme without a dark: variant.
    const underFadeFrom = "from-surface";

    // A threaded "reply" card (avatar + name + "replied to X" + body), shared by
    // ask answers and by votes rendered under a proposal. `connector` is the
    // rule tying it to what it replies to; it defaults to the short rounded L (a
    // single reply), but a vote in a multi-vote thread passes a straight tee so
    // the voters' avatars string together on one continuous line. The body is
    // rendered as given (callers supply their own bubble[s]), so a vote can
    // stack step boxes + a judge box while an ask answer stays one bubble.
    const renderReplyCard = (
      key: React.Key,
      speaker: string,
      replyingTo: string,
      body: React.ReactNode,
      connector?: React.ReactNode,
      // The "replied to X" chip only appears once the reply has at least one
      // finished utterance — while it's all still typing dots, the header
      // stays just avatar + name.
      showRepliedTo: boolean = true,
      // Replaces the default "replied to X" chip (e.g. a vote's
      // "voted on X's route").
      chipOverride?: React.ReactNode
    ) => (
      <div className="relative pl-8" key={key}>
        {connector ?? (
          <div
            aria-hidden
            className="absolute left-3 -top-2 h-7 w-5 border-l-2 border-b-2 border-outline rounded-bl-md"
          />
        )}
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
            {speaker === "System" ? (
              <SystemBotAvatar size={24} />
            ) : (
              <CharacterAvatar avatar={avatars[speaker]} name={speaker} size={22} />
            )}
          </div>
          <span className="text-sm font-semibold text-on-surface">{speakerLabel(speaker)}</span>
          {showRepliedTo &&
            (chipOverride ?? (
              <span className="inline-flex items-center gap-1 text-xs text-on-surface-tertiary">
                <Reply className="w-3 h-3" />
                replied to {speakerLabel(replyingTo)}
              </span>
            ))}
        </div>
        <div className="mt-1.5 pl-10 space-y-2">{body}</div>
      </div>
    );

    // The internal steps (ask/search/…) of a turn, each tagged with its action,
    // so the reasoning shows the same way for a normal message and for a vote.
    // An "ask" step threads the target's answer beneath it as its own reply.
    const renderStepBoxes = (
      steps: InternalStep[],
      turn: number,
      name: string,
      internalKey: string
    ) =>
      steps.map((step, stepIdx) => {
        const obsKey = `${internalKey}-step${step.stepNumber}`;
        const isObsExpanded = expandedObservations[obsKey] ?? false;
        const isAskStep = step.action === "ask" && step.askTarget;
        const askReply = isAskStep
          ? (() => {
              const exchange = askExchanges.get(askKey(turn, name, step.askTarget ?? ""));
              const targetName = (exchange?.target ?? step.askTarget ?? "").replace(/_/g, " ");
              const answer = (exchange?.response || step.askResponse || "").trim();
              const pending = !answer && (!exchange || exchange.pending);
              // While the answer is still typing, the dots stand alone (no
              // bubble frame) and the "replied to" chip waits for the answer.
              const answerBody = answer ? (
                <div className={boxClass}>
                  <div className="whitespace-pre-wrap">{answer}</div>
                </div>
              ) : pending ? (
                <TypingDots />
              ) : null;
              return renderReplyCard(
                `ask-${internalKey}-${stepIdx}`,
                targetName,
                name,
                answerBody,
                undefined,
                Boolean(answer)
              );
            })()
          : null;
        return (
          <React.Fragment key={`${internalKey}-step-${stepIdx}`}>
            <div
              className={`${boxClass}${popClass(
                `${turn}::${name}::step-${step.stepNumber}-${step.action ?? ""}`
              )}`}
            >
              {/* Action badge + step number (all step types) */}
              <div className="flex items-center gap-1.5 mb-1">
                <span className="inline-block px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-xs font-medium text-on-surface-tertiary">
                  {step.action}
                </span>
                <span className="text-xs text-on-surface-tertiary">
                  {step.stepNumber}/{step.maxSteps}
                </span>
              </div>
              {/* Thought text */}
              {step.thought && (
                <div className="whitespace-pre-wrap mt-1">{step.thought}</div>
              )}
              {/* Search query + observation */}
              {step.searchQuery && (
                <div className="mt-1 text-on-surface-tertiary">
                  <span>Search: </span>
                  <span className={!step.observation ? "query-loading" : ""}>
                    {step.searchQuery}
                  </span>
                  {step.observation && (
                    <div className="mt-1">
                      <button
                        onClick={() => toggleObservation(obsKey)}
                        className="text-on-surface-tertiary hover:text-on-surface-secondary flex items-center gap-0.5 transition-colors"
                      >
                        <span>Result</span>
                        {isObsExpanded ? (
                          <ChevronUp className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                      {isObsExpanded && (
                        <div
                          className="mt-1 pl-3 border-l-2 border-outline text-on-surface-tertiary whitespace-pre-wrap break-words max-w-full"
                          style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}
                        >
                          {step.observation}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {askReply}
          </React.Fragment>
        );
      });

    // One vote, threaded under the proposal box as a reply. It shows the voter's
    // reasoning tags (ask/search steps, each with its answer) and a final
    // "judge" box carrying the comment plus the Accept/Reject or score badge —
    // the same tags a normal turn shows. The connector depends on the vote turn
    // rule: parallel votes each branch off the proposal with their own rounded
    // L (one shared trunk, every voter's corner rounded); sequential votes
    // elbow only the first voter off the proposal and then run a straight rule
    // down from voter to voter (the top-level speaker-thread style).
    const renderVoteReply = (vIdx: number, order: number, count: number) => {
      const isLast = order === count - 1;
      const v = logs[vIdx] as LogEntry & { kind: "message" };
      // Steps live in stepsLog; some votes instead embed the raw log in content
      // ("[Steps]\n[Step 1/5 - ask]\nAsk:/AskQ:/AskA: …[Message]…").
      const stepsSource =
        typeof v.stepsLog === "string" && v.stepsLog.trim()
          ? v.stepsLog
          : typeof v.content === "string" && v.content.includes("[Step")
          ? v.content
          : "";
      const steps = stepsSource ? parseStepsLog(stepsSource).steps : [];
      const voteKey = buildInternalKey(v.turn, v.name);
      const comment = extractSpokenText(getDisplayContent(v));
      const verdict =
        v.stepsLabel === "accept" ? "accept" : v.stepsLabel === "reject" ? "reject" : undefined;
      const voteScore =
        typeof v.score === "number" && Number.isFinite(v.score)
          ? v.score
          : v.stepsLabel === "scoring"
          ? extractScoreFromText(comment) ?? extractScoreFromText(v.content)
          : undefined;
      const hasScore = typeof voteScore === "number" && Number.isFinite(voteScore);
      const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
      const judgeStepNum = lastStep ? lastStep.stepNumber + 1 : 1;
      const judgeMaxSteps = v.maxSteps ?? lastStep?.maxSteps;
      // The last step is an ask whose answer hasn't landed yet — the answerer's
      // own dots already show inside that ask's reply card, so the voter's
      // judge-pending dots stay hidden until the answer arrives (otherwise two
      // sets of dots appear at once).
      const lastStepAwaitingAsk = Boolean(
        lastStep &&
          lastStep.action === "ask" &&
          lastStep.askTarget &&
          !(
            askExchanges.get(askKey(v.turn, v.name, lastStep.askTarget))?.response ||
            lastStep.askResponse ||
            ""
          ).trim()
      );

      // Until the judge verdict/comment lands, the reply shows bare typing
      // dots (no judge bubble, no tag) — the framed judge box only appears
      // with real content.
      const judgePending = !comment && !verdict && !hasScore;
      const body = (
        <>
          {renderStepBoxes(steps, v.turn, v.name, voteKey)}
          {judgePending ? (
            lastStepAwaitingAsk ? null : <TypingDots />
          ) : (
          <div className={`${boxClass}${popClass(`${v.turn}::${v.name}::vote`)}`}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="inline-block px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-xs font-medium text-on-surface-tertiary">
                judge
              </span>
              <span className="text-xs text-on-surface-tertiary">
                {judgeMaxSteps ? `${judgeStepNum}/${judgeMaxSteps}` : judgeStepNum}
              </span>
            </div>
            {comment ? (
              <div className="whitespace-pre-wrap">{comment}</div>
            ) : null}
            {verdict && (
              <div className={comment ? "mt-1.5" : ""}>
                <span
                  className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    verdict === "accept"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  }`}
                >
                  {verdict === "accept" ? "Accept" : "Reject"}
                </span>
              </div>
            )}
            {hasScore && (
              <div className={comment || verdict ? "mt-1.5" : ""}>
                <span
                  className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    voteScore! >= 5
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  }`}
                >
                  {Number.isInteger(voteScore!) ? voteScore : voteScore!.toFixed(1)}/10
                </span>
              </div>
            )}
          </div>
          )}
        </>
      );

      // The rounded L branching a voter's avatar off the trunk at left-3.
      // h-7 (not h-6) drops the horizontal arm slightly below the avatar
      // frame's midline, onto the character's visual centre.
      const roundedElbow = (
        <div
          aria-hidden
          className="absolute left-3 -top-2 h-7 w-5 border-l-2 border-b-2 border-outline rounded-bl-md"
        />
      );
      // Straight rule from this voter's avatar down to the next voter's
      // (left-12 sits at the reply avatar's centre; -bottom-2 bridges the
      // space-y-2 gap), mirroring the top-level speaker thread.
      const downToNextVoter = (
        <div aria-hidden className="absolute left-12 top-8 -bottom-2 border-l-2 border-outline" />
      );

      let connector: React.ReactNode;
      if (parallelVoting) {
        // Parallel: one shared trunk, and EVERY voter branches off it with the
        // rounded L (the trunk keeps running past the middle voters).
        connector = isLast ? (
          roundedElbow
        ) : (
          <>
            <div aria-hidden className="absolute left-3 -top-2 -bottom-2 border-l-2 border-outline" />
            {roundedElbow}
          </>
        );
      } else if (order === 0) {
        // Sequential: only the first voter elbows off the proposal; from there
        // the voters chain straight down avatar-to-avatar.
        connector = (
          <>
            {roundedElbow}
            {!isLast && downToNextVoter}
          </>
        );
      } else {
        // Later sequential voters hang on the chain from above; an empty
        // fragment suppresses the reply card's default elbow.
        connector = <>{!isLast && downToNextVoter}</>;
      }

      return renderReplyCard(
        `vote-${vIdx}`,
        v.name,
        entry.name,
        body,
        connector,
        // The vote chip waits for the judge box itself — while the voter is
        // still reasoning (steps streaming, judge pending) the header stays
        // just avatar + name.
        !judgePending,
        // Votes read "voted on X's route" instead of "replied to X".
        <span className="inline-flex items-center gap-1 text-xs text-on-surface-tertiary">
          <Vote className="w-3 h-3" />
          voted on {speakerLabel(entry.name)}'s route
        </span>
      );
    };

    // The bot's tally card, appended after the last voter once the outcome is
    // known: who accepted/rejected (or their scores), the verdict badge, and a
    // one-line rule-based reason matching how the backend decides (majority
    // and unanimous count the proposer as an implicit accept; the score rules
    // compare the total/minimum against the current route's score).
    const renderVoteResultCard = (
      result: { accepted: boolean; voteSummary?: Record<string, any> },
      voteIdxs: number[]
    ) => {
      const votes = voteIdxs.map((idx) => logs[idx] as LogEntry & { kind: "message" });
      const acceptNames = votes
        .filter((v) => v.stepsLabel === "accept")
        .map((v) => speakerLabel(v.name));
      const rejectNames = votes
        .filter((v) => v.stepsLabel === "reject")
        .map((v) => speakerLabel(v.name));
      const scoreOf = (v: LogEntry & { kind: "message" }): number | undefined =>
        typeof v.score === "number" && Number.isFinite(v.score)
          ? v.score
          : extractScoreFromText(extractSpokenText(getDisplayContent(v))) ??
            extractScoreFromText(v.content) ??
            undefined;
      const scoreVotes = votes
        .filter((v) => v.stepsLabel === "scoring")
        .map((v) => ({ name: speakerLabel(v.name), score: scoreOf(v) }));
      const isScoreRule = votingRule === "most_pleasure" || votingRule === "least_misery";
      const countsProposer = votingRule === "majority" || votingRule === "unanimous";
      const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

      // Voter list lines: accept/reject names (proposer appended when the rule
      // counts them), or each voter's score under the score rules.
      const acceptLine = countsProposer
        ? [...acceptNames, `${speakerLabel(entry.name)} (proposer)`]
        : acceptNames;

      // Same connector slot as a last voter: parallel branches the bot off the
      // shared trunk with the rounded L; sequential lets the straight rule from
      // the last voter arrive at the bot's avatar (no connector of its own).
      const botConnector = parallelVoting ? (
        <div
          aria-hidden
          className="absolute left-3 -top-2 h-7 w-5 border-l-2 border-b-2 border-outline rounded-bl-md"
        />
      ) : null;

      return (
        <div className="relative pl-8" key={`vote-result-${entry.turn}-${entry.name}`}>
          {botConnector}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
              <SystemBotAvatar size={24} />
            </div>
            <span className="text-sm font-semibold text-on-surface">System</span>
          </div>
          <div className="mt-1.5 pl-10 space-y-2">
            <div className={`${boxClass}${popClass(`${entry.turn}::${entry.name}::vote-result`)}`}>
              {/* The bot speaks the outcome first, plain and conversational,
                  led by a check/cross icon instead of a verdict tag. */}
              <div className="flex items-center gap-2">
                {result.accepted ? (
                  <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Accepted" />
                ) : (
                  <XCircle className="w-5 h-5 flex-shrink-0 text-red-600 dark:text-red-400" aria-label="Rejected" />
                )}
                <span className="font-medium text-on-surface">
                  {entry.name}'s route was {result.accepted ? "accepted!" : "rejected."}
                </span>
              </div>
              {/* …then lays out the why: the rule in play, and who voted
                  which way (or their scores). */}
              <div className="mt-2 pt-2 border-t border-outline">
                <div className="text-xs text-on-surface-tertiary">
                  Voting rule: {votingRule}
                </div>
                {isScoreRule ? (
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="inline-block px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-xs font-medium text-on-surface-tertiary">
                      Scores
                    </span>
                    <span>
                      {scoreVotes.length > 0
                        ? scoreVotes
                            .map((s) => `${s.name} ${typeof s.score === "number" ? `${fmt(s.score)}/10` : "—"}`)
                            .join(", ")
                        : "—"}
                    </span>
                  </div>
                ) : (
                  // The max-content column sizes both tags to the wider one,
                  // so they share a width without hardcoding it.
                  <div className="mt-2 grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1 items-baseline">
                    <span className="text-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                      Accept ({acceptLine.length})
                    </span>
                    <span>{acceptLine.length > 0 ? acceptLine.join(", ") : "—"}</span>
                    <span className="text-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                      Reject ({rejectNames.length})
                    </span>
                    <span>{rejectNames.length > 0 ? rejectNames.join(", ") : "—"}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    };

    // Whether a speaker box follows this one (skipping entries that render
    // nothing), so the avatar can be threaded down to the next speaker.
    const hasNextSpeaker = nextRenderedIsSpeaker(i);

    return (
      <div
        key={`message-${entry.turn}-${entry.name}-${i}`}
        ref={(el) => {
          if (el) messageBoxRefs.current.set(i, el);
          else messageBoxRefs.current.delete(i);
        }}
        className="relative rounded-lg p-4 bg-surface"
      >
        {/* Connector rule threading this speaker's avatar down to the next
            speaker's, so the conversation runs on one continuous line (the same
            rule as the reply connector). It sits at the avatar's centre and is
            drawn behind the opaque sticky header, so each avatar reads as a node
            the line passes through; only drawn when a speaker box follows, so it
            never dangles toward a divider or the end of the log. */}
        {hasNextSpeaker && (
          <div
            aria-hidden
            className="absolute left-5 top-0 -bottom-4 border-l-2 border-outline"
          />
        )}
        {/* Speaker row. Sticky so that while scrolling through a long turn the
            avatar + name + turn stays pinned at the top of the chat, then gets
            pushed out by the next speaker's row (the usual "stuck header" UI).
            The negative margins let the opaque bar span the full box width and
            reclaim the box's top padding; pt-4 keeps it from touching the edge
            once pinned. pl-0 drops the left padding so the avatar's left edge
            lines up with the page header title and the phase banners (the box's
            own p-4 is invisible fill), rather than sitting inset from them. */}
        <div className={`sticky top-0 z-20 -mx-4 -mt-4 pl-0 pr-4 pt-4 pb-3 rounded-t-lg flex items-center gap-3 ${headerBgClass}`}>
          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
            <CharacterAvatar
              avatar={avatars[entry.name]}
              name={entry.name}
              size={28}
            />
          </div>
          <div className="font-semibold text-on-surface">{speakerLabel(entry.name)}</div>
          <span className="ml-auto text-xs text-on-surface-tertiary">
            Turn {entry.turnLabel ?? entry.turn}
          </span>
          {/* Fade-out just below the pinned row; content scrolls under it. */}
          {isStuck && (
            <div
              aria-hidden
              className={`pointer-events-none absolute inset-x-0 top-full h-3 bg-gradient-to-b ${underFadeFrom} to-transparent`}
            />
          )}
        </div>
        <div className="pl-[36px] space-y-2">
          {/* Retry marker for turns with no conclude badge or route to hang it
              on (e.g. still regenerating right after a retry). */}
          {retryPlacement === "standalone" && (
            <div>
              <RetryBadge retryInfo={entry.retryInfo!} />
            </div>
          )}
          {/* Typing indicator while the reply is still being generated, with
              the retry marker riding to its right when a retry occurred. */}
          {isAwaitingReply && (
            <div className="flex items-center gap-2">
              <TypingDots />
              {retryPlacement === "dots" && <RetryBadge retryInfo={entry.retryInfo!} />}
            </div>
          )}
          {/* Internal steps. The trailing "conclude" step is dropped once the
              main box renders — it shows the same message with its own badge. */}
          {hasStepsLog &&
            internalKey &&
            renderStepBoxes(
              shouldRenderMainBox && hasConcludeStep
                ? internalSteps.slice(0, -1)
                : internalSteps,
              entry.turn,
              entry.name,
              internalKey
            )}
          {/* Typing indicator while the next action / final message is being
              generated after at least one step has been shown. Extra top
              padding keeps it visually apart from the block above; the dots
              animate inside a small box matching the pending message box. */}
          {isAwaitingNextStep && (
            <div className="pt-2 flex items-center gap-2">
              <TypingDots />
              {retryPlacement === "dots" && <RetryBadge retryInfo={entry.retryInfo!} />}
            </div>
          )}
          {/* Main message content */}
          {shouldRenderMainBox ? (
            <div className={`${boxClass}${popClass(`${entry.turn}::${entry.name}::main`)}`}>
              {/* Judge badge for voting turns */}
              {(isVoteTurn || showConcludeBadge) && (
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="inline-block px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-xs font-medium text-on-surface-tertiary">
                    {isVoteTurn ? "judge" : "conclude"}
                  </span>
                  <span className="text-xs text-on-surface-tertiary">
                    {concludeMaxSteps ? `${concludeStepNum}/${concludeMaxSteps}` : concludeStepNum}
                  </span>
                  {retryPlacement === "badge" && (
                    <RetryBadge retryInfo={entry.retryInfo!} />
                  )}
                </div>
              )}
              {displayContent ? (
                <div className="whitespace-pre-wrap">{displayContent}</div>
              ) : null}
              {actionBadge && (
                <div className="mt-1.5">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    actionBadge === "accept"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : actionBadge === "satisfied"
                      ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                      : actionBadge === "pass"
                      ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400"
                      : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  }`}>
                    {actionBadge === "accept" ? "Accept" : actionBadge === "satisfied" ? "Satisfied" : actionBadge === "pass" ? "Pass" : "Reject"}
                  </span>
                </div>
              )}
              {(entry.stepsLabel === "scoring" ||
                (typeof scoreValue === "number" && Number.isFinite(scoreValue))) && (
                <div className="mt-1.5">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    typeof scoreValue === "number" && Number.isFinite(scoreValue)
                      ? scoreValue >= 5
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400"
                  }`}>
                    {typeof scoreValue === "number" && Number.isFinite(scoreValue)
                      ? `${Number.isInteger(scoreValue) ? scoreValue : scoreValue.toFixed(1)}/10`
                      : "N/A"}
                  </span>
                </div>
              )}
              {entry.needModification !== undefined && (
                <div className="mt-1.5">
                  <span className="text-on-surface-tertiary">Needs modification: </span>
                  <span className={entry.needModification ? "font-semibold text-on-surface" : "font-semibold text-on-surface-tertiary"}>
                    {entry.needModification ? "Yes" : "No"}
                  </span>
                </div>
              )}
            </div>
          ) : null}
          {/* Invitation */}
          {entry.invitationHighlight ? (
            <div className={`${boxClass}${popClass(`${entry.turn}::${entry.name}::invite`)}`}>
              {entry.invitationMessage && (
                <div>{entry.invitationMessage}</div>
              )}
              <div className={entry.invitationMessage ? "mt-1.5" : ""}>
                <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                  Next Speaker: {entry.invitationHighlight}
                </span>
              </div>
            </div>
          ) : null}
          {/* Route plan. Tagged "Proposal" in the top-left like the other chat
              boxes' badges, with the retry marker beside it when retried. */}
          {entry.routePlan && (
            <RoutePlanView
              plan={entry.routePlan}
              scrollKey={`route-${entry.turn}-${entry.name}-${i}`}
              routeScrollPositionsRef={routeScrollPositionsRef}
              className={popClass(`${entry.turn}::${entry.name}::route`).trim() || undefined}
              headerSlot={
                <div className="flex items-center gap-1.5">
                  <span className="inline-block px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-xs font-medium text-on-surface-tertiary">
                    Proposal
                  </span>
                  {retryPlacement === "route" && (
                    <RetryBadge retryInfo={entry.retryInfo!} />
                  )}
                </div>
              }
            />
          )}
          {/* A skipped proposal gets a System reply in place of votes,
              explaining why no voting happened. */}
          {skipNoticeByProposal.has(i) &&
            renderReplyCard(
              `skip-${entry.turn}-${entry.name}`,
              "System",
              entry.name,
              <div className={boxClass}>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 text-amber-500" aria-label="Proposal skipped" />
                  <span>{skipNoticeByProposal.get(i)}</span>
                </div>
              </div>
            )}
          {/* Votes cast on this proposal, threaded under it. When several people
              vote, their avatars connect along one continuous line; the last
              vote closes the thread with the rounded L. */}
          {votesByProposal.has(i) &&
            (() => {
              const voteIdxs = votesByProposal.get(i)!;
              const result = voteResultByProposal.get(i);
              // Once the outcome is known the bot's tally card takes the final
              // slot on the thread, so the last voter connects onward to it.
              const slots = voteIdxs.length + (result ? 1 : 0);
              return (
                <>
                  {voteIdxs.map((vIdx, order) => renderVoteReply(vIdx, order, slots))}
                  {result && renderVoteResultCard(result, voteIdxs)}
                </>
              );
            })()}
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Top fade — only while no header is pinned. Once a speaker row sticks,
          this would read as a gradient band above it, so we drop it and fade
          below the pinned row instead (see the sticky header). */}
      {stuckIndex === -1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-3 z-10 bg-gradient-to-b from-surface to-transparent"
        />
      )}
      <div
        ref={chatContainerRef}
        onScroll={onScroll}
        className="chat-scroll flex-1 overflow-y-auto min-h-0 relative z-0"
      >
        {/* The pane spans the full main area so its scrollbar sits at the
            page's right edge and wheeling the side margins scrolls it; the
            messages themselves stay in a centered max-w-5xl column. */}
        <div className="max-w-5xl mx-auto px-6 pb-6 space-y-4">
        {/* An empty chat shows nothing: a placeholder here used to flash
            briefly while the history loads on entering the meeting. */}
        {logs.length === 0 ? null : (
          logs.map((entry, i) => {
            if (entry.kind === "phase") {
              return renderPhaseEntry(entry, i);
            }
            if (entry.kind === "ask_exchange") {
              // Both LLM and human asks render inline inside the asker's "ask"
              // step box (streamed as internal events into their turn/vote
              // bubble), so nothing is drawn at the top level.
              return null;
            }
            if (entry.kind === "proposal_vote_result") {
              // Result banner hidden: the accept/reject verdict already shows on
              // each threaded vote under the proposal.
              return null;
            }
            if (entry.kind === "satisfied_update") {
              return (
                <div key={`satisfied-${i}`} className="relative mx-4 my-1 text-center">
                  {/* Keeps the speaker connector running through this pill when
                      speakers sit on both sides. left-1 + the mx-4 margin lands
                      on the same x as the speaker boxes' left-5 trunk. */}
                  {passThroughConnects(i) && (
                    <div aria-hidden className="absolute left-1 top-0 -bottom-4 border-l-2 border-outline" />
                  )}
                  <span className="inline-block text-xs text-on-surface-tertiary bg-surface-secondary border border-outline rounded-full px-3 py-1">
                    {entry.speaker} is {entry.satisfied ? "satisfied" : "not satisfied"} ({entry.satisfiedCount}/{entry.totalCount})
                  </span>
                </div>
              );
            }
            if (entry.kind === "round_end") {
              return (
                // The margins align the rule with the chat text boxes: left
                // edge at the speaker boxes' p-4 + pl-[36px] content inset,
                // right edge at their p-4 inset — so the rule stops at the
                // same width as the message bubbles.
                <div key={`round-end-${i}`} className="relative flex items-center gap-3 my-3 ml-[52px] mr-4">
                  {/* Speaker connector passes through the cycle divider to the
                      left of the rule (-left-8 lands on the trunk's x=20px),
                      so the two never cross. */}
                  {passThroughConnects(i) && (
                    <div aria-hidden className="absolute -left-8 top-0 -bottom-4 border-l-2 border-outline" />
                  )}
                  <div className="flex-1 border-t border-outline" />
                  <span className="text-xs text-on-surface-tertiary whitespace-nowrap">
                    Cycle {entry.roundNumber}
                  </span>
                  <div className="flex-1 border-t border-outline" />
                </div>
              );
            }
            // Votes are re-rendered as threaded replies under their proposal.
            if (relocatedVotes.has(i)) {
              return null;
            }
            return renderMessageEntry(entry as LogEntry & { kind: "message" }, i);
          })
        )}
        {errorMessage && (
          <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="min-w-0 break-words">
              <span className="font-semibold">Meeting stopped: </span>
              {errorMessage}
            </div>
          </div>
        )}
        <div ref={logsEndRef} />
        </div>
      </div>

      {showScrollButton && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-surface hover:bg-surface-secondary text-on-surface-secondary rounded-full p-3 shadow-lg border border-outline transition-all duration-200 z-20"
          aria-label="Scroll to bottom"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      )}
    </>
  );
};

export default ChatMessages;
