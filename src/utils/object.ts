export type PlainObject = Record<string, unknown>

export function typeOf(value: unknown): string {
  return value === null || value === undefined
    ? String(value)
    : Object.prototype.toString.call(value).match(/\[object (\w+)\]/)![1]!.toLowerCase()
}

export function isPojo(value: unknown): value is PlainObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

// Recursive merge for plain objects. Arrays are shallow-copied over;
// `undefined` values in `from` never overwrite `to`.
export function objectMerge<T extends object>(to: T, from: object = {}): T {
  const target = to as PlainObject
  const source = from as PlainObject

  for (const key of Object.keys(source)) {
    const toVal = target[key]
    const fromVal = source[key]

    if (toVal === fromVal) continue

    if (isPojo(toVal) && isPojo(fromVal)) {
      objectMerge(toVal, fromVal)
    } else if (toVal === undefined && isPojo(fromVal)) {
      const fresh: PlainObject = {}
      target[key] = fresh
      objectMerge(fresh, fromVal)
    } else if (fromVal !== undefined) {
      target[key] = Array.isArray(fromVal) ? [...fromVal] : fromVal
    }
  }

  return to
}
