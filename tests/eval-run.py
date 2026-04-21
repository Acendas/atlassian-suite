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
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = PROJECT_ROOT / "skills"
SERVER_SRC = PROJECT_ROOT / "server" / "src"
AUTH_MJS = PROJECT_ROOT / "server" / "scripts" / "auth.mjs"
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

            elif check_type == "frontmatter_not_contains":
                # Inverse of frontmatter_contains. If the field is missing,
                # treat that as "trivially does not contain" → pass.
                fm, _ = parse_frontmatter(skill_dir / "SKILL.md")
                field = case.get("field", "")
                needle = case.get("value", "")
                if not fm or field not in fm:
                    result.ok(check_id)
                    continue
                raw = fm[field]
                hay = ", ".join(raw) if isinstance(raw, list) else str(raw)
                if needle in hay:
                    result.fail(
                        check_id,
                        f"field '{field}' must NOT contain {needle!r}; got {hay!r}",
                    )
                else:
                    result.ok(check_id)

            elif check_type == "file_exists":
                path = case.get("path", "")
                full = PROJECT_ROOT / path
                if full.exists():
                    result.ok(check_id)
                else:
                    result.fail(check_id, f"file not found: {path}")

            else:
                result.warn(check_id, f"unknown check type: {check_type}")


# ─── Check 4: Tool / skill cross-reference ───
#
# Every MCP tool named in a skill's allowed-tools must actually be
# registered somewhere in server/src/**.ts. And every tool a skill body
# calls (matching the `mcp__acendas-atlassian__<name>` form) must also
# exist. Catches the "renamed a tool, forgot a skill" regression.

TOOL_FRONTMATTER_PREFIX = "mcp__acendas-atlassian__"
TOOL_REG_RE = re.compile(r'name:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"')
TOOL_BODY_REF_RE = re.compile(
    r"mcp__acendas-atlassian__([a-zA-Z_][a-zA-Z0-9_]*)"
)


def collect_registered_tools():
    """Walk server/src/**.ts for `server.addTool({ name: "..." })`. Returns set of tool names."""
    tools = set()
    if not SERVER_SRC.exists():
        return tools
    for ts in SERVER_SRC.rglob("*.ts"):
        try:
            text = ts.read_text(encoding="utf-8")
        except Exception:
            continue
        # Restrict matches to lines that look like they're inside an addTool
        # block to avoid matching unrelated `name:` keys. Cheap heuristic:
        # require the match to appear within 4 lines after "addTool" or
        # an open brace whose preceding token is addTool.
        for m in re.finditer(
            r"server\.addTool\s*\(\s*\{\s*name:\s*\"([a-zA-Z_][a-zA-Z0-9_]*)\"",
            text,
        ):
            tools.add(m.group(1))
    return tools


def check_tool_skill_crossref(result, skill_filter=None):
    registered = collect_registered_tools()
    if not registered:
        # If we can't find any registered tools, the server src must be
        # unreadable — fail one summary check rather than flooding.
        result.fail(
            "crossref:server_src_discovery",
            f"no tool registrations found under {SERVER_SRC}",
        )
        return

    for dirname, skill_file in list_skill_dirs():
        if skill_filter and dirname != skill_filter:
            continue
        content = read_file(skill_file)
        fm, _ = parse_frontmatter(skill_file)

        seen_in_allowed = set()
        raw_allowed = (fm or {}).get("allowed-tools", "")
        if isinstance(raw_allowed, list):
            for entry in raw_allowed:
                s = str(entry).strip()
                if s.startswith(TOOL_FRONTMATTER_PREFIX):
                    seen_in_allowed.add(s[len(TOOL_FRONTMATTER_PREFIX) :])
        elif isinstance(raw_allowed, str):
            for entry in raw_allowed.split(","):
                s = entry.strip()
                if s.startswith(TOOL_FRONTMATTER_PREFIX):
                    seen_in_allowed.add(s[len(TOOL_FRONTMATTER_PREFIX) :])

        for tool in seen_in_allowed:
            check_id = f"crossref:{dirname}:{tool}"
            if tool in registered:
                result.ok(check_id)
            else:
                result.fail(
                    check_id,
                    f"allowed-tools lists {tool!r} but no server.addTool({{name: \"{tool}\"}}) found",
                )

        # Body references (rare, but we check)
        in_body = set(TOOL_BODY_REF_RE.findall(content))
        for tool in in_body:
            if tool in seen_in_allowed:
                continue  # already covered
            check_id = f"crossref:{dirname}:body:{tool}"
            if tool in registered:
                # Body mentions a tool not in allowed-tools — warn; the skill
                # can't actually use it unless added.
                result.warn(
                    check_id,
                    f"body references {tool!r} but it's not in allowed-tools",
                )
            else:
                result.fail(
                    check_id,
                    f"body references {tool!r} but no tool by that name is registered",
                )


# ─── Check 5: Scope list structural validation ───
#
# Every entry in SCOPES.confluence (and .jira, .bitbucket) must have
# scope, required, why. Confluence entries must also have family. Probes
# are optional but their shape is validated when present.

