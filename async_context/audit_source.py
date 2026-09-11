#!/usr/bin/env python3
"""Fail-closed structural audit for the async-context hardening candidate.

This does not replace runtime tests. It protects the intended ownership model
from being weakened while a runtime happens to retain green happy-path tests.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read(root: Path, relative: str) -> str:
    path = root / relative
    require(path.is_file(), f"missing required source file: {relative}")
    return path.read_text(encoding="utf-8")


def main() -> None:
    harness = Path(__file__).resolve().parent
    manifest = json.loads((harness / "source-under-test.json").read_text(encoding="utf-8"))
    root_value = os.environ.get("SOURCE_ROOT")
    require(bool(root_value), "SOURCE_ROOT is required")
    root = Path(root_value).resolve()
    require((root / ".git").exists(), f"SOURCE_ROOT is not a Git checkout: {root}")

    head = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()
    require(re.fullmatch(r"[0-9a-f]{40}", head) is not None, "source HEAD is not a full SHA")
    subprocess.run(
        ["git", "-C", str(root), "merge-base", "--is-ancestor", manifest["baseline_sha"], head],
        check=True,
    )
    dirty = subprocess.check_output(
        ["git", "-C", str(root), "status", "--porcelain"], text=True
    ).strip()
    require(not dirty, f"source checkout is dirty before testing: {dirty}")

    js_context = read(root, "src/context-shared.ts")
    js_execution = read(root, "src/execution-context-shared.ts")
    js_combined = js_context + "\n" + js_execution
    require(
        re.search(r"clone(Context)?Value|deepClone|structuredClone", js_combined) is not None,
        "TypeScript context snapshots still lack a recursive value clone",
    )
    require(
        not re.search(r"fields:\s*\{\s*\.\.\.context\.fields\s*\}", js_context),
        "TypeScript cloneLogContext still shallow-copies fields",
    )
    require(
        not re.search(r"baggage:\s*\{\s*\.\.\.context\.baggage\s*\}", js_execution),
        "TypeScript execution-context snapshot still shallow-copies baggage",
    )

    go_context = read(root, "sdk/go/context.go")
    require(
        re.search(r"func\s+(cloneContextValue|cloneAny|deepClone)", go_context) is not None,
        "Go context snapshots still lack a recursive any-value clone",
    )
    require("map[string]any" in go_context and "[]any" in go_context, "Go recursive clone lacks map/slice coverage")

    java_context = read(
        root,
        "sdk/java/src/main/java/com/oresoftware/nextloggers/NextLoggers.java",
    )
    require(
        re.search(r"deepImmutable|deepCopy|immutableValue", java_context) is not None,
        "Java context still protects only the outer map",
    )
    require("ThreadLocal" in java_context, "Java lost its guarded ThreadLocal boundary")

    ruby_context = read(root, "sdk/ruby/lib/oresoftware/next_loggers.rb")
    require(
        "thread_variable_get" not in ruby_context and "thread_variable_set" not in ruby_context,
        "Ruby still uses thread-wide storage and can leak between Fibers",
    )
    require(
        re.search(r"deep_(copy|dup|freeze)|immutable_copy", ruby_context) is not None,
        "Ruby context still lacks recursive snapshot ownership",
    )

    python_context = read(root, "sdk/python/src/next_loggers/context.py")
    require("copy.deepcopy" in python_context, "Python contextvars snapshot lost deepcopy isolation")

    test_corpus = "\n".join(
        path.read_text(encoding="utf-8", errors="replace")
        for path in root.glob("**/*test*")
        if path.is_file() and path.stat().st_size < 1_000_000
    ).lower()
    for term in ("nested", "mutation", "fiber", "concurrent", "restor"):
        require(term in test_corpus, f"source test corpus lacks the required adversarial term: {term}")

    print(
        json.dumps(
            {
                "schema": "ores-otel-test/async-context-architecture-audit/v1",
                "sourceSha": head,
                "baselineSha": manifest["baseline_sha"],
                "languages": ["typescript", "python", "go", "java", "ruby"],
                "checks": {
                    "recursiveSnapshots": True,
                    "fiberIsolation": True,
                    "threadLocalBoundary": True,
                    "sourceClean": True,
                    "adversarialCorpus": True,
                },
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
