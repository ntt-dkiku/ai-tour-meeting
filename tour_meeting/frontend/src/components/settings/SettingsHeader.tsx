import React from "react";
import { Download, UploadCloud, RotateCcw } from "lucide-react";
import ActionButton from "../ui/ActionButton";

interface SettingsHeaderProps {
  settingsLocked: boolean;
  currentMeetingHasHistory: boolean;
  canStart: boolean;
  onBackToMeeting: () => void;
  onStartMeeting: () => void;
  onViewStatistics: () => void;
  onDownloadSettings: () => void;
  onImportSettings: () => void;
  onResetMeeting: () => void;
}

const SettingsHeader: React.FC<SettingsHeaderProps> = ({
  settingsLocked,
  currentMeetingHasHistory,
  canStart,
  onBackToMeeting,
  onStartMeeting,
  onViewStatistics,
  onDownloadSettings,
  onImportSettings,
  onResetMeeting,
}) => {
  const renderPrimaryButton = () => {
    if (settingsLocked && currentMeetingHasHistory) {
      return (
        <ActionButton onClick={onBackToMeeting} title="Back to meeting">
          Meeting
        </ActionButton>
      );
    }
    if (!settingsLocked && !currentMeetingHasHistory) {
      return (
        <ActionButton
          onClick={onStartMeeting}
          disabled={!canStart}
          title="Start meeting"
        >
          Start
        </ActionButton>
      );
    }
    if (!settingsLocked && currentMeetingHasHistory) {
      return (
        <ActionButton onClick={onBackToMeeting} title="Back to meeting">
          Meeting
        </ActionButton>
      );
    }
    return null;
  };

  return (
    <div className="relative bg-surface overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-b from-surface via-surface/75 to-transparent"
      />
      <div className="relative max-w-5xl mx-auto w-full px-6 py-4 flex items-center justify-between text-on-surface-secondary">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-on-surface-secondary">
            Meeting settings
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {renderPrimaryButton()}
          {/* Statistics only makes sense once the meeting has been started
              (it's running, or it has produced history). */}
          {(settingsLocked || currentMeetingHasHistory) && (
            <ActionButton onClick={onViewStatistics} title="View analytics">
              Statistics
            </ActionButton>
          )}
          <ActionButton onClick={onDownloadSettings} title="Download meeting settings">
            <Download className="w-4 h-4" />
          </ActionButton>
          <ActionButton
            onClick={onImportSettings}
            disabled={settingsLocked}
            title="Import settings from file"
          >
            <UploadCloud className="w-4 h-4" />
          </ActionButton>
          {settingsLocked && (
            <ActionButton onClick={onResetMeeting} title="Reset meeting">
              <RotateCcw className="w-4 h-4" />
              Reset meeting
            </ActionButton>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsHeader;
