# Ideas

Brainstorm of 2026-11-03: the user asked for everything Atril could do, whatever
the effort. **Not planned work.** Build one only when the user asks for it, and
check it against the user decisions in `CLAUDE.md` first. Ideas whose content
comes from resumidor (study books, audiobooks, flashcards) have their resumidor
side in `resumidor/IDEAS.md`.

Effort: **quick** = most pieces exist · **project** = days to weeks ·
**research** = reverse engineering or unknowns, may not work.

## Studying

- **Resumidor books in one step** (quick). On 2026-11-03 it took: resumidor's
  `epub.py` → the user imports the EPUB in the desktop app (the manifest is built
  client-side) → stop the worker → `import_audio.py attach` → start it again.
  Missing on Atril's side: a headless import (build `text.json.gz` with
  `book/sentences.ts` outside the app; the vitest tests already run it under
  jsdom), and **replacing a book's EPUB in place** (a corrected unit) keeping
  position and highlights, remapped by sentence text; then re-attach only the
  chapters whose audio changed.
- **Lecture recordings as books** (quick). A class recorded on the phone →
  Whisper → an EPUB whose text is the transcript, with that same audio attached
  as `import_audio.py` does (the text *is* the transcript, so alignment is
  exact). Searchable, with read-along. Whisper invents text over silence and
  noise: low-confidence stretches are marked, never smoothed over. Recording
  needs the teacher's OK. The transcript can also feed resumidor's ingesta.
- **Coverage map** (quick). Per section: read or listened, how many times, when
  last. Builds on `reading_sessions` (listening may need its own record). For a
  resumidor book a section is a unit ("H10 never heard in full"). A hint only:
  what counts in resumidor is passing a route's gates, not time spent.
