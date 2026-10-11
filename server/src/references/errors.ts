export class ReferenceError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function requiredText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new ReferenceError(400, "invalid_input", `${label}不能为空，且不能超过 ${max} 字`);
  }
  return value.trim();
}
export function optionalText(value: unknown, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max) throw new ReferenceError(400, "invalid_input", "文本字段格式或长度不合法");
  return value.trim();
}
