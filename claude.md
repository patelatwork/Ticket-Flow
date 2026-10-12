## Frontend rules (apps/web)
- Stack: Vite, React, TS strict, TanStack Query, React Router, Tailwind. No component libraries.
- All colors, spacing, radii, and font sizes come from `src/styles/tokens.css` (CSS variables).
  Never hardcode hex values or arbitrary px in components.
- One typeface pairing, defined in tokens. 8px spacing scale. Max 2 accent colors.
- Every data-fetching view must implement loading, empty, error, and conflict states.
- Seat picker: keyboard accessible, ARIA labels on seats, color is never the only state indicator.
- Components: small, typed props, no prop drilling past 2 levels (use context or query cache).
- Responsive: design mobile-first, verify at 375px and 1280px.
- Before declaring any UI task done: run the app, open it with Playwright, screenshot at both
  widths, check the console for errors, and fix what you see.