// ─── Acceptance: deterministic `ocr review` against rule.json, verdict from SARIF findings ───
// 手动路径(面板「运行验收」)用 ompJudge/ocrCli;自动路径用外部 orzic-driver.mjs。
// verdict 语义两边必须一致:只有显式 pass 才算过;任何失败/未知/无输出都不是 pass。
// 手动路径的 verdict 解析与 orzic-verdict.mjs 是同一份逻辑——改动要同步两处。
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandError, ompExecutable } from './cli'
import { repoKeyFor } from './repokey'
import type { OrcaWorkerApi } from 'orca/worker'
import type { AcceptanceCfg, Finding, ReviewOut } from './protocol'

// `ocr` 是可选外部依赖:探测 PATH / npm 全局入口 / OCR_CLI_COMMAND。
// Windows 上 npm 的 `ocr.cmd` 不能被 execFile 直接执行,优先走 node + 包内 JS 入口。
const ocrEntryCandidates = [
  join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js'),
  join(homedir(), '.npm-global', 'node_modules', '@alibaba-group', 'open-code-review', 'bin', 'ocr.js'),
  '/usr/local/lib/node_modules/@alibaba-group/open-code-review/bin/ocr.js',
  '/usr/lib/node_modules/@alibaba-group/open-code-review/bin/ocr.js',
]
const ocrEntry = ocrEntryCandidates.find(existsSync)
const ocrBin = process.env.OCR_CLI_COMMAND ?? 'ocr'

function ocrCli(args: string[], cwd: string): Promise<string> {
  const env = { ...process.env }
  if (process.platform === 'win32' && !env.APPDATA) env.APPDATA = join(homedir(), 'AppData', 'Roaming')
  // 有 JS 入口用 node 跑(跨平台最稳);否则试 PATH 里的 `ocr`。
  const cmd = ocrEntry ? process.execPath : ocrBin
  const argv = ocrEntry ? [ocrEntry, ...args, '--format', 'json', '--audience', 'agent']
    : [...args, '--format', 'json', '--audience', 'agent']
  return new Promise((resolve, reject) => {
    execFile(cmd, argv, {
      encoding: 'utf8', env, cwd, windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) return reject(commandError(`ocr ${args[0]} 失败:${stderr?.slice(0, 400) || String(error)}`))
      resolve(stdout)
    })
  })
}

