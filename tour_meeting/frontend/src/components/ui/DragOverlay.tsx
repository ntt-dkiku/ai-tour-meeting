import React from "react";
import { UploadCloud } from "lucide-react";

interface DragOverlayProps {
  message?: string;
}

const DragOverlay: React.FC<DragOverlayProps> = ({
  message = "Drop file to import"
}) => {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm font-medium pointer-events-none z-10 bg-surface-secondary text-on-surface-secondary"
    >
      <UploadCloud className="w-6 h-6" />
      <span>{message}</span>
    </div>
  );
};

export default DragOverlay;
