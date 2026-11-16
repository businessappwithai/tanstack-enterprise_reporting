import { defineConfig, loadEnv } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import path from 'path'

// The feature flags in src/lib/feature-flags.ts read `process.env.NEXT_PUBLIC_*` in code that
// also runs in the browser, and Vite does not put process.env in the client bundle. The flags
// were therefore always false in the browser while the server render saw them set — a
// hydration mismatch, and no way to switch on anything they gate (the Datasets page said
// "WASM mode is not enabled" with NEXT_PUBLIC_WASM_ENABLED=true). Substituting the five flags
// at build time, in the client and server bundles alike, makes both read the same value: the
// one in the environment (or .env) when `vite dev` / `vite build` runs, so a Docker build
// needs them as build arguments. Only the flags are substituted: other NEXT_PUBLIC_ variables
// are read by the server at run time and must stay that way.
const FEATURE_FLAGS = [
  'NEXT_PUBLIC_WASM_ENABLED',
  'NEXT_PUBLIC_ECHARTS_ENABLED',
  'NEXT_PUBLIC_CROSSFILTER_ENABLED',
  'NEXT_PUBLIC_OFFLINE_ENABLED',
  'NEXT_PUBLIC_PROGRESSIVE_ENABLED',
]

const featureFlagDefines = (mode: string): Record<string, string> => {
  const fromFiles = loadEnv(mode, process.cwd(), 'NEXT_PUBLIC_')
  return Object.fromEntries(
    FEATURE_FLAGS.map((name) => [
      `process.env.${name}`,
      JSON.stringify(process.env[name] ?? fromFiles[name] ?? ''),
    ])
  )
}

export default defineConfig(({ mode }) => ({
  define: featureFlagDefines(mode),
  plugins: [
    tanstackStart(),
    viteReact(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
  server: {
    port: 4050,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    rollupOptions: {
      output: {
        // DuckDB's .wasm bundles were once served as application/octet-stream (fixed in
        // server-static-wrapper.mjs), under `Cache-Control: immutable` for a year. Their
        // names are content hashes and the bytes did not change, so any browser or CDN that
        // fetched one then could keep the refused copy. A name of their own gives them new
        // URLs, so those entries are never asked for again; caching stays immutable.
        assetFileNames: (asset) =>
          (asset.names ?? []).some((name) => name.endsWith('.wasm'))
            ? 'assets/[name]-[hash].app.wasm'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  ssr: {
    noExternal: ['@tanstack/react-router', '@tanstack/react-start', /^@radix-ui/],
    // better-auth must NOT be bundled into the server build.
    //
    // It depends on zod ^4, this application on zod ^3, and both are installed
    // — v4 nested under better-auth, v3 hoisted. Node's resolution gets that
    // right; the bundler flattens it and hands better-auth the hoisted v3,
    // which fails at runtime on `z.looseObject is not a function` — a 500 on
    // every sign-in, from a build that succeeded and a typecheck that passed.
    // Leaving it external keeps the nested resolution that works.
    external: ['better-auth'],
  },
}))
