## Packages
framer-motion | Essential for cyberpunk animations and page transitions
lucide-react | Icon set (already in base but vital for this aesthetic)
clsx | Utility for conditional classes
tailwind-merge | Utility for merging tailwind classes

## Notes
Tailwind Config - extend fontFamily:
fontFamily: {
  display: ["var(--font-display)"],
  body: ["var(--font-body)"],
  mono: ["var(--font-mono)"],
}
Colors need to support HSL variables defined in index.css for the neon theme.
