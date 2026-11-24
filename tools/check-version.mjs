// Keep the plugin version in one release train: manifest, npm package, and the
// version shown in the panel footer must agree before tagging a release.
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const lockRoot = lock.packages?.[''] ?? {}
const panel = readFileSync(new URL('../src/panel.tsx', import.meta.url), 'utf8')
const shown = panel.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1]

const problems = []
if (pkg.version !== manifest.version) problems.push(`package.json ${pkg.version} != orca-plugin.json ${manifest.version}`)
if (lock.version !== manifest.version) problems.push(`package-lock.json ${lock.version} != orca-plugin.json ${manifest.version}`)
if (lockRoot.version !== manifest.version) problems.push(`package-lock.json packages[""].version ${lockRoot.version} != orca-plugin.json ${manifest.version}`)
if (lock.name !== pkg.name) problems.push(`package-lock.json name ${lock.name} != package.json ${pkg.name}`)
if (lockRoot.name !== pkg.name) problems.push(`package-lock.json packages[""].name ${lockRoot.name} != package.json ${pkg.name}`)
if (shown !== manifest.version) problems.push(`panel PLUGIN_VERSION ${shown ?? '(missing)'} != orca-plugin.json ${manifest.version}`)
if (problems.length) {
  console.error(`version mismatch:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`version ${manifest.version} consistent (manifest, package, lock, panel)`)
