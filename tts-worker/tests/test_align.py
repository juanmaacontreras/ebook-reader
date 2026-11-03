"""Stdlib-only tests: aligning manifest sentences with an external narration's words."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.align import likeness, norm_words, sentence_times  # noqa: E402


def words(text: str, start: float = 0.0, step: float = 0.4):
    out, t = [], start
    for w in norm_words(text):
        out.append((w, round(t, 3), round(t + step * 0.8, 3)))
        t += step
    return out


class AlignTests(unittest.TestCase):
    def test_exact_transcript_gives_word_times(self):
        sents = ["La toxicología estudia los tóxicos.", "Un tóxico produce daño.", "Fin del capítulo."]
        heard = words(" ".join(sents))
        times, matched = sentence_times(sents, heard, duration=6.0)
        self.assertEqual(matched, 1.0)
        self.assertEqual(times[0][0], 0.0)
        self.assertAlmostEqual(times[1][0], 5 * 0.4, places=3)   # "un" is the 6th word
        self.assertAlmostEqual(times[2][0], 9 * 0.4, places=3)
        for (s, e), (s2, _) in zip(times, times[1:]):
            self.assertLessEqual(s, e)
            self.assertLessEqual(e, s2)

    def test_unheard_heading_and_numbers_are_interpolated(self):
        # A heading the audio never says, and digits where the text has words.
        sents = ["SeH6 · Toxicología", "Salió en dos mil veintiséis.", "Después vino otra cosa importante."]
        heard = words("salió en 2026 después vino otra cosa importante", start=1.0)
        times, _ = sentence_times(sents, heard, duration=5.0)
        self.assertEqual(times[0][0], 0.0)
        self.assertAlmostEqual(times[1][0], 1.0, places=3)
        self.assertGreater(times[2][0], times[1][0])
        self.assertLessEqual(times[-1][1], 5.0)

    def test_never_goes_backwards(self):
        sents = ["uno dos tres.", "cuatro cinco.", "seis siete ocho."]
        heard = words("seis siete ocho uno dos tres cuatro cinco")  # scrambled
        times, _ = sentence_times(sents, heard, duration=4.0)
        starts = [s for s, _ in times]
        self.assertEqual(starts, sorted(starts))

    def test_likeness_tells_chapters_apart(self):
        a = ["La ventilación localizada capta el contaminante en la fuente."] * 3
        b = ["El ruido se mide en decibeles con un sonómetro integrador."] * 3
        heard = words(" ".join(a))
        self.assertGreater(likeness(a, heard), 0.9)
        self.assertLess(likeness(b, heard), 0.5)


if __name__ == "__main__":
    unittest.main()
