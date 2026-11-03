// Reading places compared across devices: spine order, then sentence. The
// reader decides with these which of its moves move the shared place (see
// CLAUDE.md, "Who moves the shared place"); the Kobo function applies the same
// rule (supabase/functions/kobo/logic.ts, takesPlace).

export interface Place { section: number; sentence: number }
export type MaybePlace = { section: number | null; sentence: number | null } | null

/** Whether a place is past another one in the book. Past an unknown one: yes. */
export function isAhead(a: Place, b: MaybePlace): boolean {
  if (!b || b.section === null || b.sentence === null) return true
  return a.section > b.section || (a.section === b.section && a.sentence > b.sentence)
}

/** Whether another device's newer place leaves this one behind: progress made
 *  there that this device missed (their place is past this one). A place
 *  behind this one is a move back made there: nothing was missed, and moves
 *  here keep counting, back past it too. */
export function leftBehind(theirs: MaybePlace, here: MaybePlace): boolean {
  if (!theirs || theirs.section === null || theirs.sentence === null) return true
  return isAhead({ section: theirs.section, sentence: theirs.sentence }, here)
}
