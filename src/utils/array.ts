export function dedup<T>(arr: readonly T[]): T[] {
  return Array.from(new Set(arr))
}

export function remove<T>(
  arr: T[],
  target: T | ((value: T) => boolean),
): T[] | null {
  const index =
    typeof target === 'function'
      ? arr.findIndex(target as (value: T) => boolean)
      : arr.indexOf(target)

  if (index >= 0) {
    return arr.splice(index, 1)
  }

  return null
}

export function groupBy<T>(
  arr: readonly T[],
  iteratee: string | ((value: T) => string | number),
): Record<string, T[]> {
  let keyOf: (value: T) => string | number

  if (typeof iteratee === 'string') {
    const field = iteratee
    keyOf = (value) => value[field as keyof T] as string | number
  } else {
    keyOf = iteratee
  }

  if (typeof keyOf !== 'function') {
    throw new TypeError('groupBy iteratee must be a String or a Function')
  }

  const groups: Record<string, T[]> = {}

  for (const value of arr) {
    const key = String(keyOf(value))
    const group = groups[key]

    if (group === undefined) {
      groups[key] = [value]
    } else {
      group.push(value)
    }
  }

  return groups
}
