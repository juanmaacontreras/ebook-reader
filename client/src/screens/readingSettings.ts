import { prefs, setPrefs, type BookFont, type BookTheme, type Flow, type Margins, type Spacing } from '../settings'
import { t } from '../strings'
import { openDialog, segmented } from '../ui/dialog'
import { h } from '../ui/dom'

export function openReadingSettings(): void {
  openDialog(t.readingSettings, body => {
    const p = prefs()
    const size = h('input', { type: 'range', min: '14', max: '30', step: '1', value: String(p.fontSize), 'aria-label': t.fontSize }) as HTMLInputElement
    const sizeVal = h('span.num.val', `${p.fontSize}`)
    size.oninput = () => { sizeVal.textContent = size.value; void setPrefs({ fontSize: Number(size.value) }) }
    const justify = h('input', { type: 'checkbox', checked: p.justify, onchange: () => void setPrefs({ justify: justify.checked }) }) as HTMLInputElement
    body.append(
      h('label.flabel', t.theme),
      segmented<BookTheme>([['auto', t.themeAuto], ['light', t.themeLight], ['sepia', t.themeSepia], ['dark', t.themeDark]], p.bookTheme, v => void setPrefs({ bookTheme: v })),
      h('label.flabel', t.font),
      segmented<BookFont>([['book', t.fontBook], ['serif', t.fontSerif], ['sans', t.fontSans]], p.font, v => void setPrefs({ font: v })),
      h('label.flabel', t.fontSize),
      h('div.sizes', h('span.a', { style: 'font-size:13px' }, 'A'), size, h('span.a', { style: 'font-size:20px' }, 'A'), sizeVal),
      h('label.flabel', t.margins),
      segmented<Margins>([['s', t.marginsS], ['m', t.marginsM], ['l', t.marginsL]], p.margins, v => void setPrefs({ margins: v })),
      h('label.flabel', t.lineSpacing),
      segmented<Spacing>([['tight', t.spacingTight], ['normal', t.spacingNormal], ['loose', t.spacingLoose]], p.spacing, v => void setPrefs({ spacing: v })),
      h('label.flabel', t.layout),
      segmented<Flow>([['paginated', t.layoutPaged], ['scrolled', t.layoutScroll]], p.flow, v => void setPrefs({ flow: v })),
      h('label.setrow', h('span.lbl', t.justify), justify),
    )
  })
}
