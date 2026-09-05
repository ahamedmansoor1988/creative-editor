// Build: compiles src/code.ts -> code.js (with the Groq key injected as ECT_ENV) and
// inlines src/ai.js into src/ui.html -> ui.html. Figma loads code.js + ui.html (see manifest).
// The key comes from ./.env, falling back to ../.env (the creative-editor app's env).
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

function readEnv(file) {
  if (!fs.existsSync(file)) return {}
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const parentEnv = readEnv(path.join(root, '..', '.env'))
const localEnv = readEnv(path.join(root, '.env'))
const key = localEnv.GROQ_API_KEY || parentEnv.GROQ_API_KEY || ''
const keySource = localEnv.GROQ_API_KEY ? '.env' : parentEnv.GROQ_API_KEY ? '../.env (creative-editor)' : 'none'

execSync('npx tsc -p tsconfig.json', { cwd: root, stdio: 'inherit' })
const js = fs.readFileSync(path.join(root, 'build', 'code.js'), 'utf8')
fs.writeFileSync(path.join(root, 'code.js'), `const ECT_ENV = ${JSON.stringify({ GROQ_API_KEY: key })};\n${js}`)

const ai = fs.readFileSync(path.join(root, 'src', 'ai.js'), 'utf8')
const ui = fs.readFileSync(path.join(root, 'src', 'ui.html'), 'utf8')
if (!ui.includes('<!--AI_JS-->')) throw new Error('src/ui.html is missing the <!--AI_JS--> placeholder')
fs.writeFileSync(path.join(root, 'ui.html'), ui.replace('<!--AI_JS-->', () => `<script>\n${ai}\n</script>`))
console.log(`built code.js + ui.html (Groq key: ${keySource})`)
