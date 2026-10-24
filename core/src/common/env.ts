/**
 * 环境变量读取的唯一姿势。
 *
 * 为什么需要它：docker-compose 里写 `SIME_ADMIN_PASSWORD: ${SIME_ADMIN_PASSWORD:-}`
 * 时，宿主没定义该变量会把**空字符串**注入容器，而 `process.env.X ?? 默认值`
 * 对空字符串不生效（?? 只拦 null/undefined）——结果就是"密码默认值被空串覆盖，
 * 谁都登不进来"。K8s 的 ConfigMap/Secret 未填 key 时同样是空串。
 *
 * 现网真实事故：2026-10-20 的控制台无法登录即此原因。凡是有默认值的变量，
 * 一律走 envStr/envNum，把空串等价于未设置。
 */
export function envStr(name: string, dflt: string): string;
export function envStr(name: string): string | undefined;
export function envStr(name: string, dflt?: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const v = raw.trim();
  return v === '' ? dflt : v;
}

/** 空串/非法数字/非正数一律回落到默认值（并用 lower/upper 夹住范围）。 */
export function envNum(name: string, dflt: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  // 注意：不能写 Number(envStr(name, '')) —— 空串的 Number('') 是 0（有限数），会把默认值顶掉
  const s = envStr(name);
  if (s === undefined) return dflt;
  const v = Number(s);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(Math.max(v, min), max);
}

/** 布尔：'0'/'false'/'off'/'no' 为假，'1'/'true'/'on'/'yes' 为真，空串取默认。 */
export function envBool(name: string, dflt: boolean): boolean {
  const v = envStr(name);
  if (v === undefined) return dflt;
  const s = v.toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return dflt;
}