- **Scanned PDFs and photos as books** (project). The whole text, not a summary
  (that is resumidor's job): OCR or a vision model, figures kept as images,
  narration on request. Was out of scope ("non-EPUB formats"). Same rule as
  resumidor's ingesta: never guess silently, mark doubtful text.
- **Oral exam drill** (project). At a chapter's end the narrator asks, the user
  answers aloud, the PC transcribes and grades against the text, with a jump to
  the sentence to reread. Questions from resumidor's question bank when the book
  comes from there, else generated. Same queue pattern as narration.
- **Flashcards from highlights** (project). Resumidor's study surface for cards
  is the Obsidian vault note with the Spaced Repetition plugin (Anki was
  rejected: never propose it), so highlights become cards *in that note*, not a
  second scheduler here. A "Repaso del día" EPUB with the cards due, delivered
  to the Kobo each morning, is possible read-only (grading stays in the vault).
- **Formulas, units and abbreviations read right** (project). Normalize text
  before TTS: "dB(A)" → "decibeles A", "∫₀^∞" → "integral de cero a infinito",
  numbers, MathML, a per-book pronunciation lexicon. Rules first, a small model
  only where rules can't decide. Resumidor books don't need it: their narration
  script already says each formula.
- **Interactive figures** (research). EPUB3 scripted content, e.g. R, L, C
  sliders moving a Bode plot inside a Circuitos II chapter. Running book scripts
  safely is the hard part: foliate-js iframes must allow scripts (WebKit bug,
  see its README), so the protection lives elsewhere and must be checked first.
  Authoring would be resumidor's (figures as text, same source as its TikZ).

## AI inside Atril (local, on the PC)

Same pattern as narration: a device writes a request, the PC worker answers.
Limits: the GTX 1650 has 4 GB and the TTS uses it, so small models (3–4 B,
quantized) or the CPU, preferably while narration is idle. Small models make
things up more: every answer cites the sentences it used, with a jump to them,
so a mistake is visible. Free only; a free-tier API only if the user agrees.

- **Ask the book** (project): "¿qué era el TLV?" answered from the book's
  sentences (the manifest gives retrieval units with CFIs), never past the
  reader's position.
- **"Previamente en…"** (project): a 30-second recap of the last session when a
  book is reopened after days, also as audio.
- **X-Ray** (project): characters, places and terms, up to the current position.
- **Semantic search across the library** (project): "¿dónde leí sobre ruido de
  impacto?" (paragraph embeddings; a small embedding model runs on the CPU).
- **Multi-voice novels** (project): who says each line, one voice per character.
- **Bilingual mode** (project): each sentence of an English book followed by its
  Spanish translation, in text and audio.

## Audio

- **Word-level read-along** (quick): Whisper gives word timings; `timings` would
  gain a per-word array.
- **Sleep timer** (quick, already in Phase 2), plus a mark where the user fell
  asleep (the last interaction).
- **The user's own voice**, or a consenting person's (project): XTTS clones a
  voice from seconds of audio (resumidor uses it). Not an Atril engine
  (2026-10-21 decision): a new engine, or audio brought in with `import_audio.py`.
- **Offline narration on the phone** (project): a small TTS model on Android for
  books not generated yet.
- **Android Auto** (project): the narration in the car, with chapters (a Media3
  library service next to `PlaybackService`).
- **Headphone gestures and voice commands** (project): double tap repeats the
  last sentence; "volvé al principio del capítulo".
- **A real Rioplatense voice** (research): fine-tune a TTS model on Argentine
  Spanish audio, voseo included.

## Kobo

Rules that still hold: never write `KoboReader.sqlite`; explain an on-device
add-on and how to remove it before installing it; Atril → Kobo highlights are
not wanted.

- **Kobo → Atril highlights** (research, already open in Phase 2): through
  Kobo's cloud if the device sends them there (unconfirmed), else reading its
  database over USB.
- **Own home screen sections** (research): the store sections answered with
  `{}` today could carry "Para el parcial" or "Seguí leyendo".
- **Own dictionary** (project): Kobo firmware takes custom dictionaries (to
  confirm on 4.45); one built from resumidor's terms, so tapping "TLV" shows the
  summary's definition. By USB (a dictionary file, not the database) or over
  the air if the protocol allows (unknown).
- **Morning digest** (project): RSS, saved articles and new campus posts
  (resumidor's aula virtual) as an EPUB in the library each morning, narration
  on request. A new book reaches the Kobo only on a sync (manual or its
  automatic schedule).
- **A page for the Kobo's experimental browser** (project): ask the book, review
  cards, see stats, without touching the firmware (check the browser is still in
  its beta features).
- **"Escuchar desde acá" in the Kobo's menu** (research): NickelMenu (a
  removable add-on) sends the Kobo's current sentence, so the phone starts the
  audio there at once instead of after the Kobo's ~1 min report.
- **The Kobo follows the audio** (research, hard): pages turn on the e-ink while
  the user listens on the phone; needs hooking the Kobo's reader (NickelDBus or
  a native plugin).
- **Audio on the Kobo** (research, very uncertain): the Clara BW plays Kobo
  audiobooks over Bluetooth; serving Atril's narration as one needs their
  audiobook format, unknown.
- **KOReader beside the stock reader** (research): full control, most of the
  above becomes plain code, for a plainer UI (option 2 of the 2026-10-27
  ranking in `CLAUDE.md`).

## More places and people

- **"Compartir → Atril"** (quick): an Android share target; a web article or any
  file becomes a book, on the Kobo too, narration on request.
- **Year in review** (quick): hours, books, streaks, time of day, from
  `reading_sessions`.
- **Home screen widget** (project): current book, progress, play.
- **Web version** (project): read from any computer (the university's).
- **Resumidor books for classmates** (project): a public link to a web reader
  with text and audio. The free tier's 5 GB/month egress limits it to a few
  people.
- **Reading club** (project; social was out of scope): comments anchored to a
  sentence, shown to each member only once they reach it.
- **Public-domain catalog** (project): Gutenberg, Standard Ebooks, Wikisource
  in Spanish, imported with one tap; narration still only on request
  (2026-10-28 decision).
- **E-ink mode** (project): if the user gets an Android e-ink reader (Boox),
  Atril itself becomes the e-reader, audio included.
