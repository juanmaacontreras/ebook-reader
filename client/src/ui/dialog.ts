import { h } from './dom'
import { t } from '../strings'

export interface DialogHandle { el: HTMLElement; body: HTMLElement; close: () => void; closed: Promise<void> }

// Centered dialog on wide screens, bottom sheet on phones (CSS decides).
export function openDialog(title: string | null, build: (body: HTMLElement, close: () => void) => void, opts: { wide?: boolean } = {}): DialogHandle {
  let resolve!: () => void
  const closed = new Promise<void>(r => (resolve = r))
  const body = h('div.dialog' + (opts.wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' })
  const overlay = h('div.overlay', body)
  const close = () => {
    if (!overlay.isConnected) return
    overlay.remove()
    document.removeEventListener('keydown', onKey)
    resolve()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  overlay.addEventListener('click', e => { if (e.target === overlay) close() })
  document.addEventListener('keydown', onKey)
  if (title) body.append(h('h3', title))
  build(body, close)
  document.body.append(overlay)
  return { el: overlay, body, close, closed }
}

export function confirmDialog(title: string, message: string, okLabel: string, danger = false): Promise<boolean> {
  return new Promise(resolve => {
    let answered = false
    const d = openDialog(title, (body, close) => {
      body.append(
        h('p', message),
        h('div.dbtns',
          h('button.btn.ghost.small', { onclick: () => close() }, t.cancel),
          h('button.btn.small' + (danger ? '.danger' : '.primary'), { onclick: () => { answered = true; close() } }, okLabel)),
      )
    })
    d.closed.then(() => resolve(answered))
  })
}

let toastTimer: number | undefined
export function toast(message: string, action?: { label: string; run: () => void }, ms = 3500): void {
  document.querySelector('.toast')?.remove()
  clearTimeout(toastTimer)
  const el = h('div.toast', { role: 'status' }, h('span', message))
  if (action) el.append(h('button', { onclick: () => { el.remove(); action.run() } }, action.label))
  document.body.append(el)
  toastTimer = window.setTimeout(() => el.remove(), action ? ms * 2 : ms)
}

export function segmented<T extends string>(options: [T, string][], value: T, onChange: (v: T) => void, cls = ''): HTMLElement {
  const el = h('div.seg' + (cls ? '.' + cls : ''), { role: 'tablist' })
  const render = (v: T) => {
    el.replaceChildren(...options.map(([key, label]) =>
      h('button.s' + (key === v ? '.active' : ''), { role: 'tab', 'aria-selected': String(key === v), onclick: () => { render(key); onChange(key) } }, label)))
  }
  render(value)
  return el
}
