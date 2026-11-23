#!/usr/bin/env python3
"""Compare published payroll references with the documents reviewed for the calculator."""

import argparse
import hashlib
import json
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

MANIFEST = Path(__file__).with_name("payroll-tax-sources.json")


def fingerprint(data):
    if data.startswith(b"%PDF-"):
        return hashlib.sha256(data).hexdigest()
    html = data.decode("utf-8", errors="replace")
    main = re.search(r"<main\b[^>]*>(.*?)</main>", html, flags=re.I | re.S)
    content = main.group(1) if main else html
    content = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", content, flags=re.I | re.S)
    # Keep links so published replacements count as changes even when the labels match.
    content = re.sub(r"<a\b[^>]*\bhref=['\"]([^'\"]+)['\"][^>]*>", r" \1 ", content, flags=re.I)
    content = re.sub(r"<[^>]+>", " ", content)
    return hashlib.sha256(" ".join(content.split()).encode()).hexdigest()


def check(source):
    name, url, expected = source["name"], source["url"], source["sha256"]
    try:
        result = subprocess.run(
            ["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
             "--max-time", "20", "--max-filesize", "16777216", "--user-agent", "Mozilla/5.0", url],
            capture_output=True, check=True, timeout=25
        )
        current = fingerprint(result.stdout)
        if current != expected:
            return name, url, "Source changed"
        return name, url, "Matches reviewed source"
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return name, url, "Source could not be checked"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status-json", type=Path, help="Write the latest source status for the payroll portal")
    args = parser.parse_args()
    sources = json.loads(MANIFEST.read_text(encoding="utf-8"))
    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(check, sources))
    needs_review = [row for row in results if row[2] != "Matches reviewed source"]
    lines = [
        "## Payroll source check",
        "",
        f"{len(results) - len(needs_review)} of {len(results)} sources match the reviewed publications.",
        "Changed or unavailable sources require review before changing a payroll calculation.",
        "",
        "| Source | Status |",
        "| --- | --- |",
        *(f"| [{name}]({url}) | {status} |" for name, url, status in results)
    ]
    report = "\n".join(lines) + "\n"
    print(report, end="")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a", encoding="utf-8") as output:
            output.write(report)
    if args.status_json:
        issues = [
            {"name": name, "url": url, "status": "changed" if status == "Source changed" else "unavailable"}
            for name, url, status in needs_review
        ]
        result = {"checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  "sources_checked": len(results), "needs_review": issues}
        args.status_json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return int(bool(needs_review))


if __name__ == "__main__":
    raise SystemExit(main())
