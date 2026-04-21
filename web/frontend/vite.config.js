import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function readEnvValue(filePath, key) {
  if (!existsSync(filePath)) return null
  const contents = readFileSync(filePath, 'utf8')
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = contents.match(new RegExp(`^[ \t]*${escapedKey}[ \t]*=[ \t]*(.*)[ \t]*$`, 'm'))
  if (!match) return null
  const rawValue = match[1].trim()
  if (!rawValue) return ''
  return rawValue.replace(/^['"]|['"]$/g, '')
}

function hydrateEmptyEnvFromFiles(mode, key) {
  if (process.env[key] !== '') return

  const candidates = [
    `.env.${mode}.local`,
    `.env.${mode}`,
    '.env.local',
    '.env',
  ]

  for (const candidate of candidates) {
    const value = readEnvValue(resolve(process.cwd(), candidate), key)
    if (value) {
      process.env[key] = value
      return
    }
  }
}

function resolveEnvValue(mode, key) {
  const shellValue = process.env[key]
  if (typeof shellValue === 'string' && shellValue.trim()) {
    return shellValue.trim()
  }

  const candidates = [
    `.env.${mode}.local`,
    `.env.${mode}`,
    '.env.local',
    '.env',
  ]

  for (const candidate of candidates) {
    const value = readEnvValue(resolve(process.cwd(), candidate), key)
    if (value) {
      return value
    }
  }

  return ''
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  hydrateEmptyEnvFromFiles(mode, 'VITE_MAPBOX_TOKEN')
  const mapboxToken = resolveEnvValue(mode, 'VITE_MAPBOX_TOKEN')

  return {
    define: {
      'import.meta.env.VITE_MAPBOX_TOKEN': JSON.stringify(mapboxToken),
    },
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: true,
        },
      },
    },
  }
})
