import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// Minimal .env loader (ini subset): KEY=VALUE pairs, `#`/`;` comments,
// optional surrounding quotes. Later files win over earlier ones.
export function parseEnvContent(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  const text = content.replace(/^﻿/, '')

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()

    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue
    }

    const equals = line.indexOf('=')

    if (equals <= 0) {
      continue
    }

    const key = line.slice(0, equals).trim()
    let value = line.slice(equals + 1).trim()

    const quote = value[0]

    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1)
    }

    env[key] = value
  }

  return env
}

function readEnvFile(dir: string, name: string): Record<string, string> {
  const file = path.resolve(dir, name)

  if (!existsSync(file)) {
    return {}
  }

  return parseEnvContent(readFileSync(file, 'utf8'))
}

// Loads `.env` → `.env.local` → `.env.[mode]` → `.env.[mode].local`.
export function loadEnvFiles(
  dir: string,
  mode?: string,
): Record<string, string> {
  const targets = ['.env', '.env.local']

  if (mode) {
    targets.push(`.env.${mode}`, `.env.${mode}.local`)
  }

  const env: Record<string, string> = {}

  for (const name of targets) {
    Object.assign(env, readEnvFile(dir, name))
  }

  return env
}
