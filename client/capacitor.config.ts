import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.atril.reader',
  appName: 'Atril',
  webDir: 'dist',
  android: { allowMixedContent: false },
  plugins: {
    // Edge to edge: the system bars are transparent over the app's paper color;
    // safe-area insets arrive as --safe-area-inset-* CSS variables.
    SystemBars: { insetsHandling: 'css', style: 'DEFAULT' },
  },
}

export default config
