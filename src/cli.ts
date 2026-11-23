import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ompExecutable = process.env.OMP_CLI_COMMAND ??
  [join(homedir(), 'AppData', 'Local', 'omp', 'omp.exe'), join(homedir(), '.local', 'bin', 'omp'),
    process.platform === 'win32' ? 'omp.exe' : 'omp'].find((row) => row === 'omp' || row === 'omp.exe' || existsSync(row)) ?? 'omp'

export function commandError(message: string): Error {
  return new Error(message)
}
