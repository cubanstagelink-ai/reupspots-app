# THE RE-UP SPOTS

## Overview

The Re-Up Spots (formerly Relayo) is a cyberpunk-themed marketplace that connects performers (musicians, dancers, comedians, models, actors) with promoters and venue owners. The platform positions itself as a "0% commission" marketplace where talent payments flow directly via Cash App between parties. Revenue is generated through credits (consumed when posting, applying, boosting), verification fees, boosted visibility tiers, and subscription plans (Free, Pro, Elite).

The app is a full-stack TypeScript monorepo with a React frontend (Vite), Express backend, PostgreSQL database (Drizzle ORM), and Replit Auth (OpenID Connect) for authentication.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Monorepo Structure
- `client/` — React SPA (Vite, TypeScript, Tailwind CSS)
- `server/` — Express API server
- `shared/` — Shared schemas, types, constants, and business logic used by both client and server
- `migrations/` — Drizzle-generated database migrations
- `script/` — Build tooling (esbuild for server, Vite for client)
- `attached_assets/` — Reference documents and design specs

### Frontend (client/)
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight client-side router)
- **State/Data**: TanStack React Query for server state management
- **UI Components**: shadcn/ui (Radix primitives + Tailwind CSS), custom `CyberButton` component
- **Animations**: Framer Motion for page transitions and scroll animations
- **Styling**: Tailwind CSS with a cyberpunk neon theme using HSL CSS variables. Three custom font families: Orbitron (display/headings), Rajdhani (body), Space Mono (monospace)
- **Pages**: Feed (opportunity listings), Profiles (talent directory), ProfileDetail (individual talent + booking flow + reviews), MyProfile (user dashboard with credits/bookings/media uploads), Rules (platform protocols), Terms (TOS), Privacy (privacy policy), Verification (ID verification), Messages (direct messaging), BuyCredits (Stripe credit purchase), Feedback (contact hub), OpportunityDetail (full post details with contact/address/directions), PosterProfile (host info + their listings + reviews/likes/dislikes + follow button), Posters (host directory with follow/unfollow, category filters, search), AdminDashboard (admin-only platform stats and management), 404
- **Path aliases**: `@/` → `client/src/`, `@shared/` → `shared/`, `@assets/` → `attached_assets/`

### Backend (server/)
- **Framework**: Express.js with TypeScript
- **Database**: PostgreSQL via `node-postgres` (pg Pool)
- **ORM**: Drizzle ORM with Zod schema validation (`drizzle-zod`)
- **Auth**: Replit Auth via OpenID Connect (passport + express-session with connect-pg-simple session store). Auth files live in `server/replit_integrations/auth/` — these are critical and should not be modified casually.
- **Storage Pattern**: `IStorage` interface in `server/storage.ts` with `DatabaseStorage` implementation. All database operations go through this abstraction.
- **API Design**: REST endpoints under `/api/`. Route definitions are shared between client and server via `shared/routes.ts` which defines paths, methods, and Zod input/output schemas.
- **Build**: Production build uses esbuild to bundle the server into `dist/index.cjs`, and Vite to build the client into `dist/public/`. Dev mode uses `tsx` for the server and Vite dev server with HMR.

### Database Schema (shared/schema.ts)
Key tables:
- `users` — Managed by Replit Auth (do NOT modify)
- `sessions` — Managed by Replit Auth session store (do NOT modify)
- `profiles` — Performer/talent profiles with category, tier, rate, Cash App handle, verification status, subscription plan
- `posts` — Opportunity listings (gigs) with tier, category, pay, venue, boost level, boost expiry
- `bookings` — Booking records with status flow: pending_payment → payment_submitted → deposit_paid → confirmed/cancelled
- `reviews` — Bidirectional review/rating system (likes/dislikes with optional comments) targeting both poster and talent profiles via targetType field
- `credits` — User credit balances
- `creditLogs` — Audit trail for credit transactions
- `verification_requests` — ID verification submissions with status (pending/approved/rejected), admin review
- `messages` — Direct messages between users with read tracking
- `follows` — Follower/following relationships between users (followerUserId, followedUserId)
- `notifications` — User notification alerts (type, title, message, linkUrl, read status) triggered when followed posters create new posts
- `tos_acceptances` — Terms of Service acceptance records per user
- `stripe.*` — Stripe-managed schema (products, prices, customers) via stripe-replit-sync

### Business Logic (shared/)
- `shared/schema.ts` — Constants: TIERS, CATEGORIES, PLANS, BOOSTS, TIER_FEES, BOOST_FEES, CREDIT_COSTS, ADMIN_EMAILS
- `shared/pricing.ts` — Total calculation (base pay + tier fee + boost fee), boost expiry logic
- `shared/credits.ts` — Credit cost lookups for posting, boosting, applying; affordability checks
- `shared/subscriptions.ts` — Plan details (Free/Pro/Elite) with feature flags (unlimited posts, boost access, auto-verification)

### Key Design Decisions
1. **0% commission model with credit monetization** — Users don't pay commission on talent payments, but consume credits to post opportunities, apply to gigs, boost visibility, and get verified. This is the core revenue model.
2. **Booking gate pattern** — Direct payment links are never exposed upfront. Users must first create a booking (status: pending_payment), then the Cash App payment link is revealed.
3. **Shared route definitions** — `shared/routes.ts` defines API contracts with Zod schemas, enabling type-safe API calls on both sides.
4. **Theme preservation is critical** — The cyberpunk neon aesthetic (hot pink primary, cyan accent, deep purple backgrounds, Orbitron/Rajdhani fonts) must not be changed when modifying functionality.

## External Dependencies

### Database
- **PostgreSQL** — Primary data store, connection via `DATABASE_URL` environment variable
- **Drizzle ORM** — Schema definition and query builder; migrations via `drizzle-kit push`

### Authentication
- **Replit Auth (OpenID Connect)** — User authentication via `ISSUER_URL` and `REPL_ID` environment variables
- **express-session + connect-pg-simple** — Session persistence in PostgreSQL `sessions` table
- **passport** — Authentication middleware with OpenID Connect strategy

### Payment
- **Cash App** — Direct peer-to-peer payments (no API integration; payment links are displayed to users after booking creation)
- **Stripe** — Credit purchasing via Stripe Checkout Sessions. Products seeded via `server/seed-credits.ts`. Webhook handles `checkout.session.completed` events. Frontend calls `/api/stripe/fulfill-credits` after redirect. Schema managed by `stripe-replit-sync`.

### Environment Variables Required
- `DATABASE_URL` — PostgreSQL connection string
- `SESSION_SECRET` — Express session secret
- `REPL_ID` — Replit project identifier (for OIDC)
- `ISSUER_URL` — OpenID Connect issuer (defaults to `https://replit.com/oidc`)

### Frontend Libraries
- React, Vite, TanStack React Query, Wouter, Framer Motion
- shadcn/ui component library (Radix UI primitives)
- Tailwind CSS with custom cyberpunk theme
- lucide-react icons

### Build Tools
- Vite (client bundling)
- esbuild (server bundling for production)
- tsx (TypeScript execution in development)
- drizzle-kit (database migrations)