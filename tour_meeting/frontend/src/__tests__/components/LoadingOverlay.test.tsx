import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type React from "react";
import LoadingOverlay from "../../components/ui/LoadingOverlay";
import { ThemeProvider } from "../../context/ThemeContext";

const renderWithTheme = (ui: React.ReactElement) => {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
};

describe("LoadingOverlay", () => {
  it("should render with title", () => {
    renderWithTheme(<LoadingOverlay title="Loading..." />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("should render with title and subtitle", () => {
    renderWithTheme(<LoadingOverlay title="Processing" subtitle="Please wait" />);

    expect(screen.getByText("Processing")).toBeInTheDocument();
    expect(screen.getByText("Please wait")).toBeInTheDocument();
  });

  it("should not render subtitle when not provided", () => {
    renderWithTheme(<LoadingOverlay title="Loading" />);

    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("Please wait")).not.toBeInTheDocument();
  });

  it("should have correct structure for loading spinner", () => {
    const { container } = renderWithTheme(<LoadingOverlay title="Loading" />);

    // Check for spinner container
    const spinnerContainer = container.querySelector(".w-12.h-12");
    expect(spinnerContainer).toBeInTheDocument();

    // Check for animated element
    const animatedElement = container.querySelector(".animate-spin");
    expect(animatedElement).toBeInTheDocument();
  });

  it("should have overlay styling", () => {
    const { container } = renderWithTheme(<LoadingOverlay title="Loading" />);

    const overlay = container.firstChild as HTMLElement;
    expect(overlay.className).toContain("absolute");
    expect(overlay.className).toContain("inset-0");
    expect(overlay.className).toContain("z-20");
  });

  it("should center content", () => {
    const { container } = renderWithTheme(<LoadingOverlay title="Loading" />);

    const overlay = container.firstChild as HTMLElement;
    expect(overlay.className).toContain("flex");
    expect(overlay.className).toContain("items-center");
    expect(overlay.className).toContain("justify-center");
  });

  it("should render title with correct styling", () => {
    renderWithTheme(<LoadingOverlay title="Test Title" />);

    const title = screen.getByText("Test Title");
    expect(title.className).toContain("text-lg");
    expect(title.className).toContain("font-semibold");
  });

  it("should render subtitle with correct styling", () => {
    renderWithTheme(<LoadingOverlay title="Title" subtitle="Subtitle text" />);

    const subtitle = screen.getByText("Subtitle text");
    expect(subtitle.className).toContain("text-sm");
    expect(subtitle.className).toContain("text-on-surface-tertiary");
  });
});
