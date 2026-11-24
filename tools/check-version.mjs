// Keep the plugin version in one release train: manifest, npm package, and the
// version shown in the panel footer must agree before tagging a release.
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const panel = readFileSync(new URL('../src/panel.tsx', import.meta.url), 'utf8')
const shown = panel.match(/const PLUGIN_VERSION = '([^']+)'/)?.[1]

const problems = []
if (pkg.version !== manifest.version) problems.push(`package.json ${pkg.version} != orca-plugin.json ${manifest.version}`)
if (shown !== manifest.version) problems.push(`panel PLUGIN_VERSION ${shown ?? '(missing)'} != orca-plugin.json ${manifest.version}`)
if (problems.length) {
  console.error(`version mismatch:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`version ${manifest.version} consistent (manifest, package, panel)`)
