// Editable defaults for the acceptance judge. They are shown in the panel and
// sent with the judge prompt; they are not a hard gate by themselves.
export const DEFAULT_ACCEPTANCE_CRITERIA = [
  '必须通过项目已有的类型检查、测试和构建命令。',
  '不得引入未捕获异常、静默失败或安全降级。',
  '不得删除或绕过已有校验来让测试通过。',
  '实现必须与已批准的计划一致；偏离计划要说明。',
  '新增或修改的行为要有可复现的验证。',
].join('\n')
