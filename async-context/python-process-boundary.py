#!/usr/bin/env python3
"""Prove that process boundaries require explicit context carriers."""
from __future__ import annotations

import multiprocessing
import sys
from pathlib import Path
from queue import Empty
from typing import Any


def child_probe(source_root: str, carrier: dict[str, Any] | None, queue: Any) -> None:
    sys.path.insert(0, str(Path(source_root, "sdk", "python", "src")))
    from next_loggers.context import LogContext, get_log_context, log_context

    before = get_log_context().trace_id
    if carrier is None:
        inside = get_log_context().trace_id
        nested_tenant = None
    else:
        context = LogContext(**carrier)
        with log_context(context):
            carrier["fields"]["tenant"]["id"] = "child-mutated-carrier"
            inside = get_log_context().trace_id
            nested_tenant = get_log_context().fields["tenant"]["id"]
    after = get_log_context().trace_id
    queue.put(
        {
            "before": before,
            "inside": inside,
            "nested_tenant": nested_tenant,
            "after": after,
        }
    )


def run_child(source_root: str, carrier: dict[str, Any] | None) -> dict[str, Any]:
    context = multiprocessing.get_context("spawn")
    queue = context.Queue()
    process = context.Process(target=child_probe, args=(source_root, carrier, queue))
    process.start()
    process.join(30)
    if process.is_alive():
        process.terminate()
        process.join(5)
        raise AssertionError("spawned context probe did not terminate")
    if process.exitcode != 0:
        raise AssertionError(f"spawned context probe exited with {process.exitcode}")
    try:
        return queue.get(timeout=5)
    except Empty as error:
        raise AssertionError("spawned context probe returned no evidence") from error


def main() -> None:
    source_root = str(Path(sys.argv[1] if len(sys.argv) > 1 else "source").resolve())
    sys.path.insert(0, str(Path(source_root, "sdk", "python", "src")))
    from next_loggers.context import LogContext, get_log_context, log_context

    absent = run_child(source_root, None)
    assert absent == {
        "before": "",
        "inside": "",
        "nested_tenant": None,
        "after": "",
    }, absent

    carrier: dict[str, Any] = {
        "trace_id": "trace-process",
        "trace_flags": 0,
        "trace_flags_set": True,
        "fields": {"tenant": {"id": "tenant-process"}},
    }
    with log_context(LogContext(**carrier)):
        explicit = run_child(source_root, carrier)
        assert get_log_context().trace_id == "trace-process"
        assert get_log_context().fields["tenant"]["id"] == "tenant-process"

    assert explicit == {
        "before": "",
        "inside": "trace-process",
        "nested_tenant": "tenant-process",
        "after": "",
    }, explicit
    assert carrier["fields"]["tenant"]["id"] == "tenant-process"
    assert get_log_context().trace_id == ""
    print("spawn-process explicit context boundary passed")


if __name__ == "__main__":
    main()
