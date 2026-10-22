"""Stdlib-only tests (CI runs them without torch): text cleanup, splitting and chunking."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from worker.text import clean, group_chunks, split_long, to_pieces  # noqa: E402


class TextTests(unittest.TestCase):
    def test_clean_dialogue_and_notes(self):
        self.assertEqual(clean("—¿Vos venís? —preguntó."), "¿Vos venís?, preguntó.")
        self.assertEqual(clean("contar[12], dijo"), "contar, dijo")
        self.assertEqual(clean("«Hola»…  mundo"), '"Hola"... mundo')

    def test_split_long_prefers_clause_breaks(self):
        s = "Una oración bastante larga que sigue y sigue, con una coma en el medio que conviene usar, y otra parte más."
        parts = split_long(s, 60)
        self.assertTrue(all(len(p) <= 60 for p in parts))
        self.assertEqual(" ".join(parts).replace("  ", " "), s)
        self.assertTrue(parts[0].endswith(","))

    def test_pieces_keep_sentence_index_and_skip_empty(self):
        pieces = to_pieces(["Hola.", "—", "Chau."], 100)
        self.assertEqual([(p.sentence, p.text) for p in pieces], [(0, "Hola."), (2, "Chau.")])

    def test_chunks_cover_everything_in_order(self):
        sentences = [f"Oración número {i} con algunas palabras más." for i in range(30)]
        chunks = group_chunks(to_pieces(sentences, 260), target=190, max_chars=260)
        flat = [p.sentence for c in chunks for p in c.pieces]
        self.assertEqual(flat, list(range(30)))
        self.assertTrue(all(len(c.text) <= 260 for c in chunks))
        self.assertTrue(all(len(c.text) >= 80 for c in chunks[:-1]))

    def test_short_sentences_are_merged(self):
        chunks = group_chunks(to_pieces(["Sí.", "No.", "Tal vez.", "Una oración un poco más larga para cerrar el grupo."], 260), 190, 260)
        self.assertEqual(len(chunks), 1)


if __name__ == "__main__":
    unittest.main()
