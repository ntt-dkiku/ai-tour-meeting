import React from "react";
import SettingsHeader from "../settings/SettingsHeader";
import TitleSection from "../settings/TitleSection";
import ParticipantsSection from "../settings/ParticipantsSection";
import GoalsSection from "../settings/GoalsSection";
import ConstraintsSection from "../settings/ConstraintsSection";
import WorkflowSection from "../settings/WorkflowSection";
import DragOverlay from "../ui/DragOverlay";
import LoadingOverlay from "../ui/LoadingOverlay";
import { useMeetingContext } from "../../context/MeetingContext";
import type { Avatar, ParticipantIn } from "../../types";
import { humanDisplayLabel } from "../../utils/human";
import { X } from "lucide-react";

interface SettingsViewProps {
  // Header actions
  settingsLocked: boolean;
  currentMeetingHasHistory: boolean;
  canStart: boolean;
  onBackToMeeting: () => void;
  onStartMeeting: () => void;
  onViewStatistics: () => void;
  onDownloadSettings: () => void;
  onImportSettings: () => void;
  onResetMeeting: () => void;

  // Drag and drop
  isDragOverSettings: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;

  // Loading state
  isGeneratingSample: boolean;
  randomSampleError: string | null;
  onOpenApiSettings: () => void;
  onDismissRandomSampleError: () => void;

  // File input
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // Title
  meetingTitle: string;
  setMeetingTitle: (title: string) => void;
  isEditingTitle: boolean;
  setIsEditingTitle: (editing: boolean) => void;
  updateMeetingTitle: () => void;

  // Participants
  participants: ParticipantIn[];
  order: string[];
  setOrder: (order: string[]) => void;
  includeHuman: boolean;
  updateIncludeHuman: (include: boolean) => void;
  humanName: string;
  humanAvatar: Avatar | null;
  humanRole: string;
  onEditHuman: () => void;
  onHumanMenuOpen?: (rect: DOMRect) => void;
  tooManyFacilitators?: boolean;
  currentMeetingId: string;
  connected: boolean;
  apiBase: string;
  isDragOverParticipants: boolean;
  onAddParticipant: () => void;
  onDownloadParticipants: () => void;
  onRemoveAllParticipants: () => void;
  onParticipantsDragOver: (e: React.DragEvent) => void;
  onParticipantsDragLeave: (e: React.DragEvent) => void;
  onParticipantsDrop: (e: React.DragEvent) => void;
  showParticipantMenu: (participantName: string, rect: DOMRect) => void;
  onViewParticipant?: (participantId: string) => void;
}