SCOPE_BLOCK_RE = re.compile(
    r"^\s*(jira|confluence|bitbucket):\s*\[(.*?)^\s*\],?\s*$",
    re.DOTALL | re.MULTILINE,
)
SCOPE_ENTRY_RE = re.compile(
    r"\{\s*(?:scope|family|required|why|probe)\b.*?\n\s*\}",
    re.DOTALL,
)


def check_scope_list(result):
    """Lightweight structural check of SCOPES in auth.mjs. Not a full JS
    parser — regex-based, meant to catch drift (missing `family` on a
    new Confluence entry, typo in required, …). Runs auth.mjs itself
    under `node --check` as a syntax gate first."""
    if not AUTH_MJS.exists():
        result.fail("scopes:auth_mjs_exists", f"auth.mjs not found at {AUTH_MJS}")
        return

    # Syntax gate: node --check catches typos that break require("auth.mjs")
    try:
        syntax = subprocess.run(
            ["node", "--check", str(AUTH_MJS)],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception as e:
        result.fail("scopes:auth_mjs_syntax", f"failed to run node --check: {e}")
        return
    if syntax.returncode != 0:
        result.fail(
            "scopes:auth_mjs_syntax",
            syntax.stderr.strip() or "node --check failed",
        )
        return
    result.ok("scopes:auth_mjs_syntax")

    text = read_file(AUTH_MJS)
    # Extract each product's scope block via brace-balanced scan. Regex
    # doesn't handle nested braces cleanly; we fall back to a simple
    # "first `[` after `confluence:` up to the matching `]`" scan.

    def extract_block(product):
        anchor = re.search(rf"\b{product}:\s*\[", text)
        if not anchor:
            return None
        i = anchor.end() - 1  # position of '['
        depth = 0
        for j in range(i, len(text)):
            ch = text[j]
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth -= 1
                if depth == 0:
                    return text[i + 1 : j]
        return None

    # Confluence: every entry must have family ∈ {granular, classic}.
    conf_block = extract_block("confluence")
    if conf_block is None:
        result.fail("scopes:confluence:block", "could not locate SCOPES.confluence block")
    else:
        # Cheap entry split: top-level objects are separated by `}, {`.
        # This works for our known shape.
        entries = re.findall(r"\{([^{}]*)\}", conf_block)
        if not entries:
            result.fail("scopes:confluence:entries", "no entries parsed — shape changed?")
        else:
            for entry in entries:
                scope_m = re.search(r"scope:\s*\"([^\"]+)\"", entry)
                if not scope_m:
                    # Skip entries without a scope field — not a scope entry.
                    continue
                scope_name = scope_m.group(1)
                check_id = f"scopes:confluence:{scope_name}"
                if "family:" not in entry:
                    result.fail(check_id + ":family", "missing family field")
                else:
                    fam_m = re.search(r"family:\s*\"(granular|classic)\"", entry)
                    if fam_m:
                        result.ok(check_id + ":family")
                    else:
                        result.fail(
                            check_id + ":family",
                            "family value must be 'granular' or 'classic'",
                        )
                for field in ("required", "why"):
                    if re.search(rf"\b{field}:", entry):
                        result.ok(f"{check_id}:has_{field}")
                    else:
                        result.fail(
                            f"{check_id}:has_{field}",
                            f"missing {field} field",
                        )


# ─── Check 6: Storage unit tests ───
#
# _storage.ts has its own test runner embedded. Invoke via tsx and
# fail the eval suite if any unit test fails.

STORAGE_TEST = PROJECT_ROOT / "server" / "src" / "confluence" / "_storage.test.ts"


def check_storage_unit_tests(result):
    if not STORAGE_TEST.exists():
        # Absent file → skip silently; other checks will flag missing tests.
        return
    try:
        proc = subprocess.run(
            ["npx", "tsx", str(STORAGE_TEST)],
            capture_output=True,
            text=True,
            cwd=str(PROJECT_ROOT / "server"),
            timeout=60,
        )
    except Exception as e:
        result.fail("storage:unit_tests", f"failed to spawn: {e}")
        return

    out = (proc.stdout or "") + (proc.stderr or "")
    # Parse the "N passed, M failed" summary the runner emits.
    summary = re.search(r"(\d+)\s+passed,\s+(\d+)\s+failed", out)
    if not summary:
        result.fail(
            "storage:unit_tests",
            f"could not parse test output\n{out.strip()[:400]}",
        )
        return
    passed = int(summary.group(1))
    failed = int(summary.group(2))
    if failed == 0:
        result.ok(f"storage:unit_tests ({passed} tests)")
    else:
        # Show the FAIL lines from the test output.
        fails = "\n".join(l for l in out.splitlines() if "FAIL:" in l)
        result.fail(
            "storage:unit_tests",
            f"{failed} of {passed + failed} tests failed\n{fails}",
        )


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
    check_tool_skill_crossref(result, skill_filter)
    if skill_filter is None:
        check_scope_list(result)
        check_storage_unit_tests(result)

    sys.exit(print_report(result, verbose))


if __name__ == "__main__":
    main()
