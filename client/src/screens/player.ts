import type { NarrationController } from '../audio/controller'
import { MAX_RATE, MIN_RATE, RATES } from '../audio/engine'
import { t } from '../strings'
import { h } from '../ui/dom'
import { icon } from '../ui/icons'
import { openDialog } from '../ui/dialog'
import { audioManager } from '../platform'

export interface PlayerCard {
  el: HTMLElement
  setPlaying(p: boolean): void
  setTime(section: number, time: number, duration: number): void
  setStatus(message: string | null, busy?: boolean): void
}

const fmt = (s: number) => {
  s = Math.max(0, Math.floor(s))
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60
  return (hh ? `${hh}:${String(mm).padStart(2, '0')}` : String(mm)) + ':' + String(ss).padStart(2, '0')
}
const rateLabel = (r: number) => `${String(r).replace('.', ',')}×`

export function playerCard(narr: NarrationController, opts: { close: () => void; voice: () => void; title: (section: number) => string }): PlayerCard {
  const chapter = h('b', '')
  const status = h('span', '')
  const cur = h('span.num', '0:00')
  const dur = h('span.num', '0:00')
  const seek = h('input', { type: 'range', min: '0', max: '1', step: '0.1', value: '0', 'aria-label': t.listen }) as HTMLInputElement
  let dragging = false
  seek.oninput = () => { dragging = true; cur.textContent = fmt(Number(seek.value)) }
  seek.onchange = async () => {
    dragging = false
    const st = narr.current
    if (st.section >= 0) await narr.skip(Number(seek.value) - lastTime)
  }
  let lastTime = 0
  const playIcon = h('span', icon('play'))
  const play = h('button.playbig', { 'aria-label': t.play, onclick: () => void narr.toggle() }, playIcon)
  // Speed: a sheet with fine steps (0.05), a slider and the usual presets, so
  // a missed tap is one step back instead of a whole cycle.
  const setRate = (r: number) => {
    r = Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, r)) * 100) / 100
    speed.textContent = rateLabel(r)
    void narr.setRate(r)
  }
  const speedSheet = () => openDialog(t.speed, body => {
    const big = h('div.ratebig.num', rateLabel(narr.rate))
    const slider = h('input', { type: 'range', min: String(MIN_RATE), max: String(MAX_RATE), step: '0.05', value: String(narr.rate), 'aria-label': t.speed }) as HTMLInputElement
    const apply = (r: number) => { setRate(r); big.textContent = rateLabel(narr.rate); slider.value = String(narr.rate) }
    slider.oninput = () => apply(Number(slider.value))
    body.append(
      h('div.ratefine',
        h('button.iconbtn', { 'aria-label': t.slower, onclick: () => apply(narr.rate - 0.05) }, icon('minus')),
        big,
        h('button.iconbtn', { 'aria-label': t.faster, onclick: () => apply(narr.rate + 0.05) }, icon('plus'))),
      h('div.sizes', h('span.a.num', rateLabel(MIN_RATE)), slider, h('span.a.num', rateLabel(MAX_RATE))),
      h('div.rates', ...RATES.map(r => h('button.rate.num', { onclick: () => apply(r) }, rateLabel(r)))))
  })
  const speed = h('button.speedbtn.num', { title: t.speed, onclick: speedSheet }, rateLabel(narr.rate))
  const skipBtn = (ico: string, label: string, run: () => void) =>
    h('button.iconbtn.flat.skipbtn', { title: label, 'aria-label': label, onclick: run }, icon(ico), h('small', '30'))

  const el = h('div.card.player',
    h('div.ptop',
      h('div.pinfo', chapter, status),
      h('button.iconbtn.flat', { title: audioManager ? t.voice : t.narration, 'aria-label': audioManager ? t.voice : t.narration, onclick: () => opts.voice() }, icon('wave')),
      h('button.iconbtn.flat', { 'aria-label': t.close, onclick: () => opts.close() }, icon('close'))),
    h('div.ptrack', cur, seek, dur),
    h('div.pctl',
      speed,
      h('button.iconbtn.flat', { title: t.prevSentence, 'aria-label': t.prevSentence, onclick: () => void narr.stepSentence(-1) }, icon('prevs')),
      skipBtn('rewind', t.back30, () => void narr.back()),
      play,
      skipBtn('forward', t.fwd30, () => void narr.forward()),
      h('button.iconbtn.flat', { title: t.nextSentence, 'aria-label': t.nextSentence, onclick: () => void narr.stepSentence(1) }, icon('nexts')),
      h('span.pspacer')))

  return {
    el,
    setPlaying(p) {
      playIcon.replaceChildren(icon(p ? 'pause' : 'play'))
      play.setAttribute('aria-label', p ? t.pause : t.play)
    },
    setTime(section, time, duration) {
      chapter.textContent = opts.title(section)
      lastTime = time
      if (!dragging) {
        seek.max = String(duration || 1)
        seek.value = String(time)
        cur.textContent = fmt(time)
      }
      dur.textContent = fmt(duration)
    },
    setStatus(message, busy) {
      status.replaceChildren(...(busy ? [h('span.spinner', { style: 'display:inline-block;width:11px;height:11px;border-width:2px;vertical-align:-1px;margin-right:6px' })] : []), message ?? '')
    },
  }
}
