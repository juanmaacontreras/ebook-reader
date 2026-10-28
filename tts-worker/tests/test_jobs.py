"""Stdlib-only tests for job selection and time estimates."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.jobs import Speed, job_sections, runnable  # noqa: E402

SECTIONS = [{"i": i, "sentences": [{"t": "Hola."}] if i != 2 else []} for i in range(8)]


def ids(n):
    return [s["i"] for s in job_sections(SECTIONS, n)]


class JobTests(unittest.TestCase):
    def test_scopes_count_from_start_and_skip_empty(self):
        self.assertEqual(ids({"scope": "chapter", "start_section": 3}), [3])
        self.assertEqual(ids({"scope": "next", "start_section": 1}), [1, 3, 4])
        self.assertEqual(ids({"scope": "all", "start_section": 6}), [6, 7, 0, 1, 3, 4, 5])
        self.assertEqual(ids({"scope": "chapter", "start_section": 2}), [3])

    def test_priority_only_inside_the_job(self):
        self.assertEqual(ids({"scope": "next", "start_section": 3, "priority_section": 5}), [5, 3, 4])
        self.assertEqual(ids({"scope": "next", "start_section": 3, "priority_section": 7}), [3, 4, 5])

    def test_runnable(self):
        base = {"status": "active", "scope": "all", "started_at": "2026-10-28T10:00:00.000Z"}
        self.assertTrue(runnable(base))
        self.assertFalse(runnable({**base, "status": "paused"}))
        self.assertFalse(runnable({**base, "scope": "ahead"}))
        self.assertFalse(runnable({**base, "started_at": None}))
        self.assertFalse(runnable({**base, "stopped_at": "2026-10-28T10:05:00+00:00"}))
        self.assertTrue(runnable({**base, "stopped_at": "2026-10-28T09:05:00.123456+00:00"}))

    def test_speed_learns_and_persists(self):
        with tempfile.TemporaryDirectory() as d:
            sp = Speed(Path(d) / "speed.json")
            self.assertEqual(sp.eta("kokoro", 10000), 30)
            sp.record("kokoro", 10000, 50)
            self.assertAlmostEqual(Speed(Path(d) / "speed.json").rate("kokoro"), 0.005)


if __name__ == "__main__":
    unittest.main()
