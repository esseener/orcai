// Shared verdict parsing for the orzic acceptance loop.
// Rule: a judge/run failure or missing/invalid verdict is NEVER a pass —
// absence of evidence is reported as 'failed', not 'pass'.

/** Parse `omp --mode json` stdout into a normalized review result. */
export function verdictFromOutput(out, { error = null, model = '' } = {}) {
  const at = new Date().toISOString()
  if (error) return { at, verdict: 'failed', findings: [], summary: `judge 失败:${String(error).slice(0, 200)}` }
  if (typeof out !== 'string' || !out.trim()) return { at, verdict: 'failed', findings: [], summary: 'judge 无输出' }
  let verdictText = ''
  for (const line of out.split('\n')) {
    if (!line.includes('"message_end"')) continue
    try { const e = JSON.parse(line); if (e.type === 'message_end' && e.message?.role === 'assistant') verdictText = (e.message.content ?? []).map((c) => c.text ?? '').join('') } catch { /* skip */ }
  }
  if (!verdictText.trim()) return { at, verdict: 'failed', findings: [], summary: 'judge 输出无 message_end' }
  let d
  try { d = JSON.parse(verdictText) } catch { return { at, verdict: 'failed', findings: [], summary: 'judge 输出无法解析' } }
  const findings = (d.findings ?? []).flatMap((f) => (f.file ?? f.path) ? [{ severity: f.severity ?? 'info', file: f.file ?? f.path ?? '', line: f.line ?? null, message: f.message ?? '' }] : [])
  const blocker = findings.some((f) => /blocker|critical|high|error/i.test(f.severity))
  // 只认显式 pass;其他一切(rework/blocker/未知/缺 verdict)都不当 pass。
  const verdict = blocker || d.verdict === 'rework' ? 'rework' : d.verdict === 'pass' ? 'pass' : 'failed'
  return { at, verdict, findings, summary: `${findings.length} findings(omp ${String(model).split('/').pop() || 'judge'})` }
}
