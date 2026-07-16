"""Tests for per-currency route cost aggregation."""

from __future__ import annotations

from tour_meeting.tour_meeting import format_cost_totals, parse_cost_amount


class TestParseCostAmount:
    def test_symbol_prefix(self):
        assert parse_cost_amount("$20") == ("$", 20.0)
        assert parse_cost_amount("¥1,500") == ("¥", 1500.0)
        assert parse_cost_amount("€12.50") == ("€", 12.5)

    def test_yen_suffix_maps_to_yen_symbol(self):
        assert parse_cost_amount("500円") == ("¥", 500.0)

    def test_bare_number_has_empty_symbol(self):
        assert parse_cost_amount("1500") == ("", 1500.0)

    def test_no_number_returns_none(self):
        assert parse_cost_amount("Free entry (donation optional)") is None
        assert parse_cost_amount("") is None
        assert parse_cost_amount(None) is None

    def test_word_prefix_with_amount_keeps_real_symbol(self):
        assert parse_cost_amount("Approx. ¥300") == ("¥", 300.0)


class TestFormatCostTotals:
    def test_single_currency(self):
        assert format_cost_totals(["¥400", "¥1,500", "¥400"]) == "¥2,300"

    def test_mixed_currencies_listed_separately(self):
        assert format_cost_totals(["$20", "¥1,500"]) == "$20 + ¥1,500"

    def test_first_seen_order_is_kept(self):
        assert format_cost_totals(["¥500", "$20", "¥1,000"]) == "¥1,500 + $20"

    def test_free_text_entries_are_ignored(self):
        assert format_cost_totals(["Free entry", "¥940"]) == "¥940"

    def test_bare_numbers_shown_without_symbol(self):
        assert format_cost_totals(["1500", "500"]) == "2,000"

    def test_zero_totals_are_dropped(self):
        assert format_cost_totals(["¥0", "$20"]) == "$20"

    def test_all_empty_returns_none(self):
        assert format_cost_totals(["", None, "Free"]) is None
