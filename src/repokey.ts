// Mirror of orzic-repokey.mjs for the TypeScript side (worker/acceptance/loop).
// KEEP IN SYNC: the driver's file names and the panel's lookups share these keys.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'

/** e.g. 'myrepo-a1b2c3d4e5f60708' — readable leaf + collision-proof hash. */
export function repoKeyFor(cwd: string): string {
  const n = normalizeKeyPath(cwd)
  const hash = createHash('sha256').update(n).digest('hex').slice(0, 16)
  const leaf = (basename(n) || 'root').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root'
  return `${leaf}-${hash}`
}

function normalizeKeyPath(cwd: string): string {
  let n = String(cwd ?? '')
  try { n = realpathSync(n) } catch { /* non-existent path — hash the given string */ }
  // Windows-only: POSIX realpaths may contain '\' as a literal char (/tmp/a\b vs /tmp/a/b).
  if (/^[a-zA-Z]:[\\/]/.test(n)) {
    // NTFS: separators AND case insignificant; realpathSync keeps input casing.
    n = n.replace(/\\/g, '/').toLowerCase()
  } else if (n.startsWith('\\\\')) {
    // UNC: fold separators, KEEP case — \\wsl$\ may be case-sensitive.
    n = n.replace(/\\/g, '/')
  }
  const trimmed = n.replace(/[\\/]+$/, '')
  return trimmed || n
}
