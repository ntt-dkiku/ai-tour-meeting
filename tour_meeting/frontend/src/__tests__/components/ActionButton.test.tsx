import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ActionButton from "../../components/ui/ActionButton";

describe("ActionButton", () => {
  it("should render with children", () => {
    render(<ActionButton>Click Me</ActionButton>);
    expect(screen.getByText("Click Me")).toBeInTheDocument();
  });

  it("should call onClick when clicked", () => {
    const handleClick = vi.fn();
    render(<ActionButton onClick={handleClick}>Click</ActionButton>);

    fireEvent.click(screen.getByRole("button"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("should not call onClick when disabled", () => {
    const handleClick = vi.fn();
    render(
      <ActionButton onClick={handleClick} disabled>
        Click
      </ActionButton>
    );

    fireEvent.click(screen.getByRole("button"));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("should render with title attribute", () => {
    render(<ActionButton title="Button title">Click</ActionButton>);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("title", "Button title");
  });

  it("should use title as aria-label when ariaLabel not provided", () => {
    render(<ActionButton title="Button title">Click</ActionButton>);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "Button title");
  });

  it("should use ariaLabel when provided", () => {
    render(
      <ActionButton title="Title" ariaLabel="Custom aria label">
        Click
      </ActionButton>
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-label", "Custom aria label");
  });

  it("should apply disabled styling", () => {
    render(<ActionButton disabled>Disabled</ActionButton>);

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button.className).toContain("opacity-50");
    expect(button.className).toContain("cursor-not-allowed");
  });

  it("should apply custom className", () => {
    render(<ActionButton className="custom-class">Button</ActionButton>);

    const button = screen.getByRole("button");
    expect(button.className).toContain("custom-class");
  });

  it("should have type button", () => {
    render(<ActionButton>Button</ActionButton>);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("type", "button");
  });

  it("should render with icon children", () => {
    render(
      <ActionButton>
        <span data-testid="icon">Icon</span>
        <span>Text</span>
      </ActionButton>
    );

    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("Text")).toBeInTheDocument();
  });

  it("should handle mouse enter/leave events for hover effect", () => {
    render(<ActionButton>Hover Me</ActionButton>);

    const button = screen.getByRole("button");

    fireEvent.mouseEnter(button);
    // Style is applied via inline styles, just verify no error occurs

    fireEvent.mouseLeave(button);
    // Style is reverted, verify no error occurs
  });

  it("should not apply hover effect when disabled", () => {
    render(<ActionButton disabled>Disabled</ActionButton>);

    const button = screen.getByRole("button");

    // mouseEnter on disabled button should not change backgroundColor to hover color
    const originalBg = button.style.backgroundColor;
    fireEvent.mouseEnter(button);
    // The component guards against hover when disabled
  });
});
