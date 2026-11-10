import type { TocItem, View } from 'foliate-js/view.js'
import type { NarrationController } from '../audio/controller'
import { t } from '../strings'
import { openDialog } from '../ui/dialog'
import { h } from '../ui/dom'
import { icon } from '../ui/icons'

export function openToc(view: View, narr: NarrationController | null, current: string, go: (href: string) => void): void {
  openDialog(t.contents, (body, close) => {
    const list = h('div.panel-list')
    let curEl: HTMLElement | null = null
    const walk = (items: TocItem[] | undefined, level: number) => {
      for (const item of items ?? []) {
        const idx = item.href ? view.book.resolveHref(item.href)?.index : undefined
        const hasAudio = idx != null && narr?.hasChapter(idx)
        const el = h('button.tocitem' + (level ? `.l${Math.min(level, 2)}` : '') + (item.label === current ? '.cur' : ''),
          { onclick: () => { close(); go(item.href) } },
          hasAudio ? h('span.aud', { title: t.hasAudio }, icon('headphones')) : null,
          item.label)
        if (item.label === current) curEl = el
        list.append(el)
        walk(item.subitems, level + 1)
      }
    }
    walk(view.book.toc, 0)
    body.append(list)
    setTimeout(() => (curEl as HTMLElement | null)?.scrollIntoView({ block: 'center' }), 30)
  }, { wide: true })
}
