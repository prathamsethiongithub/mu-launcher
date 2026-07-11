/** @type {import('tailwindcss').Config} */
/* EMBER design system — all values flow from CSS variables in index.css.
   Legacy mu-* keys are kept mapped so older class usages still resolve. */
module.exports = {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Segoe UI Variable Display"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        sans: ['"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Mono"', '"Cascadia Code"', 'Consolas', 'ui-monospace', 'monospace'],
      },
      colors: {
        ground: 'var(--ground)',
        elevated: 'var(--elevated)',
        ink: 'var(--ink)',
        dim: 'var(--dim)',
        faint: 'var(--faint)',
        ember: 'var(--ember)',
        'ember-deep': 'var(--ember-deep)',
        ok: 'var(--ok)',
        danger: 'var(--danger)',
        // Legacy aliases (do not use in new code)
        mu: {
          primary: 'var(--ember)',
          'primary-dark': 'var(--ember-deep)',
          accent: 'var(--ember-deep)',
          ink: 'var(--ink)',
          muted: 'var(--dim)',
          background: 'var(--ground)',
          surface: 'var(--elevated)',
          border: 'var(--line)',
          success: 'var(--ok)',
          error: 'var(--danger)',
        },
      },
      borderColor: {
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
      },
      transitionTimingFunction: {
        exit: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      transitionDuration: {
        micro: '120ms',
        state: '300ms',
        scene: '600ms',
      },
    },
  },
  plugins: [],
};
