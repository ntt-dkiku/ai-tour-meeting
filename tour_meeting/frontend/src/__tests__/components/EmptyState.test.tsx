import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import EmptyState from "../../components/EmptyState";

describe("EmptyState", () => {
  it("should render the Create meeting table", () => {
    render(<EmptyState />);
    expect(screen.getByText("Create meeting")).toBeInTheDocument();
  });

  it("should expose the table as a button", () => {
    render(<EmptyState />);
    expect(
      screen.getByRole("button", { name: "Create meeting" })
    ).toBeInTheDocument();
  });

  it("should call onStart when the table is clicked", () => {
    const onStart = vi.fn();
    render(<EmptyState onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Create meeting" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("should not throw when clicked without an onStart handler", () => {
    render(<EmptyState />);
    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Create meeting" }))
    ).not.toThrow();
  });

  it("should have a centered, full-height layout", () => {
    const { container } = render(<EmptyState />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("flex");
    expect(wrapper.className).toContain("items-center");
    expect(wrapper.className).toContain("justify-center");
    expect(wrapper.className).toContain("h-full");
  });

  it("should render the table as a rounded, dotted oval", () => {
    render(<EmptyState />);
    const button = screen.getByRole("button", { name: "Create meeting" });
    expect(button.className).toContain("rounded-[50%]");
    expect(button.style.backgroundImage).toContain("radial-gradient");
  });
});
