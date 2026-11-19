import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Frontend unit/component tests. jsdom only: no network; fetch and XMLHttpRequest are mocked in the tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
})
