import React from "react";
import { Undo2, BarChart } from "lucide-react";
import ActionButton from "../ui/ActionButton";
import PageHeader from "../ui/PageHeader";

interface MeetingHeaderProps {
  meetingTitle: string;
  globalGoals: string;
  connected: boolean;
  status: string;
  onBackToSettings: () => void;
  onViewStatistics: () => void;
  onStopMeeting: () => void;
  onResumeMeeting: () => void;
}

const MeetingHeader: React.FC<MeetingHeaderProps> = ({
  meetingTitle,
  globalGoals,
  connected,
  status,
  onBackToSettings,
  onViewStatistics,
  onStopMeeting,
  onResumeMeeting,
}) => {
  const statusLower = status.toLowerCase();
  // An errored meeting is resumable too (e.g., after fixing API keys).
  const canResume = statusLower === "stopped" || statusLower.startsWith("error");

  return (
    <PageHeader title={meetingTitle || "Meeting"} subtitle={globalGoals}>
      <ActionButton onClick={onBackToSettings} title="Back to meeting settings">
        <Undo2 className="w-4 h-4" />
        <span className="text-sm font-medium">Settings</span>
      </ActionButton>
      <ActionButton onClick={onViewStatistics} title="View analytics dashboard">
        <BarChart className="w-4 h-4" />
        <span className="text-sm font-medium">Statistics</span>
      </ActionButton>
      <button
        onClick={connected ? onStopMeeting : canResume ? onResumeMeeting : undefined}
        disabled={connected ? false : !canResume}
        className={`px-6 py-2 rounded-lg font-semibold transition-colors ${
          connected
            ? "bg-accent text-white hover:bg-accent-hover"
            : canResume
            ? "bg-accent text-white hover:bg-accent-hover"
            : "bg-gray-200 text-on-surface-tertiary cursor-not-allowed"
        }`}
      >
        {connected ? "Stop" : "Resume"}
      </button>
    </PageHeader>
  );
};

export default MeetingHeader;
