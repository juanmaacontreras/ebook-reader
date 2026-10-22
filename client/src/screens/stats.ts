// "Resumen": reading and listening stats, from the synced reading sessions
// (data/sessions.ts) — time per period, a year calendar, finished books, pace,
// time left per book, when and on what device, and a line per book.

import { local } from '../data/files'
import { dayKey, fmtDate, loadStats, periodBuckets, periodTotals, setGoal, splitTotal, type Bucket, type Period, type Stats } from '../data/stats'
import type { Book, DeviceKind } from '../data/types'
import { onChange } from '../data/sync'
import { t } from '../strings'
import { openDialog, segmented } from '../ui/dialog'
import { clear, h } from '../ui/dom'
import { icon } from '../ui/icons'

const PERIODS: [Period, string][] = [['week', t.periodWeek], ['month', t.periodMonth], ['year', t.periodYear]]
const NOW_LABEL: Record<Period, string> = { week: t.thisWeek, month: t.thisMonth, year: t.thisYear }
const VS_LABEL: Record<Period, string> = { week: t.vsWeek, month: t.vsMonth, year: t.vsYear }
const DEVICE_LABEL: Record<DeviceKind, string> = { phone: t.devicePhone, tablet: t.deviceTablet, pc: t.devicePc }
const rateLabel = (r: number) => `${String(r).replace('.', ',')}×`

