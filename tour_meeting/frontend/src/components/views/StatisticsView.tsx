import React from "react";
import StatisticsHeader from "../settings/StatisticsHeader";
import AnalyticsDashboard from "../AnalyticsDashboard";

interface StatisticsViewProps {
  meetingId: string;
  apiBase: string;
  onBackToSettings: () => void;
  onViewMeeting: () => void;
}

const StatisticsView: React.FC<StatisticsViewProps> = ({
  meetingId,
  apiBase,
  onBackToSettings,
  onViewMeeting,
}) => {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <StatisticsHeader
        onBackToSettings={onBackToSettings}
        onViewMeeting={onViewMeeting}
      />
      <div className="flex-1 bg-surface overflow-hidden min-h-0">
        <AnalyticsDashboard meetingId={meetingId} apiBase={apiBase} />
      </div>
    </div>
  );
};

export default StatisticsView;
