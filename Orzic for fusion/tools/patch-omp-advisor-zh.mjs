#!/usr/bin/env bun
/**
 * Patch the installed OMP bundle so the advisor card in the terminal reads in
 * Chinese: fixed labels only. Advisor note bodies come from the model and are
 * controlled by ~/.omp/agent/WATCHDOG.md.
 *
 * OMP has no locale switch for these labels; they are literals in
 * dist/cli.js. The bundle cannot carry raw CJK literals: at render time they
 * come out double-encoded (UTF-8 bytes displayed as Latin-1), so every
 * replacement below is written as \uXXXX escapes. Advisor note bodies from
 * the transcript are unaffected.
 *
 * Upgrading OMP restores the English strings, so re-run:
 *
 *   bun "Orzic for fusion/tools/patch-omp-advisor-zh.mjs"
 *   bun "Orzic for fusion/tools/patch-omp-advisor-zh.mjs" --restore
 *   bun "Orzic for fusion/tools/patch-omp-advisor-zh.mjs" --check
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const bundle = join(
  process.env.BUN_INSTALL || join(homedir(), ".bun"),
  "install",
  "global",
  "node_modules",
  "@oh-my-pi",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const backup = `${bundle}.zh-backup`;

/** ASCII-only form of a replacement; CJK as \uXXXX so the bundle stays ASCII. */
const esc = (s) =>
  s.replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);

// Each entry lists the raw patterns it may replace (English original, or a
// previously patched raw-CJK variant) and the desired text before escaping.
const TARGETS = [
  {
    from: ["a=[`${o.length} ${o.length===1?\"note\":\"notes\"}`]", "a=[`${o.length} 条建议`]"],
    to: "a=[`${o.length} 条建议`]",
  },
  {
    from: ['n.fg("error",`${s} blocker${s===1?\"\":\"s\"}`)', 'n.fg("error",`${s} 个阻断`)'],
    to: 'n.fg("error",`${s} 个阻断`)',
  },
  {
    from: ['status.info")} Advisor\\x1B[22m', 'status.info")} 顾问\\x1B[22m'],
    to: 'status.info")} 顾问\\x1B[22m',
  },
  {
    from: [
      '`\\u2026 +${p} more ${p===1?\"note\":\"notes\"}`',
      '`\\u2026 还有 ${p} 条`',
    ],
    to: '`\\u2026 还有 ${p} 条`',
  },
  {
    from: ['{t:i.size===1&&s?s:\"Advisor\",s:\"dim\"}', '{t:i.size===1&&s?s:\"顾问\",s:\"dim\"}'],
    to: '{t:i.size===1&&s?s:\"顾问\",s:\"dim\"}',
  },
  {
    from: [
      't.push({t:`${r} ${n}${r===1?\"\":\"s\"}`,s:a0n[n].style})',
      't.push({t:`${r} ${({blocker:\"个阻断\",concern:\"项关注\",nit:\"条提示\",note:\"条建议\"})[n]}`,s:a0n[n].style})',
    ],
    to: 't.push({t:`${r} ${({blocker:"个阻断",concern:"项关注",nit:"条提示",note:"条建议"})[n]}`,s:a0n[n].style})',
  },
  { from: ['uQr(r.length,\"note\")', '`${r.length} 条建议`'], to: "`${r.length} 条建议`" },
  { from: ['uQr(o,\"blocker\")', '`${o} 个阻断`'], to: "`${o} 个阻断`" },
  { from: ['label:\"Blocker\",style:\"error strong\"', 'label:\"阻断\",style:\"error strong\"'], to: 'label:"阻断",style:"error strong"' },
  { from: ['label:\"Concern\",style:\"warning strong\"', 'label:\"关注\",style:\"warning strong\"'], to: 'label:"关注",style:"warning strong"' },
  { from: ['label:\"Nit\",style:\"strong\"', 'label:\"提示\",style:\"strong\"'], to: 'label:"提示",style:"strong"' },
  { from: ['label:\"Note\",style:\"strong\"', 'label:\"备忘\",style:\"strong\"'], to: 'label:"备忘",style:"strong"' },
  { from: ['return{name:\"advisor\",title:\"Advisor\"', 'return{name:\"advisor\",title:\"顾问\"'], to: 'return{name:"advisor",title:"顾问"' },
];

const mode = process.argv[2] || "";
if (!existsSync(bundle)) {
  console.error(`未找到 OMP bundle：${bundle}`);
  process.exit(1);
}

if (mode === "--restore") {
  if (!existsSync(backup)) {
    console.error(`没有备份：${backup}`);
    process.exit(1);
  }
  copyFileSync(backup, bundle);
  console.log(`已还原 ${bundle}`);
  process.exit(0);
}

let source = readFileSync(bundle, "utf8");
const done = TARGETS.filter((t) => source.includes(esc(t.to)));
const pending = TARGETS.filter((t) => !source.includes(esc(t.to)) && t.from.some((f) => source.includes(f)));

if (mode === "--check") {
  console.log(`已替换 ${done.length}/${TARGETS.length} 处；${pending.length} 处待补。`);
  process.exit(pending.length === 0 ? 0 : 1);
}

if (done.length === TARGETS.length) {
  console.log(`已是中文标签：${done.length}/${TARGETS.length}`);
  process.exit(0);
}

if (!existsSync(backup)) {
  copyFileSync(bundle, backup);
  console.log(`已备份 ${backup}`);
}

for (const target of TARGETS) {
  if (source.includes(esc(target.to))) continue;
  const replacement = esc(target.to);
  const from = target.from.find((candidate) => source.includes(candidate));
  if (!from) continue;
  source = source.replace(from, replacement);
}
writeFileSync(bundle, source);
const left = TARGETS.filter((t) => !source.includes(esc(t.to))).length;
console.log(`已替换 ${TARGETS.length - left} 处${left ? `，仍有 ${left} 处未匹配` : ""}。`);
console.log("重启 OMP（或 /restart）后生效；升级 OMP 后重新运行本脚本。");
