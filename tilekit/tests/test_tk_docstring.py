from tilekit.graph import Docstring, parse_docstring


def test_full_docstring():
    doc = parse_docstring('''AMC units.

    Monthly management charge deducted in units, after allocation,
    capped at a fixed number of units.

    A second paragraph.

    Units: units per policy
    Timing: end of month
    Format: units
    Assumed: the charge is on units after the same month's allocation
    Assumed: the cap is in units
    ''')
    assert doc.label == "AMC units"
    assert doc.spec == ("Monthly management charge deducted in units, after allocation, "
                        "capped at a fixed number of units.\n\nA second paragraph.")
    assert doc.units == "units per policy"
    assert doc.timing == "end of month"
    assert doc.format == "units"
    assert doc.assumed == ("the charge is on units after the same month's allocation", "the cap is in units")


def test_label_only_and_label_without_full_stop():
    assert parse_docstring("Premium.") == Docstring(label="Premium")
    assert parse_docstring("Premium").label == "Premium"


def test_missing_docstring():
    assert parse_docstring(None) == Docstring()
    assert parse_docstring("   ") == Docstring()


def test_indented_line_continues_key():
    doc = parse_docstring('''Label.

    Spec.

    Assumed: a long assumption that
        wraps onto a second line
    Format: amount
    ''')
    assert doc.assumed == ("a long assumption that wraps onto a second line",)
    assert doc.format == "amount"
    assert doc.spec == "Spec."


def test_unknown_key_is_spec_text():
    doc = parse_docstring('''Label.

    Note: this stays in the spec.
    Format: number
    ''')
    assert doc.spec == "Note: this stays in the spec."
    assert doc.format == "number"
