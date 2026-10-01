# deltic example

A minimal project using the recommended `preset()` — js / json / json5 tasks
plus alias and env substitution.

## Run

```bash
# from the repository root
pnpm build
pnpm link --global   # or pack & install deltic into this folder

cd example
deltic init          # (optional) inspect a fresh config template
deltic build         # one-off compile → dist/
deltic dev           # compile, then watch src/
deltic build --profile   # show the slowest pipes/files
```

Expected output after `deltic build`:

```
dist/js/entry.js     ← alias rewritten to './lib', API_URL inlined
dist/js/lib.js
dist/data/config.json5 → dist/data/config.json (normalized)
```

`.deltic/` holds the compile cache, dependency graph and file list — commit
it or add `/.deltic/` to your `.gitignore`.
