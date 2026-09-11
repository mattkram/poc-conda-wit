import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // All tests run in Node — crypto.subtle is available in Node 18+,
    // which covers the current pure-function test suite.
    // Add a Workers-runtime test dependency later only if integration tests
    // actually need it.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
