import { supabase } from '../data/supabase'
import { db } from '../data/db'
import { stopRealtime } from '../data/sync'
import { applyUiTheme } from '../platform/theme'
import { APP_VERSION } from '../config'
import { prefs, setPrefs, type UiTheme } from '../settings'
import { APP_NAME, t } from '../strings'
import { openDialog, segmented } from '../ui/dialog'
import { h } from '../ui/dom'
import { icon } from '../ui/icons'
import { checkForUpdate } from '../platform/updater'
import { autoNarrateAll, workerStatus } from '../data/store'

const mb = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(bytes / 1e6)} MB`

export function openSettings(): void {
  openDialog(t.settings, async (body, close) => {
    const { data } = await supabase.auth.getUser()
    const storageRow = h('div.setrow', h('span.lbl', t.storage), h('span.val', '…'))
    body.append(
      h('label.flabel', t.appearance),
      segmented<UiTheme>([['system', t.appearanceSystem], ['light', t.themeLight], ['dark', t.themeDark]], prefs().uiTheme,
        v => void setPrefs({ uiTheme: v }).then(applyUiTheme)),
      h('label.setrow', h('span.lbl', t.autoNarrate, h('small', { style: 'display:block;font-weight:500;color:var(--muted);font-size:12.5px;margin-top:2px' }, t.autoNarrateHint)),
        h('input', { type: 'checkbox', checked: prefs().autoNarrate, onchange: (e: Event) => {
          const on = (e.target as HTMLInputElement).checked
          void setPrefs({ autoNarrate: on }).then(() => { if (on) void autoNarrateAll() })
        } })),
      h('label.flabel', t.account),
      h('div.setrow', icon('user'), h('span.lbl', data.user?.email ?? ''),
        h('button.btn.small.ghost', { onclick: async () => { await stopRealtime(); await supabase.auth.signOut(); close(); location.reload() } }, t.signOut)),
      storageRow,
      h('div.setrow', icon('update'), h('span.lbl', t.version(APP_VERSION)),
        h('button.btn.small.ghost', { onclick: () => { close(); void checkForUpdate(true) } }, t.updateNow)),
      h('p.muted', { style: 'font-size:12.5px;margin-top:12px' }, APP_NAME),
    )
    // Cloud usage: EPUBs from the books table + audio as reported by the worker.
    const books = await db.all<{ size_bytes: number | null }>('books')
    const epubBytes = books.reduce((a, b) => a + (b.size_bytes ?? 0), 0)
    const ws = await workerStatus().catch(() => null)
    const est = await navigator.storage?.estimate?.().catch(() => null)
    storageRow.lastChild!.textContent = `${t.cloudStorage(mb(epubBytes + (ws?.audio_bytes ?? 0)), '1 GB')} · ${t.localStorage(mb(est?.usage ?? 0))}`
  })
}
