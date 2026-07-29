"""Tests for participant module utility functions."""

from __future__ import annotations

from unittest.mock import MagicMock

from tour_meeting.participant import (
    Participant,
    Destination,
    RouteDraft,
    validate_route_costs,
    validate_route_times,
)


class TestTruncateText:
    """Tests for Participant._truncate_text static method."""

    def test_short_text_unchanged(self):
        """Text shorter than max_len is returned unchanged."""
        result = Participant._truncate_text("short text", max_len=100)

        assert result == "short text"

    def test_text_at_max_len_unchanged(self):
        """Text exactly at max_len is returned unchanged."""
        text = "x" * 100
        result = Participant._truncate_text(text, max_len=100)

        assert result == text

    def test_long_text_truncated_with_ellipsis(self):
        """Text longer than max_len is truncated with ellipsis."""
        text = "a" * 200
        result = Participant._truncate_text(text, max_len=100)

        assert len(result) <= 100
        assert result.endswith("...")
        assert result == "a" * 97 + "..."

    def test_none_input_returns_empty_string(self):
        """None input returns empty string."""
        result = Participant._truncate_text(None)

        assert result == ""

    def test_whitespace_stripped(self):
        """Leading and trailing whitespace is stripped."""
        result = Participant._truncate_text("  text with spaces  ")

        assert result == "text with spaces"

    def test_whitespace_only_returns_empty_string(self):
        """Whitespace-only text returns empty string."""
        result = Participant._truncate_text("   \n\t  ")

        assert result == ""

    def test_default_max_len_is_1500(self):
        """Default max_len is 1500."""
        text = "x" * 1500
        result = Participant._truncate_text(text)
        assert result == text

        text = "x" * 1501
        result = Participant._truncate_text(text)
        assert len(result) == 1500
        assert result.endswith("...")

    def test_truncation_strips_trailing_whitespace_before_ellipsis(self):
        """Truncation strips trailing whitespace before adding ellipsis."""
        text = "word " * 30  # Many words with trailing spaces
        result = Participant._truncate_text(text, max_len=50)

        assert result.endswith("...")
        # Should not have space before ellipsis
        assert not result.endswith(" ...")


class TestFormatRoute:
    """Tests for Participant._format_route static method."""

    def test_empty_list_returns_empty_string(self):
        """Empty route list returns empty string."""
        result = Participant._format_route([])

        assert result == ""

    def test_none_returns_empty_string(self):
        """None route returns empty string."""
        result = Participant._format_route(None)

        assert result == ""

    def test_string_list_formatted_with_arrows(self):
        """String list is formatted with arrows."""
        route = ["Tokyo Tower", "Senso-ji", "Shibuya"]
        result = Participant._format_route(route)

        assert result == "Tokyo Tower -> Senso-ji -> Shibuya"

    def test_single_destination_no_arrow(self):
        """Single destination has no arrow."""
        route = ["Tokyo Tower"]
        result = Participant._format_route(route)

        assert result == "Tokyo Tower"

    def test_destination_objects_use_name_attribute(self):
        """Destination objects use their name attribute."""
        dest1 = Destination(name="Tokyo Tower", description="Iconic landmark")
        dest2 = Destination(name="Senso-ji", description="Historic temple")
        route = [dest1, dest2]

        result = Participant._format_route(route)

        assert result == "Tokyo Tower -> Senso-ji"

    def test_mixed_strings_and_objects(self):
        """Mixed strings and objects are handled correctly."""
        dest = Destination(name="Senso-ji")
        route = ["Tokyo Tower", dest, "Shibuya"]

        result = Participant._format_route(route)

        assert result == "Tokyo Tower -> Senso-ji -> Shibuya"

    def test_empty_strings_skipped(self):
        """Empty strings in the list are skipped."""
        route = ["Tokyo Tower", "", "Senso-ji"]
        result = Participant._format_route(route)

        assert result == "Tokyo Tower -> Senso-ji"

    def test_objects_with_empty_name_skipped(self):
        """Objects with empty name are skipped."""
        dest1 = Destination(name="Tokyo Tower")
        dest2 = Destination(name="")  # Empty name
        dest3 = Destination(name="Senso-ji")
        route = [dest1, dest2, dest3]

        result = Participant._format_route(route)

        assert result == "Tokyo Tower -> Senso-ji"

    def test_objects_without_name_attribute_skipped(self):
        """Objects without name attribute are skipped."""
        mock_obj = MagicMock(spec=[])  # No name attribute
        route = ["Tokyo Tower", mock_obj, "Senso-ji"]

        result = Participant._format_route(route)

        assert result == "Tokyo Tower -> Senso-ji"

    def test_all_empty_items_returns_empty_string(self):
        """List with all empty items returns empty string."""
        route = ["", "", ""]
        result = Participant._format_route(route)

        assert result == ""


