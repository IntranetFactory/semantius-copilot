/**
 * Minimal typings for the plain-JS `@semantius-copilot/core` workspace package — ONLY the
 * symbols the frontend actually imports (src/pages.ts). The package's full
 * surface is typed by JSDoc for the backend; the frontend deliberately stays
 * off it (the copyable components/ai-elements/ folder imports nothing from
 * it), so this file should never need to grow much.
 */
declare module '@semantius-copilot/core' {
  /** Naming rule shared by agent names and skill names (core/src/bundle.js). */
  export const SKILL_NAME_RE: RegExp;
}
