// Dependency reference matchers shared by the builtin pipes.
// Keep them global-flagged; pipes consume them via String.prototype.matchAll,
// which clones the regex and never leaks lastIndex state.
export const es5ImportReg = /require\(['"](.*?)['"]\)/g
export const es6ImportReg = /(?:from|import)\s+['"](.*?)['"]/g
export const htmlUrlReg = /(?:src|url|poster)=['"](.*?)['"]/g
export const cssImportReg = /@import\s+['"](.*?)['"]/g
export const cssUrlReg = /(?:src|url)\(['"]?(.*?)['"]?\)/g
