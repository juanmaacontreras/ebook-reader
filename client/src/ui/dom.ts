// Tiny DOM builder. h('div.card.row', { onclick }, child, 'text') — class names
// after dots, attributes/properties/listeners in the props object.

type Child = Node | string | number | null | undefined | false | Child[]
type Props = Record<string, unknown> & { style?: Partial<CSSStyleDeclaration> | string }

type TagOf<S extends string> = S extends `${infer T}.${string}` ? T : S
type El<S extends string> = TagOf<S> extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[TagOf<S>] : HTMLElement

export function h<S extends string>(spec: S, props?: Props | Child, ...children: Child[]): El<S> {
  const [tag, ...classes] = spec.split('.')
  const el = document.createElement(tag || 'div')
  if (classes.length) el.className = classes.join(' ')
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props as Child)
  } else if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue
      if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v)
        else Object.assign(el.style, v)
      } else if (k === 'class') el.className += (el.className ? ' ' : '') + String(v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
      else if (k.startsWith('--')) el.style.setProperty(k, String(v))
      else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v
      else el.setAttribute(k, v === true ? '' : String(v))
    }
  }
  append(el, children)
  return el as El<S>
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

export function clear(el: Element, ...children: Child[]): void {
  el.replaceChildren()
  append(el, children)
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null
