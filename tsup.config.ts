import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  // Zdroják je ESM + TS. Emitujeme oba formáty:
  //   dist/index.js  (ESM) — vývoj a `npm start`
  //   dist/index.cjs (CJS) — vstup pro @yao-pkg/pkg v P7; pkg má s ESM historicky problémy.
  format: ['esm', 'cjs'],
  target: 'node20',
  platform: 'node',
  clean: true,
  sourcemap: true,
  splitting: false,
  dts: false,
  // import.meta.url is polyfilled into the CJS output; focus.ts needs it for
  // createRequire, which is the only koffi loader that survives pkg.
  shims: true,
  // koffi loads a prebuilt .node binary; bundling it would break the load path.
  external: ['koffi'],
});
