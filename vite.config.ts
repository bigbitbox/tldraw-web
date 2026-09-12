import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 开发联调构建；取得许可证后以 APP_ENV=production 构建正式版本。
export default defineConfig(() => {
  const development = process.env.APP_ENV !== 'production'
  return {
    plugins: [react(), {
      name: 'local-tldraw-assets',
      closeBundle() {
        mkdirSync('dist/client/tldraw-assets', { recursive: true })
        for (const name of ['fonts', 'icons', 'embed-icons', 'translations']) {
          cpSync(fileURLToPath(new URL(`./node_modules/@tldraw/assets/${name}`, import.meta.url)), `dist/client/tldraw-assets/${name}`, { recursive: true })
        }
      },
    }],
    define: {
      'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production'),
      'import.meta.env.DEV_MODE': JSON.stringify(development ? 'true' : 'false'),
    },
    build: { outDir: 'dist/client', sourcemap: false },
  }
})
