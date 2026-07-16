/** @type {import('tailwindcss').Config} */
export default {
    darkMode: 'class',
    content: [
      "./index.html",
      "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
      extend: {
        colors: {
          surface: {
            DEFAULT: 'var(--surface)',
            secondary: 'var(--surface-secondary)',
            tertiary: 'var(--surface-tertiary)',
          },
          'on-surface': {
            DEFAULT: 'var(--on-surface)',
            secondary: 'var(--on-surface-secondary)',
            tertiary: 'var(--on-surface-tertiary)',
          },
          outline: {
            DEFAULT: 'var(--outline)',
            secondary: 'var(--outline-secondary)',
          },
          sidebar: {
            DEFAULT: 'var(--sidebar-bg)',
            text: 'var(--sidebar-text)',
            hover: 'var(--sidebar-hover)',
            border: 'var(--sidebar-border)',
          },
          accent: {
            DEFAULT: 'var(--accent)',
            hover: 'var(--accent-hover)',
            text: 'var(--accent-text)',
            soft: 'var(--accent-soft)',
            'soft-text': 'var(--accent-soft-text)',
          },
        },
      },
    },
    plugins: [],
  }
