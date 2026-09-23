// Build: compiles src/code.ts -> code.js and inlines src/ai.js into src/ui.html -> ui.html.
// Figma loads code.js + ui.html (see manifest).
//
// NO KEY IS BUILT IN. This used to read GROQ_API_KEY from ./.env, falling back to
// the creative-editor app's ../.env, and write it into code.js — so anyone handed
// a built plugin was handed the key with it. The person using the plugin pastes
// their own key in its UI; it is kept in Figma's client storage for that file.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

execSync('npx tsc -p tsconfig.json', { cwd: root, stdio: 'inherit' })
const js = fs.readFileSync(path.join(root, 'build', 'code.js'), 'utf8')
fs.writeFileSync(path.join(root, 'code.js'), `const ECT_ENV = {};\n${js}`)

const ai = fs.readFileSync(path.join(root, 'src', 'ai.js'), 'utf8')
const ui = fs.readFileSync(path.join(root, 'src', 'ui.html'), 'utf8')
if (!ui.includes('<!--AI_JS-->')) throw new Error('src/ui.html is missing the <!--AI_JS--> placeholder')
fs.writeFileSync(path.join(root, 'ui.html'), ui.replace('<!--AI_JS-->', () => `<script>\n${ai}\n</script>`))
console.log('built code.js + ui.html (no key built in: paste one in the plugin UI)')