class TestValidateRouteCosts:
    """Tests for validate_route_costs."""

    @staticmethod
    def _draft(**fields) -> RouteDraft:
        return RouteDraft(
            message="hi",
            route=[Destination(name="Fushimi Inari", **fields)],
        )

    def test_symbol_plus_number_is_valid(self):
        for value in ["$20", "¥1500", "¥ 1,500", "€12.50", "£0", "500円"]:
            assert validate_route_costs(self._draft(cost=value)) == [], value

    def test_empty_cost_is_allowed(self):
        assert validate_route_costs(self._draft(cost="", transport_cost="")) == []

    def test_free_text_cost_is_violation(self):
        violations = validate_route_costs(
            self._draft(cost="Free entry (torii gates donation optional)")
        )
        assert len(violations) == 1
        assert "Fushimi Inari" in violations[0]
        assert "cost" in violations[0]

    def test_bare_number_without_symbol_is_violation(self):
        assert len(validate_route_costs(self._draft(cost="1500"))) == 1

    def test_transport_cost_is_checked(self):
        violations = validate_route_costs(
            self._draft(cost="¥400", transport_cost="included in pass")
        )
        assert len(violations) == 1
        assert "transport_cost" in violations[0]

    def test_multiple_destinations_report_each_violation(self):
        draft = RouteDraft(
            message="hi",
            route=[
                Destination(name="A", cost="Free"),
                Destination(name="B", cost="$10", transport_cost="varies"),
            ],
        )
        violations = validate_route_costs(draft)
        assert len(violations) == 2


class TestValidateRouteTimesTimeWindow:
    """Time-window checks in validate_route_times (retry-feedback source)."""

    @staticmethod
    def _draft(*dests):
        return RouteDraft(message="m", route=list(dests))

    @staticmethod
    def _dest(name, start, stay, travel="10 min"):
        return Destination(
            name=name, start_time=start, stay_duration=stay,
            travel_time_from_previous=travel,
        )

    def test_within_window_is_valid(self):
        draft = self._draft(
            self._dest("A", "09:00", "60 min", travel="0 min"),
            self._dest("B", "10:30", "60 min"),
        )
        assert validate_route_times(
            draft, time_window_start="09:00", time_window_end="18:00"
        ) == []

    def test_start_before_window(self):
        draft = self._draft(self._dest("A", "08:30", "60 min", travel="0 min"))
        violations = validate_route_times(
            draft, time_window_start="09:00", time_window_end="18:00"
        )
        assert len(violations) == 1
        assert "before the meeting's time window start" in violations[0]

    def test_end_past_window(self):
        # A ends at 17:50, fine; B ends at 19:10, past 18:00.
        draft = self._draft(
            self._dest("A", "17:00", "50 min", travel="0 min"),
            self._dest("B", "18:10", "60 min"),
        )
        violations = validate_route_times(
            draft, time_window_start="09:00", time_window_end="18:00"
        )
        assert [v for v in violations if "past the meeting's time window end" in v]
        assert all("A:" not in v for v in violations)

    def test_no_window_means_no_window_checks(self):
        draft = self._draft(self._dest("A", "05:00", "600 min", travel="0 min"))
        assert validate_route_times(draft) == []

    def test_single_stop_route_is_checked(self):
        # The window check must run even for routes shorter than two stops.
        draft = self._draft(self._dest("A", "17:30", "60 min", travel="0 min"))
        violations = validate_route_times(draft, time_window_end="18:00")
        assert len(violations) == 1
