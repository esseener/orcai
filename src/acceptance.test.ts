import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acceptanceReview } from './acceptance'
import type { OrcaWorkerApi } from 'orca/worker'

test('manual acceptance: failing checkCmd is rework without a judge call', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orzic-manual-'))
  mkdirSync(join(repo, '.git'))
  const orca = {
    storage: {
      get: async () => ({ ocr: false, checkCmd: 'exit 1', autoReview: false, autoRework: false, maxRework: 3, criteria: '必须通过检查。' }),
    },
  } as unknown as OrcaWorkerApi
  const result = await acceptanceReview(orca, { repo })
  assert.equal(result.verdict, 'rework')
  assert.match(result.summary, /check 失败/)
  assert.equal(result.findings[0]?.severity, 'high')
})
