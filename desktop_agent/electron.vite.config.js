import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Konfiguracja electron-vite dla trzech procesów.
 *
 * Ścieżki są liczone względem katalogu roboczego (electron-vite zawsze
 * uruchamia się z katalogu projektu), a NIE przez `__dirname`. Powód:
 * package.json ma `"type": "module"`, więc plik konfiguracyjny jest modułem
 * ESM — w takim module `__dirname` nie istnieje i konfiguracja wywaliłaby się
 * przy `npm run dev`. To jest wzorzec z oficjalnego szablonu electron-vite.
 */
export default defineConfig({
  // -------------------------------------------------------------------------
  // Proces główny (Node.js)
  // -------------------------------------------------------------------------
  main: {
    // mssql (tedious), node-cron i electron-store zostają zewnętrzne.
    // Bundlowanie sterownika tedious kończy się błędami przy rozwiązywaniu
    // ścieżek do jego wewnętrznych modułów.
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve('src/main/index.js') }
      }
    }
  },

  // -------------------------------------------------------------------------
  // Preload — mostek między rendererem a procesem głównym
  // -------------------------------------------------------------------------
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve('src/preload/index.js') },
        // Rozszerzenie .mjs jest wymagane: preload w formacie ESM musi mieć
        // jednoznaczny typ modułu. Proces główny ładuje dokładnie tę nazwę
        // (patrz webPreferences.preload w src/main/index.js).
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  },

  // -------------------------------------------------------------------------
  // Renderer (React)
  // -------------------------------------------------------------------------
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
