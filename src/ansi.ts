// 极简 ANSI 着色工具：零依赖实现，非 TTY 时自动退化为纯文本。
// 用途：让 CLI 输出有层次（思考=暗灰、工具卡片=青、错误=红），但绝不依赖终端支持。

/** 判断当前 stdout 是否支持颜色（非 TTY、CI 环境一律关闭） */
function supportsColor(): boolean {
  // 显式 NO_COLOR 约定优先
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  // Node 的 isTTY 在管道/重定向时为 false
  return Boolean(process.stdout.isTTY);
}

const enabled = supportsColor();

/** 包装 ANSI 代码；颜色被禁用时原样返回，保证输出内容不变 */
function wrap(code: string, s: string): string {
  // 禁用状态直接返回，避免把转义序列写进日志文件
  if (!enabled) {
    return s;
  }
  return `\u001b[${code}m${s}\u001b[0m`;
}

/** 暗灰色：思考内容、用量统计等次要信息 */
export function dim(s: string): string {
  return wrap("2", s);
}

/** 青色：工具卡片、状态行 */
export function cyan(s: string): string {
  return wrap("36", s);
}

/** 红色：错误、拒绝、熔断 */
export function red(s: string): string {
  return wrap("31", s);
}

/** 绿色：成功标记 */
export function green(s: string): string {
  return wrap("32", s);
}

/** 黄色：警告、确认提示 */
export function yellow(s: string): string {
  return wrap("33", s);
}
