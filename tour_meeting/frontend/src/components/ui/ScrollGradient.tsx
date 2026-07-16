import React from "react";
import { useTheme } from "../../context/ThemeContext";

interface ScrollGradientProps {
  position?: "top" | "bottom";
}

const ScrollGradient: React.FC<ScrollGradientProps> = ({
  position = "top",
}) => {
  const { theme } = useTheme();
  const isTop = position === "top";
  const gradientDirection = isTop ? "to bottom" : "to top";
  // Match --surface CSS variable values
  const color = theme === "dark" ? "rgba(17,24,39,1)" : "rgba(255,255,255,1)";

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 ${isTop ? "top-0" : "bottom-0"} h-3 z-10`}
      style={{
        backgroundImage: `linear-gradient(${gradientDirection}, ${color} 0%, ${color.replace("1)", "0.8)")} 55%, ${color.replace("1)", "0)")} 100%)`,
      }}
    />
  );
};

export default ScrollGradient;