// 区分「没装 ocr」和「装了但跑挂」——上架版要优雅降级。
const git = (cwd: string, args: string[]): Promise<{ out: string; err: string | null }> => new Promise((resolve) => {
  execFile('git', args, { encoding: 'utf8', cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (e, out, stderr) => {
    resolve({ out: out || '', err: e ? (stderr || String(e)).slice(0, 200) : null })
  })
})

// Distinguishes three cases the old code collapsed into "show HEAD":
//   empty-but-valid diff (A..A) -> '' + no err -> 'unreviewed'
//   invalid ref                 -> err -> 'failed' (never judge HEAD instead)
//   root commit                 -> `git show <commit>` — only when the REQUESTED
//   commit itself has no parent (rev-list count == 1); never substitutes HEAD.
const gitDiff = async (cwd: string, commit?: string, from?: string, to?: string): Promise<{ out: string; err: string | null }> => {
  if (commit) {
    const c = await git(cwd, ['rev-list', '--count', commit])
    if (c.err) return { out: '', err: `invalid commit ${commit}: ${c.err}` }
    if (c.out.trim() === '1') return git(cwd, ['show', commit, '--format='])
    return git(cwd, ['diff', `${commit}~1..${commit}`])
  }
  if (from) return git(cwd, ['diff', `${from}..${to ?? 'HEAD'}`])
  const c = await git(cwd, ['rev-list', '--count', 'HEAD'])
  if (c.err) return { out: '', err: c.err }
  if (c.out.trim() === '1') return git(cwd, ['show', 'HEAD', '--format='])
  return git(cwd, ['diff', 'HEAD~1..HEAD'])
}
const ruleFor = (cwd: string, rulePath: string | null): string => {
  if (!rulePath) return '检查常见缺陷:空输入、除零、未捕获错误、边界、注入'
  try { const d = JSON.parse(readFileSync(join(cwd, rulePath), 'utf8')) as { rules?: { rule?: string }[] }; return (d.rules ?? []).map((r) => r.rule).filter(Boolean).join(';') || '检查常见缺陷' } catch { return '检查常见缺陷' }
}
const planFor = (cwd: string): string => {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.omp', 'agent', `orzic-plan-${repoKeyFor(cwd)}.json`), 'utf8')) as { approved?: boolean; planContent?: string }
    return d.approved === true && typeof d.planContent === 'string' ? d.planContent.slice(0, 20000) : ''
  } catch { return '' }
}
const ompJudge = (cwd: string, acc: AcceptanceCfg | null, commit?: string, from?: string, to?: string): Promise<{ verdict: 'pass' | 'rework' | 'unreviewed' | 'failed' | 'no-repo'; findings: Finding[]; summary: string; sarif?: string }> => new Promise((resolve) => {
  void (async () => {
    const { out: diff, err: diffErr } = await gitDiff(cwd, commit, from, to)
    if (diffErr) return resolve({ verdict: 'failed', findings: [], summary: `git diff 失败:${diffErr}` })
    if (!diff.trim()) return resolve({ verdict: 'unreviewed', findings: [], summary: '无 diff' })
    const model = acc?.ocrModel ?? 'openai-codex/gpt-6.2-sol'
    const rule = ruleFor(cwd, acc?.rulePath ?? null)
    const plan = planFor(cwd)
    const planBlock = plan ? `\n已批准的计划(实现须与之一致,偏离即 finding):\n${plan}\n` : ''
    const prompt = `你是代码验收评审。按规则审以下 git diff,只输出 JSON(无其他文字):{"verdict":"pass|rework","findings":[{"severity":"low|medium|high|blocker","file":"","line":0,"message":""}]}。规则:${rule}${planBlock}

diff:
${diff.slice(0, 120000)}`
    const child = execFile(ompExecutable, ['--model', model, '--mode', 'json', '--no-session', '--no-extensions', '--no-prewalk', prompt], { encoding: 'utf8', cwd, timeout: 280_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) return resolve({ verdict: 'failed', findings: [], summary: `omp 评审失败:${(stderr || String(error)).slice(0, 200)}` })
      try {
        // --mode json 是事件流(ndjson);取最后一条 role:assistant 的 message_end,拼 content[].text
        let verdictText = ''
        for (const line of stdout.split('\n')) {
          if (!line.includes('"message_end"')) continue
          try { const e = JSON.parse(line) as { type?: string; message?: { role?: string; content?: { type?: string; text?: string }[] } }; if (e.type === 'message_end' && e.message?.role === 'assistant') verdictText = (e.message.content ?? []).map((c) => c.text ?? '').join('') } catch { /* skip */ }
        }
        if (!verdictText.trim()) return resolve({ verdict: 'failed', findings: [], summary: 'omp 评审输出无 message_end' })
        const d = JSON.parse(verdictText) as { verdict?: string; findings?: { severity?: string; file?: string; path?: string; line?: number; message?: string }[] }
        const findings: Finding[] = (d.findings ?? []).flatMap((f) => (f.file ?? f.path) ? [{ severity: f.severity ?? 'info', file: f.file ?? f.path ?? '', line: f.line ?? null, message: f.message ?? '' }] : [])
        const blocker = findings.some((f) => /blocker|critical|high|error/i.test(f.severity))
        // 只认显式 pass;空/未知 verdict 一律 failed,绝不当 pass。
        const verdict = blocker || d.verdict === 'rework' ? 'rework' : d.verdict === 'pass' ? 'pass' : 'failed'
        resolve({ verdict, findings, summary: `${findings.length} findings(omp ${model.split('/').pop()})` })
      } catch { resolve({ verdict: 'failed', findings: [], summary: 'omp 评审输出无法解析' }) }
    })
    child.stdin?.end()  // omp 会把 open stdin 当 piped input 等 EOF;主动关掉
  })()
})

