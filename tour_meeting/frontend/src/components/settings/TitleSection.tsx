import React from "react";

interface TitleSectionProps {
  meetingTitle: string;
  setMeetingTitle: (title: string) => void;
  isEditingTitle: boolean;
  setIsEditingTitle: (editing: boolean) => void;
  updateMeetingTitle: () => void;
  settingsLocked: boolean;
}

const TitleSection: React.FC<TitleSectionProps> = ({
  meetingTitle,
  setMeetingTitle,
  isEditingTitle,
  setIsEditingTitle,
  updateMeetingTitle,
  settingsLocked,
}) => {
  return (
    <div className="mb-6">
      <h3 className="text-sm font-semibold text-on-surface-secondary mb-3">Title</h3>
      {isEditingTitle ? (
        <input
          type="text"
          value={meetingTitle}
          onChange={(e) => setMeetingTitle(e.target.value)}
          onBlur={() => {
            updateMeetingTitle();
            setIsEditingTitle(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              updateMeetingTitle();
              setIsEditingTitle(false);
            }
          }}
          placeholder="Enter meeting title..."
          autoFocus
          disabled={settingsLocked}
          readOnly={settingsLocked}
          className={`w-full rounded-lg border p-3 text-on-surface focus:outline-none focus:ring-2 focus:ring-accent ${
            settingsLocked
              ? "bg-surface-tertiary text-on-surface-tertiary cursor-not-allowed border-outline focus:ring-0"
              : "bg-surface border-outline"
          }`}
        />
      ) : (
        <div
          onClick={!settingsLocked ? () => setIsEditingTitle(true) : undefined}
          className={`w-full rounded-lg border p-3 text-on-surface ${
            settingsLocked
              ? "border-outline bg-surface-tertiary cursor-not-allowed"
              : "bg-surface border-outline cursor-pointer hover:border-outline-secondary transition-colors"
          }`}
        >
          {meetingTitle || "Click to enter meeting title..."}
        </div>
      )}
    </div>
  );
};

export default TitleSection;
