import React from "react";
import ModernSelect from "../ui/ModernSelect";
import {
  TURN_RULE_OPTIONS,
  VOTE_TURN_RULE_OPTIONS,
  VOTING_RULE_OPTIONS,
} from "../../constants";

export interface DeciderOption {
  value: string;
  label: string;
}

interface WorkflowSectionProps {
  turnRule: string;
  setTurnRule: (rule: string) => void;
  draftVotingRule: string;
  setDraftVotingRule: (rule: string) => void;
  singleDecider: string;
  setSingleDecider: (participantId: string) => void;
  deciderOptions: DeciderOption[];
  volunteerMode: boolean;
  setVolunteerMode: (mode: boolean) => void;
  balancedTurns: boolean;
  setBalancedTurns: (mode: boolean) => void;
  voteTurnRule: string;
  setVoteTurnRule: (rule: string) => void;
  voteSettingsLinked: boolean;
  setVoteSettingsLinked: (linked: boolean) => void;
  settingsLocked: boolean;
}

const WorkflowSection: React.FC<WorkflowSectionProps> = ({
  turnRule,
  setTurnRule,
  draftVotingRule,
  setDraftVotingRule,
  singleDecider,
  setSingleDecider,
  deciderOptions,
  volunteerMode,
  setVolunteerMode,
  balancedTurns,
  setBalancedTurns,
  voteTurnRule,
  setVoteTurnRule,
  voteSettingsLinked,
  setVoteSettingsLinked,
  settingsLocked,
}) => {
  const balancedTurnsLocked = settingsLocked || turnRule === "round_robin";
  const effectiveBalancedTurns = turnRule === "round_robin" ? true : balancedTurns;

  return (
    <div className="mb-6 space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="p-4 bg-surface rounded-lg border border-outline">
          <h3 className="text-sm font-semibold text-on-surface-secondary mb-4">
            Conversation settings
          </h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-on-surface-secondary mb-2">
                Turn rule
              </label>
              <ModernSelect
                value={turnRule}
                onChange={(e) => setTurnRule(e.target.value)}
                disabled={settingsLocked}
              >
                {TURN_RULE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </ModernSelect>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-on-surface-secondary">
                  Volunteer mode
                </label>
                <p className="text-xs text-on-surface-tertiary mt-0.5">
                  Participants can pass their turn
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={volunteerMode}
                disabled={settingsLocked}
                onClick={() => setVolunteerMode(!volunteerMode)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                  volunteerMode ? "bg-accent" : "bg-outline"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    volunteerMode ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <label
                  className={`block text-sm font-medium ${
                    balancedTurnsLocked ? "text-on-surface-tertiary" : "text-on-surface-secondary"
                  }`}
                >
                  Balanced turns
                </label>
                <p className="text-xs text-on-surface-tertiary mt-0.5">
                  {turnRule === "round_robin"
                    ? "Required for Round robin"
                    : turnRule === "random" && !balancedTurns
                      ? "Speakers may repeat before everyone has spoken"
                    : "Turn selection is continuous; no cycle is enforced"}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={effectiveBalancedTurns}
                disabled={balancedTurnsLocked}
                onClick={() => setBalancedTurns(!effectiveBalancedTurns)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                  effectiveBalancedTurns ? "bg-accent" : "bg-outline"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    effectiveBalancedTurns ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>
        </div>

        <div className="p-4 bg-surface rounded-lg border border-outline">
          <h3 className="text-sm font-semibold text-on-surface-secondary mb-4">
            Vote settings
          </h3>

          <div className="space-y-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <label className="block text-sm font-medium text-on-surface-secondary">
                  Turn rule
                </label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={voteSettingsLinked}
                  disabled={settingsLocked}
                  onClick={() => {
                    if (voteSettingsLinked) {
                      setVoteTurnRule(turnRule);
                    }
                    setVoteSettingsLinked(!voteSettingsLinked);
                  }}
                  title={voteSettingsLinked ? "Synced with conversation — click to unsync" : "Unsynced — click to sync back"}
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    voteSettingsLinked
                      ? "bg-accent-soft text-accent-soft-text"
                      : "bg-surface-secondary text-on-surface-secondary hover:bg-surface-tertiary"
                  } ${settingsLocked ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  {voteSettingsLinked ? "Sync w/ conversation" : "Unsync"}
                </button>
              </div>
              <ModernSelect
                value={voteSettingsLinked ? turnRule : voteTurnRule}
                onChange={(e) => setVoteTurnRule(e.target.value)}
                disabled={settingsLocked || voteSettingsLinked}
              >
                {VOTE_TURN_RULE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </ModernSelect>
            </div>

            <div>
              <label className="block text-sm font-medium text-on-surface-secondary mb-2">
                Voting rule
              </label>
              <ModernSelect
                value={draftVotingRule}
                onChange={(e) => setDraftVotingRule(e.target.value)}
                disabled={settingsLocked}
              >
                {VOTING_RULE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </ModernSelect>
            </div>

            {draftVotingRule === "single_decider" && (
              <div>
                <label className="block text-sm font-medium text-on-surface-secondary mb-2">
                  Decider
                </label>
                <ModernSelect
                  value={singleDecider}
                  onChange={(e) => setSingleDecider(e.target.value)}
                  disabled={settingsLocked}
                  aria-label="Decider"
                >
                  {deciderOptions.length === 0 ? (
                    <option value="">No participants yet</option>
                  ) : null}
                  {deciderOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </ModernSelect>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkflowSection;