const SettingsView: React.FC<SettingsViewProps> = ({
  // Header
  settingsLocked,
  currentMeetingHasHistory,
  canStart,
  onBackToMeeting,
  onStartMeeting,
  onViewStatistics,
  onDownloadSettings,
  onImportSettings,
  onResetMeeting,

  // Drag and drop
  isDragOverSettings,
  onDragOver,
  onDragLeave,
  onDrop,

  // Loading
  isGeneratingSample,
  randomSampleError,
  onOpenApiSettings,
  onDismissRandomSampleError,

  // File input
  fileInputRef,
  onFileInputChange,

  // Title
  meetingTitle,
  setMeetingTitle,
  isEditingTitle,
  setIsEditingTitle,
  updateMeetingTitle,

  // Participants
  participants,
  order,
  setOrder,
  includeHuman,
  updateIncludeHuman,
  humanName,
  humanAvatar,
  humanRole,
  onEditHuman,
  onHumanMenuOpen,
  tooManyFacilitators,
  currentMeetingId,
  connected,
  apiBase,
  isDragOverParticipants,
  onAddParticipant,
  onDownloadParticipants,
  onRemoveAllParticipants,
  onParticipantsDragOver,
  onParticipantsDragLeave,
  onParticipantsDrop,
  showParticipantMenu,
  onViewParticipant,
}) => {
  // Get settings from context
  const { settings, updateSetting } = useMeetingContext();

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

  // Candidates for the single-decider select, in speaking order.
  const deciderOptions = React.useMemo(() => {
    const byKey = new Map(
      participants
        .filter((p) => !p.incomplete)
        .map((p) => [String(p.id ?? p.name), p.name] as const)
    );
    const options: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const key of order) {
      if (key === "__YOU__") {
        if (includeHuman) {
          options.push({ value: "__YOU__", label: humanDisplayLabel(humanName) });
          seen.add(key);
        }
        continue;
      }
      const name = byKey.get(key);
      if (name) {
        options.push({ value: key, label: name });
        seen.add(key);
      }
    }
    for (const [key, name] of byKey) {
      if (!seen.has(key)) options.push({ value: key, label: name });
    }
    return options;
  }, [participants, order, includeHuman, humanName]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SettingsHeader
        settingsLocked={settingsLocked}
        currentMeetingHasHistory={currentMeetingHasHistory}
        canStart={canStart}
        onBackToMeeting={onBackToMeeting}
        onStartMeeting={onStartMeeting}
        onViewStatistics={onViewStatistics}
        onDownloadSettings={onDownloadSettings}
        onImportSettings={onImportSettings}
        onResetMeeting={onResetMeeting}
      />
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarGutter: "stable both-edges" }}
      >
        <div
          className={`max-w-5xl w-full mx-auto px-6 py-8 relative transition-colors ${
            isDragOverSettings ? "bg-surface-secondary shadow-[0_0_0_3px_rgba(37,99,235,0.12)]" : ""
          }`}
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {isDragOverSettings && (
            <DragOverlay message="Drop meeting JSON to import" />
          )}
          {isGeneratingSample && (
            <LoadingOverlay
              title="Generating Random Sample..."
              subtitle="Creating diverse participants and tour scenario"
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            onChange={onFileInputChange}
          />

          {randomSampleError && (
            <div className="mb-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              <div className="flex items-start justify-between gap-4">
                <p>
                  {randomSampleError.includes("No LLM API key configured") ? (
                    <>
                      Failed to generate random sample: No LLM API key configured. Please configure an API key in{" "}
                      <button
                        type="button"
                        onClick={onOpenApiSettings}
                        className="font-medium underline underline-offset-2 hover:text-red-900 dark:hover:text-red-100"
                      >
                        Settings
                      </button>
                      .
                    </>
                  ) : (
                    randomSampleError
                  )}
                </p>
                <button
                  type="button"
                  onClick={onDismissRandomSampleError}
                  className="shrink-0 text-red-500 hover:text-red-700 dark:text-red-300 dark:hover:text-red-100"
                  aria-label="Dismiss random sampling error"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          <TitleSection
            meetingTitle={meetingTitle}
            setMeetingTitle={setMeetingTitle}
            isEditingTitle={isEditingTitle}
            setIsEditingTitle={setIsEditingTitle}
            updateMeetingTitle={updateMeetingTitle}
            settingsLocked={settingsLocked}
          />

          <ParticipantsSection
            participants={participants}
            order={order}
            setOrder={setOrder}
            includeHuman={includeHuman}
            updateIncludeHuman={updateIncludeHuman}
            humanName={humanName}
            humanAvatar={humanAvatar}
            humanRole={humanRole}
            onEditHuman={onEditHuman}
            onHumanMenuOpen={onHumanMenuOpen}
            tooManyFacilitators={tooManyFacilitators}
            currentMeetingId={currentMeetingId}
            connected={connected}
            settingsLocked={settingsLocked}
            apiBase={apiBase}
            isDragOverParticipants={isDragOverParticipants}
            onAddParticipant={onAddParticipant}
            onDownloadParticipants={onDownloadParticipants}
            onRemoveAllParticipants={onRemoveAllParticipants}
            onParticipantsDragOver={onParticipantsDragOver}
            onParticipantsDragLeave={onParticipantsDragLeave}
            onParticipantsDrop={onParticipantsDrop}
            showParticipantMenu={showParticipantMenu}
            onViewParticipant={onViewParticipant}
          />

          <GoalsSection
            globalGoals={globalGoals}
            setGlobalGoals={(v) => updateSetting('globalGoals', v)}
            settingsLocked={settingsLocked}
          />

          <ConstraintsSection
            travelDate={travelDate}
            setTravelDate={(v) => updateSetting('travelDate', v)}
            budget={budget}
            setBudget={(v) => updateSetting('budget', v)}
            timeWindowStart={timeWindowStart}
            setTimeWindowStart={(v) => updateSetting('timeWindowStart', v)}
            timeWindowEnd={timeWindowEnd}
            setTimeWindowEnd={(v) => updateSetting('timeWindowEnd', v)}
            maxTurns={maxTurns}
            setMaxTurns={(v) => updateSetting('maxTurns', v)}
            timeLimit={timeLimit}
            setTimeLimit={(v) => updateSetting('timeLimit', v)}
            settingsLocked={settingsLocked}
          />

          <WorkflowSection
            turnRule={turnRule}
            setTurnRule={(v) => updateSetting('turnRule', v)}
            draftVotingRule={draftVotingRule}
            setDraftVotingRule={(v) => updateSetting('draftVotingRule', v)}
            singleDecider={singleDecider}
            setSingleDecider={(v) => updateSetting('singleDecider', v)}
            deciderOptions={deciderOptions}
            volunteerMode={volunteerMode}
            setVolunteerMode={(v) => updateSetting('volunteerMode', v)}
            balancedTurns={balancedTurns}
            setBalancedTurns={(v) => updateSetting('balancedTurns', v)}
            voteTurnRule={voteTurnRule}
            setVoteTurnRule={(v) => updateSetting('voteTurnRule', v)}
            voteSettingsLinked={voteSettingsLinked}
            setVoteSettingsLinked={(v) => updateSetting('voteSettingsLinked', v)}
            settingsLocked={settingsLocked}
          />
        </div>
      </div>
    </div>
  );
};

export default SettingsView;
