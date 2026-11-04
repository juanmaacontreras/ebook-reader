# Design

> Moved verbatim from `CLAUDE.md` on 2026-11-04. The index that says when to read this file is `CLAUDE.md`.

## Design

Same family as Bitácora (time-tracker/web/index.html). Tokens in
`client/src/styles/tokens.css`: Nord light "Snow Storm" / dark "Polar Night",
system + manual override (`data-theme` on `<html>`), soft tints via
`color-mix` (accent ~13% over card), radii 22/16/12 px, dialogs 28 px,
borderless surfaces (paper < card, surface2 for tracks/fields), segmented
controls with a raised active option, system font 15 px, 800-weight titles
with negative letter-spacing, tabular numerals for times, rounded minimal
icons (`ui/icons.ts`), system bars = paper color. Dialogs are centered on wide
screens and bottom sheets on phones. The reading surface has its own themes
(light / sepia / dark / auto) in `book/bookStyles.ts`. Highlight colors:
`--hl-*` (yellow, green, blue, orange, purple), keys stored in the DB.