function ocrUnavailable(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e)
  return /ENOENT|not found|无法运行|spawn/i.test(m)
}

// Verdict is deterministic: `rework` when a blocker finding exists, `pass` only when the run
// completed and produced zero blocker findings. `unreviewed`/`failed`/`no-repo` are NOT pass.
function verdictFrom(findings: Finding[], reviewable: number): 'pass' | 'rework' | 'unreviewed' {
  if (reviewable === 0) return 'unreviewed'
  const blocker = findings.some((f) => /blocker|critical|high|error/i.test(f.severity))
  return blocker ? 'rework' : 'pass'
}

export async function acceptanceReview(orca: OrcaWorkerApi, input: { repo?: string; commit?: string; from?: string; to?: string }) {
  const acc = (await orca.storage.get('acceptance').catch(() => null)) as AcceptanceCfg | null
  const repo = input.repo?.trim()
  if (!repo || !existsSync(join(repo, '.git'))) return { verdict: 'no-repo' as const, findings: [], summary: `repo 无效:${repo ?? '(空)'}` }
  // 默认走 OMP 池判定(复用认证);ocr 装了+启用才用外部判定。
  if (!acc?.ocr) return ompJudge(repo, acc, input.commit, input.from, input.to)
  const args = ['review']
  if (input.commit) args.push('-c', input.commit)
  else if (input.from) { args.push('--from', input.from); if (input.to) args.push('--to', input.to) }
  if (acc.ocrModel) args.push('--model', acc.ocrModel.split('/').pop()!)
  if (acc.ocrEffort) { const e = ({ xhigh: 'high', max: 'high' } as Record<string, string>)[acc.ocrEffort] ?? acc.ocrEffort; args.push('--effort', e) }
  if (acc.rulePath) args.push('--rule', acc.rulePath)
  try {
    const raw = await ocrCli(args, repo)
    const d = JSON.parse(raw) as { status?: string; summary?: { files_reviewed?: number; comments?: number }; comments?: { file?: string; path?: string; line?: number; severity?: string; level?: string; message?: string; body?: string; content?: string }[] | null }
    if (d.status === 'failed' || d.status === 'error') return { verdict: 'failed' as const, findings: [], summary: `ocr 失败:${JSON.stringify(d.summary ?? d).slice(0, 300)}` }
    const findings: Finding[] = (d.comments ?? []).flatMap((c) => {
      const file = c.file ?? c.path
      return file ? [{ severity: c.severity ?? c.level ?? 'info', file, line: c.line ?? null, message: c.message ?? c.body ?? c.content ?? '' }] : []
    })
    return { verdict: verdictFrom(findings, d.summary?.files_reviewed ?? 0), findings, summary: `${d.summary?.files_reviewed ?? 0} 文件/${findings.length} findings`, sarif: raw }
  } catch (e) {
    if (ocrUnavailable(e)) return { verdict: 'unreviewed' as const, findings: [], summary: '未安装 ocr;npm i -g @alibaba-group/open-code-review + 配置凭证后可用' }
    return { verdict: 'failed' as const, findings: [], summary: e instanceof Error ? e.message.slice(0, 300) : 'ocr 运行失败' }
  }
}

