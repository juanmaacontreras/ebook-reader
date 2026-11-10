"""Stdlib-only tests of the chunk verdict (worker/qc.py)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.qc import Word, judge, only_outside  # noqa: E402

FRAME = 0.02


def said(words, start=0.2, each=0.3):
    return [Word(w, start + k * each, start + k * each + 0.25) for k, w in enumerate(words)]


def sound(duration, silent=()):
    """Voiced everywhere except the (from, to) stretches given."""
    n = int(duration / FRAME)
    return [not any(a <= k * FRAME < b for a, b in silent) for k in range(n)]


TEXT = "la relacion senal a ruido mejora al aumentar beta a costa de mas ancho de banda".split()


class Judge(unittest.TestCase):
    def test_a_clean_chunk_passes(self):
        heard = said(TEXT)
        v = judge(TEXT, heard, sound(heard[-1].end + 0.1), FRAME)
        self.assertTrue(v.ok, v.issues)
        self.assertEqual(v.score, 1.0)

    def test_babbled_words_at_the_end_fail_though_the_old_score_would_pass(self):
        heard = said(TEXT + ["mmm", "na", "na", "eh"])
        v = judge(TEXT, heard, sound(heard[-1].end + 0.1), FRAME)
        self.assertGreater(v.score, 0.80)  # the old threshold let it through
        self.assertIn("4 words after the text", v.issues)
        self.assertTrue(only_outside(v))
        self.assertAlmostEqual(v.speech[1], said(TEXT)[-1].end)  # cut right after the last real word

    def test_sound_after_the_last_word_that_whisper_wrote_as_nothing(self):
        heard = said(TEXT)
        v = judge(TEXT, heard, sound(heard[-1].end + 2.0), FRAME)
        self.assertEqual(v.score, 1.0)
        self.assertTrue(any("after the last word" in i for i in v.issues), v.issues)
        self.assertTrue(only_outside(v))

    def test_trailing_silence_is_not_babbling(self):
        heard = said(TEXT)
        end = heard[-1].end
        v = judge(TEXT, heard, sound(end + 2.0, silent=[(end + 0.1, end + 2.0)]), FRAME)
        self.assertTrue(v.ok, v.issues)

    def test_sound_between_two_words_with_nothing_recognised(self):
        heard = said(TEXT[:6]) + said(TEXT[6:], start=5.0)
        v = judge(TEXT, heard, sound(heard[-1].end + 0.1), FRAME)
        self.assertTrue(any("between two words" in i for i in v.issues), v.issues)
        self.assertFalse(only_outside(v))  # cutting the ends doesn't fix the middle

    def test_a_pause_between_sentences_is_fine(self):
        heard = said(TEXT[:6]) + said(TEXT[6:], start=3.0)
        gap = (heard[5].end + 0.05, 3.0)
        v = judge(TEXT, heard, sound(heard[-1].end + 0.1, silent=[gap]), FRAME)
        self.assertTrue(v.ok, v.issues)

    def test_a_word_said_over_and_over(self):
        heard = said(TEXT[:5] + ["ruido", "ruido", "ruido"] + TEXT[5:])
        v = judge(TEXT, heard, sound(heard[-1].end + 0.1), FRAME)
        self.assertIn("a word repeated", v.issues)

    def test_a_misheard_last_word_is_not_extra_speech(self):
        heard = said(TEXT[:-1] + ["vanda"])
        v = judge(TEXT, heard, sound(heard[-1].end + 0.1), FRAME)
        self.assertTrue(v.ok, v.issues)

    def test_skipped_text_fails_on_the_words(self):
        heard = said(TEXT[:7])
        v = judge(TEXT, heard, sound(heard[-1].end + 0.1), FRAME)
        self.assertTrue(any(i.startswith("words") for i in v.issues), v.issues)
        self.assertFalse(only_outside(v))


if __name__ == "__main__":
    unittest.main()