export function statsScreen(root: HTMLElement, openBook: (id: string) => void, goBack: () => void): () => void {
  const body = h('div.stats-body')
  root.replaceChildren(h('div.wrap.stats',
    h('div.hd',
      h('button.iconbtn', { 'aria-label': t.back, onclick: () => goBack() }, icon('back')),
      h('div', h('div.title', t.stats)),
      h('div.spacer')),
    body))

  let period: Period = 'week'

  async function render() {
    const st = await loadStats()
    if (st.empty) { clear(body, h('div.empty', h('b', t.statsEmpty), t.statsEmptyHint)); return }
    const rerender = () => void render()

    // ---- Cards ---------------------------------------------------------------
    const delta = (p: Period) => {
      const { now, before } = periodTotals(st, p)
      const d = splitTotal(now) - splitTotal(before)
      const txt = Math.abs(d) < 60 ? t.same : d > 0 ? t.moreTime(t.dur(d)) : t.lessTime(t.dur(-d))
      return h('div.delta' + (d >= 60 ? '.up' : ''), `${txt} ${Math.abs(d) < 60 ? '' : VS_LABEL[p]}`.trim())
    }
    const split = (p: Period) => {
      const { now } = periodTotals(st, p)
      return h('div.split',
        h('span', h('i.sw.read'), `${t.readLabel} ${t.dur(now.read)}`),
        h('span', h('i.sw.listen'), `${t.listenLabel} ${t.dur(now.listen)}`))
    }
    const timeCard = () => {
      const { now } = periodTotals(st, period)
      return h('div.card.scard.span2',
        segmented(PERIODS, period, v => { period = v; rerender() }, 'small'),
        h('div.eyebrow', NOW_LABEL[period]),
        h('div.hero.num', t.dur(splitTotal(now))),
        delta(period),
        split(period),
        bars(periodBuckets(st, period)))
    }
    const cards = {
      calendar: () => h('div.card.scard.span2', h('div.cardhd', h('b', t.calendar)), calendar(st)),
      finished: () => {
        const year = new Date().getFullYear()
        const n = st.finished.length
        return h('div.card.scard',
          h('div.cardhd', h('b', t.finishedBooks), h('button.linkbtn', { onclick: () => goalDialog(st.goal, rerender) }, st.goal ? t.goalOf(st.goal) : t.setGoal)),
          h('div.big.num', t.finishedCount(n, year)),
          st.goal ? h('div.track', h('div.fill', { style: `width:${Math.min(100, Math.round(100 * n / st.goal))}%` })) : null,
          n ? h('div.covers', st.finished.slice(0, 12).map(b => cover(b, () => openBook(b.id)))) : null)
      },
      pace: () => h('div.card.scard',
        h('div.cardhd', h('b', t.pace)),
        h('div.pace',
          h('div', h('i.sw.read'), h('div', h('span', t.readingPace), h('b', st.pace.read ? t.wpm(st.pace.read) : t.notEnough))),
          h('div', h('i.sw.listen'), h('div', h('span', t.listeningPace), h('b', st.pace.listen ? t.wpm(st.pace.listen) : t.notEnough),
            h('small', t.atRate(rateLabel(st.rate))))))),
      left: () => st.left.length ? h('div.card.scard',
        h('div.cardhd', h('b', t.timeLeft)),
        st.left.map(x => h('div.lrow', { onclick: () => openBook(x.book.id) },
          cover(x.book), h('div.mid', h('div.bt', x.book.title),
            h('div.ba', [x.read ? t.leftRead(t.dur(x.read)) : null, x.listen ? t.leftListen(t.dur(x.listen)) : null].filter(Boolean).join(' · ') || t.notEnough))))) : null,
      when: () => h('div.card.scard', h('div.cardhd', h('b', t.whenTitle)), hoursChart(st.hours)),
      devices: () => {
        const sum = st.devices.reduce((a, [, s]) => a + s, 0) || 1
        return h('div.card.scard', h('div.cardhd', h('b', t.devices)),
          st.devices.map(([k, s]) => h('div.drow',
            h('span.dl', DEVICE_LABEL[k]),
            h('div.dtrack', h('div.dfill', { style: `width:${Math.round(100 * s / sum)}%` })),
            h('span.dv.num', `${Math.round(100 * s / sum)}%`))))
      },
      perBook: () => h('div.card.scard.span2', h('div.cardhd', h('b', t.perBook)),
        st.perBook.map(x => {
          const fin = x.book.status === 'finished' && x.book.finished_at ? new Date(x.book.finished_at) : null
          const days = fin && x.first ? Math.max(1, Math.round((dayStart(fin) - dayStart(x.first)) / 86400e3) + 1) : null
          const line1 = [x.first ? t.started(fmtDate(x.first)) : null, fin ? t.finishedOn(fmtDate(fin)) : null, days ? t.inDays(days) : null].filter(Boolean).join(', ')
          const line2 = [x.seconds ? t.dur(x.seconds) : null, x.highlights ? t.highlightsN(x.highlights) : null, x.notes ? t.notesN(x.notes) : null].filter(Boolean).join(' · ')
          return h('div.lrow', { onclick: () => openBook(x.book.id) },
            cover(x.book), h('div.mid', h('div.bt', x.book.title), line1 ? h('div.ba', line1) : null, line2 ? h('div.ba', line2) : null))
        })),
    }

    // One column of cards, two on wide screens (option A, picked 2026-10-22
    // over KPI tiles on top and three tabs).
    clear(body, h('div.sgrid', timeCard(), cards.calendar(), cards.finished(), cards.pace(), cards.left(), cards.when(), cards.devices(), cards.perBook()))
    const cal = body.querySelector('.cal')
    if (cal) cal.scrollLeft = cal.scrollWidth
  }

  const off = onChange(changed => { if (changed.has('sessions') || changed.has('books')) void render() })
  void render()
  return () => off()
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

function cover(b: Book, onclick?: () => void): HTMLElement {
  const el = h('div.cover.mini', onclick ? { onclick } : {})
  void local.get(`cover:${b.id}`).then(blob => {
    if (blob) el.prepend(h('img', { src: URL.createObjectURL(blob), alt: b.title }))
    else el.append(h('div.ph', h('b', b.title)))
  })
  return el
}

// Stacked bars (read below, listen above), one per day or month. The top
// gridline carries the scale; hover/long-press shows the exact values.
function bars(buckets: Bucket[]): HTMLElement {
  const max = Math.max(...buckets.map(splitTotal), 60)
  const step = niceStep(max)
  const top = Math.ceil(max / step) * step
  return h('div.bars',
    h('div.grid', h('span.num', t.durShort(top)), h('i')),
    h('div.cols', buckets.map(b => h('div.col' + (b.current ? '.cur' : ''), { title: `${b.title}: ${t.readLabel} ${t.dur(b.read)} · ${t.listenLabel} ${t.dur(b.listen)}` },
      h('div.stack',
        b.listen ? h('div.seg.listen', { style: `height:${100 * b.listen / top}%` }) : null,
        b.read ? h('div.seg.read', { style: `height:${100 * b.read / top}%` }) : null),
      h('span.lbl', b.label)))))
}

function niceStep(max: number): number {
  for (const s of [15 * 60, 30 * 60, 3600, 2 * 3600, 5 * 3600, 10 * 3600, 20 * 3600, 50 * 3600]) if (max / s <= 4) return s
  return 100 * 3600
}

// GitHub-style year: one column per week (Monday on top), darker = more time.
function calendar(st: Stats): HTMLElement {
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7 * 52)
  start.setDate(start.getDate() - (start.getDay() + 6) % 7)
  const vals = [...st.daily.values()].map(splitTotal).filter(v => v > 0).sort((a, b) => a - b)
  const q = (f: number) => vals[Math.floor(f * (vals.length - 1))] ?? 0
  const cuts = [q(0.25), q(0.5), q(0.75)]
  const level = (s: number) => s <= 0 ? 0 : s <= cuts[0] ? 1 : s <= cuts[1] ? 2 : s <= cuts[2] ? 3 : 4
  const cells: HTMLElement[] = []
  const months: HTMLElement[] = []
  let lastMonth = -1
  for (let d = new Date(start), i = 0; d <= today; d.setDate(d.getDate() + 1), i++) {
    const s = splitTotal(st.daily.get(dayKey(d)) ?? { read: 0, listen: 0 })
    cells.push(h('i.l' + level(s), { title: `${fmtDate(d)}: ${t.dur(s)}` }))
    if (i % 7 === 0 && d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth()
      months.push(h('span', { style: `grid-column:${i / 7 + 1}` }, fmtDate(d).split(' ')[1]))
    }
  }
  return h('div.calwrap',
    h('div.cal', h('div.months', months), h('div.cells', cells)),
    h('div.calkey', t.calendarLess, ...[0, 1, 2, 3, 4].map(l => h('i.l' + l)), t.calendarMore))
}

