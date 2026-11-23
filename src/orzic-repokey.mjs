// Per-repo key for orzic driver state files. MUST stay byte-for-byte
// identical to repoKeyFor in repokey.ts (plugin side) — the driver's file
// names and the panel's lookups have to agree.
//
// Collisions the naive `cwd.replace(/[:\\/]/g,'-')` slug allowed:
//   C:\tmp\a-b  vs  C:\tmp\a\b   → both became C--tmp-a-b
//   case variants on Windows drive letters, trailing slashes, symlinked paths.
//
// Key = readable basename + '-' + 16-hex sha256 of the NORMALIZED real path,
// so files stay human-sortable while uniqueness comes from the hash.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'

/** @param {string} cwd @returns {string} e.g. 'myrepo-a1b2c3d4e5f60708' */
export function repoKey(cwd) {
  const n = normalize(cwd)
  const hash = createHash('sha256').update(n).digest('hex').slice(0, 16)
  const leaf = (basename(n) || 'root').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'root'
  return `${leaf}-${hash}`
}

function normalize(cwd) {
  let n = String(cwd ?? '')
  // realpath: resolves symlinks + canonicalizes separators + fixes Windows drive case.
  try { n = realpathSync(n) } catch { /* non-existent path — hash the given string */ }
  // Windows-only normalization: POSIX realpaths may legitimately contain '\'
  // (e.g. /tmp/a\b is one directory, /tmp/a/b is another). Folding separators
  // globally would collide them.
  if (/^[a-zA-Z]:[\\/]/.test(n)) {
    // Local Windows path: separators AND case are insignificant on NTFS, and
    // realpathSync preserves the input's casing — so c:\x and C:\X must hash alike.
    n = n.replace(/\\/g, '/').toLowerCase()
  } else if (n.startsWith('\\\\')) {
    // UNC share: fold separators but KEEP case — \\wsl$\ paths can be a
    // case-sensitive Linux filesystem.
    n = n.replace(/\\/g, '/')
  }
  // Trailing separators are safe to drop on every OS: /x/ and /x\ are the same dir;
  // the lone root '/' becomes '' and falls back to 'root' in repoKey.
  const trimmed = n.replace(/[\\/]+$/, '')
  return trimmed || n
}
