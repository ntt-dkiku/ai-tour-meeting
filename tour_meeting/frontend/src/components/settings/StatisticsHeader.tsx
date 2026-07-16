import React from "react";
import { Undo2, MessageSquare } from "lucide-react";
import ActionButton from "../ui/ActionButton";
import PageHeader from "../ui/PageHeader";

interface StatisticsHeaderProps {
  onBackToSettings: () => void;
  onViewMeeting: () => void;
}

const StatisticsHeader: React.FC<StatisticsHeaderProps> = ({
  onBackToSettings,
  onViewMeeting,
}) => {
  return (
    <PageHeader title="Analytics Dashboard">
      <ActionButton onClick={onBackToSettings} title="Back to meeting settings">
        <Undo2 className="w-4 h-4" />
        <span className="text-sm font-medium">Settings</span>
      </ActionButton>
      <ActionButton onClick={onViewMeeting} title="Back to meeting view">
        <MessageSquare className="w-4 h-4" />
        <span className="text-sm font-medium">Meeting</span>
      </ActionButton>
    </PageHeader>
  );
};

export default StatisticsHeader;
