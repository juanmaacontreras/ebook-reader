// Same pattern as Bitácora: on launch, look at the latest GitHub Release; if
// its number (tag v<N>, N = commit count) is newer than this build, offer it.
//  - Android: download the APK and hand it to the system installer (native
//    AppUpdate plugin; the user confirms, Android never installs silently).
//  - Desktop: Tauri's updater (signed bundles, latest.json in the release).

import { registerPlugin } from '@capacitor/core'
import { APP_VERSION, GITHUB_REPO } from '../config'
import { t } from '../strings'
import { confirmDialog, toast } from '../ui/dialog'
import { isAndroid, isTauri } from '.'

interface AppUpdatePlugin { install(o: { url: string }): Promise<void> }
const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate')

interface Release { tag_name: string; assets: { name: string; browser_download_url: string }[] }

export async function checkForUpdate(manual = false): Promise<void> {
  if (!isAndroid && !isTauri) return
  if (APP_VERSION === '0' && !manual) return  // dev build
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) return
    const rel = (await res.json()) as Release
    const remote = Number(rel.tag_name.replace(/^v/i, ''))
    if (!(remote > Number(APP_VERSION))) { if (manual) toast(t.version(APP_VERSION)); return }
    if (!(await confirmDialog(t.updateAvailable(`v${remote}`), '', t.updateNow))) return
    toast(t.updating, undefined, 120000)
    if (isAndroid) {
      const apk = rel.assets.find(a => a.name.endsWith('.apk'))
      if (apk) await AppUpdate.install({ url: apk.browser_download_url })
    } else {
      const { check } = await import('@tauri-apps/plugin-updater')
      const { relaunch } = await import('@tauri-apps/plugin-process')
      const update = await check()
      if (update) { await update.downloadAndInstall(); await relaunch() }
    }
  } catch (e) {
    console.warn('update check failed', e)
    if (manual) toast(t.updateFailed)
  }
}
