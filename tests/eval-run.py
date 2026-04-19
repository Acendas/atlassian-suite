#!/usr/bin/env python3
"""Atlassian Suite eval runner — static analysis + per-skill assertions.

Usage:
    python3 tests/eval-run.py              # Run all checks
    python3 tests/eval-run.py --skill init # Run checks for one skill (by directory name)
    python3 tests/eval-run.py --verbose    # Show passing assertions too

Checks:
    1. Frontmatter validity (every skills/<name>/SKILL.md has parseable frontmatter
       with `name` and `description`)
    2. Description length (>= 80 chars — short descriptions don't trigger reliably)
    3. File references resolve (paths mentioned in skill bodies that look like
       repo-relative paths must exist on disk)
    4. Per-skill assertions from tests/assertions/<dirname>.json with check types:
         - contains: regex must match in skill body (+ references/)
         - not_contains: regex must NOT match in SKILL.md body (refs ignored)
         - frontmatter_field: a frontmatter key must equal a given value
         - frontmatter_contains: a frontmatter list/string field must contain a substring
         - file_exists: a repo-relative path must exist on disk

Adapted from shipyard's tests/eval-run.py — stripped of shipyard-specific
checks (ship-* prefix, banned patterns, session mutex, hook syntax) so this
runner is generic across atlassian-suite skills.
"""

import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = PROJECT_ROOT / "skills"
ASSERTIONS_DIR = Path(__file__).resolve().parent / "assertions"


class Result:
    def __init__(self):
        self.passed = []
        self.failed = []
        self.warnings = []

    def ok(self, check, detail=""):
        self.passed.append((check, detail))

    def fail(self, check, detail=""):
        self.failed.append((check, detail))

    def warn(self, check, detail=""):
        self.warnings.append((check, detail))

    @property
    def total(self):
        return len(self.passed) + len(self.failed)