function hoursChart(hours: number[]): HTMLElement {
  const max = Math.max(...hours, 1)
  // The busiest 3-hour window, for the sentence on top.
  let best = 0
  for (let i = 0; i < 24; i++) if (hours[i] + hours[(i + 1) % 24] + hours[(i + 2) % 24] > hours[best] + hours[(best + 1) % 24] + hours[(best + 2) % 24]) best = i
  return h('div',
    h('div.peak', t.peakHour(best, best + 3 > 24 ? best - 21 : best + 3)),
    h('div.hours', hours.map((s, i) => h('div.hcol' + (i >= best && i < best + 3 ? '.peakc' : ''), { title: `${i}–${i + 1} h: ${t.dur(s)}` },
      h('div.hbar', { style: `height:${Math.max(s ? 4 : 0, 100 * s / max)}%` })))),
    h('div.hlabels', ['0', '6', '12', '18', '24'].map(x => h('span', x))))
}

function goalDialog(goal: number | null, done: () => void): void {
  openDialog(t.goalTitle, (body, close) => {
    const input = h('input.field.num', { type: 'number', min: '1', max: '365', value: goal ? String(goal) : '', inputmode: 'numeric', 'aria-label': t.goalTitle }) as HTMLInputElement
    const save = async () => {
      const n = parseInt(input.value, 10)
      await setGoal(n > 0 ? n : null)
      close()
      done()
    }
    body.append(h('p.ghint', t.goalHint), input,
      h('div.dbtns',
        h('button.btn.small.ghost', { onclick: () => close() }, t.cancel),
        h('button.btn.small.primary', { onclick: () => void save() }, t.save)))
    input.addEventListener('keydown', e => { if (e.key === 'Enter') void save() })
    setTimeout(() => input.focus(), 50)
  })
}
