import { configured, supabase } from '../data/supabase'
import { APP_NAME, t } from '../strings'
import { h } from '../ui/dom'
import { icon } from '../ui/icons'

export function authScreen(root: HTMLElement): void {
  let mode: 'in' | 'up' = 'in'
  const email = h('input.field', { type: 'email', placeholder: t.email, autocomplete: 'email', inputMode: 'email' })
  const password = h('input.field', { type: 'password', placeholder: t.password, autocomplete: 'current-password' })
  const err = h('div.err', configured ? '' : t.authNotConfigured)
  const submit = h('button.btn.primary.block', { type: 'submit' }, t.signIn)
  const switchBtn = h('button.textbtn', { type: 'button' }, t.noAccount)

  const render = () => {
    submit.textContent = mode === 'in' ? t.signIn : t.signUp
    switchBtn.textContent = mode === 'in' ? t.noAccount : t.haveAccount
    password.autocomplete = mode === 'in' ? 'current-password' : 'new-password'
  }
  switchBtn.onclick = () => { mode = mode === 'in' ? 'up' : 'in'; err.textContent = ''; render() }

  const form = h('form', {
    onsubmit: async (e: Event) => {
      e.preventDefault()
      if (!configured) return
      if (mode === 'up' && password.value.length < 8) { err.textContent = t.authWeakPassword; return }
      submit.disabled = true
      submit.textContent = t.authWorking
      err.textContent = ''
      const creds = { email: email.value.trim(), password: password.value }
      const { error } = mode === 'in' ? await supabase.auth.signInWithPassword(creds) : await supabase.auth.signUp(creds)
      submit.disabled = false
      render()
      if (error) {
        const m = error.message.toLowerCase()
        err.textContent = !navigator.onLine || m.includes('fetch') ? t.authOffline
          : m.includes('sign-ups are closed') || m.includes('database error saving new user') ? t.authClosed
          : m.includes('password') && mode === 'up' ? t.authWeakPassword
          : t.authBadCredentials
      }
    },
  }, email, password, err, submit, h('div.switch', switchBtn))

  root.replaceChildren(h('div.auth',
    h('div.logo', icon('books')),
    h('h1', t.signInTitle),
    h('p', t.signInSub),
    form,
    h('p.muted', { style: 'text-align:center;margin-top:32px;font-size:13px' }, APP_NAME),
  ))
  render()
}