def parse_frontmatter(filepath):
    """Extract YAML frontmatter from a markdown file. Returns (dict, error)."""
    try:
        text = filepath.read_text(encoding="utf-8")
    except Exception as e:
        return None, str(e)

    match = re.match(r"^---\s*\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return None, "no frontmatter found"

    fm = {}
    for line in match.group(1).split("\n"):
        line = line.strip()
        if ":" in line and not line.startswith("#"):
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if val.startswith("[") and val.endswith("]"):
                val = [
                    v.strip().strip('"').strip("'")
                    for v in val[1:-1].split(",")
                    if v.strip()
                ]
            fm[key] = val
    return fm, None


def read_file(filepath):
    try:
        return filepath.read_text(encoding="utf-8")
    except Exception:
        return ""


def list_skill_dirs():
    """Yield (dirname, SKILL.md path) for every skill directory."""
    if not SKILLS_DIR.exists():
        return
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir():
            continue
        skill_md = skill_dir / "SKILL.md"
        if skill_md.exists():
            yield skill_dir.name, skill_md


# ─── Check 1: Frontmatter validity + description length ───

def check_frontmatter(result, skill_filter=None):
    for dirname, skill_file in list_skill_dirs():
        if skill_filter and dirname != skill_filter:
            continue

        fm, err = parse_frontmatter(skill_file)
        if err:
            result.fail(f"frontmatter:{dirname}", err)
            continue

        for field in ("name", "description"):
            if fm.get(field):
                result.ok(f"frontmatter:{dirname}:has_{field}")
            else:
                result.fail(
                    f"frontmatter:{dirname}:has_{field}",
                    f"missing or empty '{field}' in frontmatter",
                )

        desc = fm.get("description") or ""
        if isinstance(desc, list):
            desc = " ".join(desc)
        if len(desc) >= 80:
            result.ok(f"frontmatter:{dirname}:description_length")
        else:
            result.warn(
                f"frontmatter:{dirname}:description_length",
                f"description is only {len(desc)} chars — short descriptions "
                f"don't trigger the skill reliably; aim for >= 80",
            )


# ─── Check 2: File references resolve ───

# Match likely repo-relative paths inside backticks. Conservative: only
# inside `…` and only paths that start with one of the known top-level dirs.
REF_DIRS = ("server/", "skills/", "agents/", "tests/", "hooks/")
PATH_RE = re.compile(
    r"`(" + "|".join(re.escape(d) for d in REF_DIRS) + r"[\w./-]+)`"
)


def check_file_references(result, skill_filter=None):
    for dirname, skill_file in list_skill_dirs():
        if skill_filter and dirname != skill_filter:
            continue
        content = read_file(skill_file)
        seen = set()
        for m in PATH_RE.finditer(content):
            ref = m.group(1).rstrip("/.")
            if ref in seen:
                continue
            seen.add(ref)
            full = PROJECT_ROOT / ref
            if full.exists():
                result.ok(f"ref:{dirname}:{ref}")
            else:
                result.fail(
                    f"ref:{dirname}:{ref}",
                    f"referenced path not found on disk: {ref}",
                )


# ─── Check 3: Per-skill assertions ───

def check_skill_assertions(result, skill_filter=None):
    if not ASSERTIONS_DIR.exists():
        return

    for assertion_file in sorted(ASSERTIONS_DIR.glob("*.json")):
        skill_name = assertion_file.stem
        if skill_filter and skill_name != skill_filter:
            continue

        try:
            cases = json.loads(assertion_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            result.fail(f"assertions:{skill_name}:parse", str(e))
            continue

        skill_dir = SKILLS_DIR / skill_name
        if not skill_dir.exists():
            result.fail(
                f"assertions:{skill_name}:exists",
                f"no matching skills/{skill_name}/ directory",
            )
            continue

        skill_main = read_file(skill_dir / "SKILL.md")
        refs_text = ""
        for md in skill_dir.rglob("*.md"):
            if md.name != "SKILL.md":
                refs_text += read_file(md) + "\n"

        for case in cases:
            name = case.get("name", "unnamed")
            check_type = case.get("type", "contains")
            check_id = f"assert:{skill_name}:{name}"

            if check_type == "contains":
                pattern = case.get("pattern", "")
                flags = re.IGNORECASE | (re.DOTALL if case.get("dotall") else 0)
                text = skill_main + "\n" + refs_text
                if re.search(pattern, text, flags):
                    result.ok(check_id)
                else:
                    result.fail(check_id, f"pattern not found: {pattern}")

            elif check_type == "not_contains":
                pattern = case.get("pattern", "")
                flags = re.IGNORECASE | (re.DOTALL if case.get("dotall") else 0)
                # Only scan SKILL.md — references are allowed to discuss
                # negations / antipatterns explicitly.
                match = re.search(pattern, skill_main, flags)
                if match:
                    line_num = skill_main[: match.start()].count("\n") + 1
                    snippet = skill_main[match.start() : match.start() + 80].replace("\n", " ")
                    result.fail(
                        check_id,
                        f"banned pattern matched at SKILL.md:L{line_num}: {pattern}\n"
                        f"  matched text: {snippet!r}",
                    )
                else:
                    result.ok(check_id)

            elif check_type == "frontmatter_field":
                fm, _ = parse_frontmatter(skill_dir / "SKILL.md")
                field = case.get("field", "")
                expected = case.get("value", None)
                if fm and field in fm:
                    actual = fm[field]
                    if expected is None or actual == expected:
                        result.ok(check_id)
                    else:
                        result.fail(
                            check_id,
                            f"field '{field}' = {actual!r}, expected {expected!r}",
                        )
                else:
                    result.fail(check_id, f"field '{field}' not in frontmatter")

            elif check_type == "frontmatter_contains":
                # For list-shaped or comma-string fields like allowed-tools.
                fm, _ = parse_frontmatter(skill_dir / "SKILL.md")
                field = case.get("field", "")
                needle = case.get("value", "")
                if not fm or field not in fm:
                    result.fail(check_id, f"field '{field}' not in frontmatter")
                    continue
                raw = fm[field]
                hay = ", ".join(raw) if isinstance(raw, list) else str(raw)
                if needle in hay:
                    result.ok(check_id)
                else:
                    result.fail(
                        check_id,
                        f"field '{field}' does not contain {needle!r}; got {hay!r}",
                    )

            elif check_type == "file_exists":
                path = case.get("path", "")
                full = PROJECT_ROOT / path
                if full.exists():
                    result.ok(check_id)
                else:
                    result.fail(check_id, f"file not found: {path}")

            else:
                result.warn(check_id, f"unknown check type: {check_type}")


# ─── Report ───

def print_report(result, verbose=False):
    print()
    print("=" * 60)
    print("  ATLASSIAN SUITE EVAL REPORT")
    print("=" * 60)
    print()

    if result.failed:
        print(f"  FAILED:   {len(result.failed)}")
        print(f"  PASSED:   {len(result.passed)}")
        if result.warnings:
            print(f"  WARNINGS: {len(result.warnings)}")
        print(f"  TOTAL:    {result.total}")
        print()
        print("-" * 60)
        print("  FAILURES")
        print("-" * 60)
        for check, detail in result.failed:
            print(f"\n  FAIL  {check}")
            if detail:
                for line in detail.split("\n"):
                    print(f"        {line}")
    else:
        print(f"  ALL PASSED: {len(result.passed)} checks")
        if result.warnings:
            print(f"  WARNINGS:   {len(result.warnings)}")

    if result.warnings:
        print()
        print("-" * 60)
        print("  WARNINGS")
        print("-" * 60)
        for check, detail in result.warnings:
            print(f"\n  WARN  {check}")
            if detail:
                for line in detail.split("\n"):
                    print(f"        {line}")

    if verbose and result.passed:
        print()
        print("-" * 60)
        print("  PASSED")
        print("-" * 60)
        for check, _ in result.passed:
            print(f"  OK    {check}")

    print()
    print("=" * 60)
    status = "FAIL" if result.failed else "PASS"
    print(
        f"  {status} — {len(result.passed)} passed, {len(result.failed)} failed, "
        f"{len(result.warnings)} warnings"
    )
    print("=" * 60)
    print()

    return 0 if not result.failed else 1


def main():
    args = sys.argv[1:]
    verbose = "--verbose" in args or "-v" in args
    skill_filter = None
    if "--skill" in args:
        idx = args.index("--skill")
        if idx + 1 < len(args):
            skill_filter = args[idx + 1]

    result = Result()

    check_frontmatter(result, skill_filter)
    check_file_references(result, skill_filter)
    check_skill_assertions(result, skill_filter)

    sys.exit(print_report(result, verbose))


if __name__ == "__main__":
    main()
