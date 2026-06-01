import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import viteCompression from 'vite-plugin-compression';

export default defineConfig({
  plugins: [
    react(),
    // Gzip compression
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
    }),
    // Brotli compression
    viteCompression({
      algorithm: 'brotliCompress',
      ext: '.br',
    }),
    // Bundle analyzer (only in analyze mode)
    process.env.ANALYZE && visualizer({
      open: true,
      filename: 'dist/stats.html',
      gzipSize: true,
      brotliSize: true,
    }),
  ].filter(Boolean),

  base: '/',

  // Vitest — unit tests for the deterministic trading/alpha engines.
  // Node environment: the tested modules are pure (no DOM at import time).
  test: {
    environment: 'node',
    include: ['src/**/*.test.js', 'server/**/*.test.js'],
    globals: true,
  },

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: process.env.NODE_ENV !== 'production',

    // Optimize chunk splitting
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunks
          'react-vendor': ['react', 'react-dom'],
          'solana-vendor': [
            '@solana/web3.js',
            '@solana/wallet-adapter-base',
            '@solana/wallet-adapter-react',
            '@solana/wallet-adapter-react-ui',
            '@solana/wallet-adapter-wallets',
          ],
          // Separate chunk for icons
          'icons': ['lucide-react'],
        },
        // Optimize chunk file names
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
      // Mark optional dependencies as external if not installed
      external: (id) => {
        // Allow optional Sentry import to fail gracefully
        if (id === '@sentry/react') {
          return false; // Don't mark as external, let dynamic import handle it
        }
        return false;
      },
    },

    // Minification options
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
        pure_funcs: ['console.log', 'console.info', 'console.debug'],
      },
    },

    // Chunk size warnings
    chunkSizeWarningLimit: 1000,

    // CSS code splitting
    cssCodeSplit: true,

    // Asset inlining threshold (10kb)
    assetsInlineLimit: 10240,
  },

  // Optimize dependencies
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@solana/web3.js',
      '@solana/wallet-adapter-react',
      'lucide-react',
    ],
  },

  // Resolve configuration
  resolve: {
    alias: {
      // Add any path aliases here if needed
    },
  },

  // Server configuration for development
  server: {
    port: 3000,
    strictPort: false,
    host: true,
  },

  // Preview server configuration
  preview: {
    port: 4173,
    strictPort: false,
    host: true,
  },
});
