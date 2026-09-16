import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    resolve: {
      alias: [
        { find: '@', replacement: resolve(__dirname, 'src') },
        // THREE DEDUPE (Session 10B): skinview3d pins three@0.156.0 while the
        // app uses three@0.185.1, so npm nests a second copy and the bundle
        // shipped BOTH. The nested r156 WebGLRenderer calls
        // material.onBuild() during program compilation — an API removed in
        // r185 — so the first r185 material in the scene (Session 10's stage
        // floor) crashed getProgram() on frame one, draw() died before its
        // reschedule line, and the loop froze with a stale animationID
        // (renderPaused=false then can never re-arm: its resume branch
        // requires animationID == null). Force the WHOLE bundle onto the
        // root three: bare specifier + the examples/jsm subpath (OrbitControls
        // must not stay on the nested copy either). skinview3d's dist uses no
        // r156-only legacy APIs, so it runs cleanly against r185.
        { find: /^three$/, replacement: resolve(__dirname, 'node_modules/three/build/three.module.js') },
        { find: /^three\/examples\/jsm\/(.*)$/, replacement: resolve(__dirname, 'node_modules/three/examples/jsm/$1') },
      ],
    },
    plugins: [react()],
  },
});
