# Phase 2 and beyond

> Moved verbatim from `CLAUDE.md` on 2026-11-04. The index that says when to read this file is `CLAUDE.md`.

## Phase 2 (designed for, not built)

Tap a word → offline dictionary + vocabulary list (the reader already maps
taps to text positions; foliate-js has `dict.js` for StarDict/dictd);
export highlights/vocabulary to Markdown/PDF/flashcards (highlights carry text,
chapter, note, CFI); sleep timer (end of chapter = the controller's `track`
event; X minutes = timer + pause); reading stats (positions already log
device + time; add a sessions table); bookmarks (same shape as highlights with
a kind); full-text search (foliate-js `search.js` via `view.search()`); Kobo
highlights (their location is our koboSpan ids, so they map to sentences
directly; see the 2026-11-02 decision for how to receive them). Out of scope: store, social, non-EPUB formats.

Beyond Phase 2: `IDEAS.md`, a brainstorm of 2026-11-03 (everything possible,
any effort). Not planned: build an idea only when the user asks for it.
