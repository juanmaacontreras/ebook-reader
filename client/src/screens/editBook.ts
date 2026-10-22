import { books } from '../data/store'
import type { Book } from '../data/types'
import { t } from '../strings'
import { openDialog } from '../ui/dialog'
import { h } from '../ui/dom'

export function editBook(b: Book): void {
  openDialog(t.editBook, (body, close) => {
    const title = h('input.field', { value: b.title, placeholder: t.title, 'aria-label': t.title })
    const author = h('input.field', { value: b.author ?? '', placeholder: t.author, 'aria-label': t.author })
    const save = async () => {
      const name = title.value.trim()
      if (!name) { title.focus(); return }
      await books.edit(b.id, { title: name, author: author.value.trim() || null })
      close()
    }
    body.append(
      h('label.flabel', t.title), title,
      h('label.flabel', t.author), author,
      h('div.dbtns',
        h('button.btn.small.ghost', { onclick: () => close() }, t.cancel),
        h('button.btn.small.primary', { onclick: () => void save() }, t.save)))
    title.addEventListener('keydown', e => { if (e.key === 'Enter') void save() })
    setTimeout(() => title.focus(), 50)
  })
}