const agentDir = join(homedir(), '.omp', 'agent')
// Same repoKey rule as orzic-driver.mjs (orzic-repokey.mjs) — hash-based so
// C:\tmp\a-b and C:\tmp\a\b can't collide; readable basename stays in the name.
const pathsFor = (repo: string) => {
  const key = repoKeyFor(repo)
  return {
    reviewFile: join(agentDir, `orzic-review-${key}.json`),
    lockFile: join(agentDir, `orzic-driver-${key}.lock`),
    stopFile: join(agentDir, `orzic-stop-${key}`),
  }
}
// Directory lock: each holder owns `owner-<token>.json`; the live holder is the
// fresh entry with the smallest token (atomic — see orzic-lock.mjs). Kept
// inline here like orzic-loop.ts/repokey.ts: the worker stays single-file.
const readDirLock = (lockDir: string, staleMs = 10 * 60_000): { pid?: number; token?: string } | null => {
  try {
    const live: { token: string; pid?: number; at: string }[] = []
    for (const f of readdirSync(lockDir)) {
      if (!f.startsWith('owner-') || !f.endsWith('.json')) continue
      try {
        const d = JSON.parse(readFileSync(join(lockDir, f), 'utf8')) as { token?: string; pid?: number; at?: string }
        const t = Date.parse(String(d?.at ?? ''))
        if (typeof d?.token === 'string' && d.token && Number.isFinite(t) && Date.now() - t < staleMs) live.push({ token: d.token, pid: d.pid, at: String(d.at) })
      } catch { /* skip */ }
    }
    live.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
    return live[0] ?? null
  } catch { return null }
}
/** Deliver a stop to the OWNING driver via the token it minted into the lock —
 * never a raw PID kill (the OS may have recycled the number). The driver polls
 * the stop file, kills its own in-flight `omp -r`, and releases its own lock. */
export function acceptanceStop(input?: { repo?: string; force?: boolean }): { stopped: boolean; note: string } {
  const repo = input?.repo?.trim()
  if (!repo) return { stopped: false, note: '未指定仓库' }
  const { lockFile, stopFile } = pathsFor(repo)
  try {
    const d = readDirLock(lockFile)
    if (!d) return { stopped: false, note: '该仓库没有运行中的验收循环' }
    if (input?.force) {
      if (!d.token) return { stopped: false, note: '锁里没有 run token,无法 force(旧版 driver?重开一轮)' }
      writeFileSync(stopFile, JSON.stringify({ at: new Date().toISOString(), token: d.token, kill: true }))
      return { stopped: true, note: `已请求强杀 pid:${d.pid ?? '?'},driver 将自终结` }
    }
    writeFileSync(stopFile, JSON.stringify({ at: new Date().toISOString(), token: d.token }))
    return { stopped: true, note: '已请求停止,driver 本轮结束后退出' }
  } catch (e) { return { stopped: false, note: e instanceof Error ? e.message : 'stop 失败' } }
}

// Panel-facing state of the detached acceptance loop. Reads only — the loop's
// own verdict file is the source of truth; the lock file tells whether a driver
// is actually running right now. Scoped to the panel's repo via `slugFor`.
export function acceptanceResult(input?: { repo?: string }): ReviewOut {
  const repo = input?.repo?.trim()
  const { reviewFile, lockFile } = repo ? pathsFor(repo) : { reviewFile: '', lockFile: '' }
  const live = lockFile ? readDirLock(lockFile) : null
  const driverAlive = live != null
  const driverPid = typeof live?.pid === 'number' ? live.pid : null
  try {
    const d = JSON.parse(readFileSync(reviewFile, 'utf8')) as { verdict?: string; findings?: { severity?: string; file?: string; line?: number | null; message?: string }[]; summary?: string; at?: string; round?: number; consumed?: boolean }
    const findings = (d.findings ?? []).flatMap((f) => typeof f?.file === 'string' ? [{ severity: f.severity ?? 'info', file: f.file, line: f.line ?? null, message: f.message ?? '' }] : [])
    return {
      verdict: (d.verdict ?? 'unreviewed') as ReviewOut['verdict'],
      findings, summary: d.summary ?? '',
      at: d.at ?? null, round: typeof d.round === 'number' ? d.round : null,
      consumed: d.consumed === true, driverAlive, driverPid,
    }
  } catch {
    return { verdict: 'none', findings: [], summary: '尚无验收记录', at: null, round: null, consumed: false, driverAlive, driverPid }
  }
}
