# Smart Quiz Agent - Architecture & Implementation Plan

This document provides full context for any developer or AI agent picking up this project. It covers the architecture, implementation details, design decisions, and current state.

---

## Project Overview

Smart Quiz Agent is an AI-powered quiz management platform for educational institutions. It was built by enhancing a basic quiz CRUD system with 6 phases of competitive features modeled after Kahoot, Quizizz, Quizlet, and other leading platforms.

## How to Run

```bash
# Start PostgreSQL
docker-compose up -d

# Run the app (from project root)
cd agent
DATABASE_URL="postgresql://postgres:admin@localhost:5433/quiz_db" npx tsx src/main.ts
```

App runs at `http://localhost:3456`. Migrations and seed data run automatically.

## Key Configuration

- **Database**: PostgreSQL on port `5433` (Docker), database `quiz_db`, user `postgres`, password `admin`
- **App Port**: `3456`
- **JWT Secret**: Configured in `main.ts`
- **AI**: Anthropic Claude via Agent SDK + MCP tools

---

## Architecture

### File Map

| File | Purpose | Lines (approx) |
|------|---------|------|
| `agent/src/main.ts` | Express server, 45+ API routes, gamification logic, live quiz SSE, auth | ~1500 |
| `agent/ui.html` | Full SPA frontend — all pages, components, styles, JS | ~2200 |
| `agent/src/db/schema.ts` | Drizzle ORM schema — 13 tables with relations and indexes | ~200 |
| `agent/src/db/seed.ts` | Seeds 3 demo users + student profiles | ~80 |
| `agent/src/tools/quiz-generator.ts` | MCP tool for AI quiz generation | ~150 |
| `agent/src/tools/quiz-evaluator.ts` | MCP tool for AI answer evaluation | ~100 |
| `agent/src/tools/analytics.ts` | MCP tool for AI performance analytics | ~100 |
| `agent/src/prompts.ts` | AI system prompts for the agent | ~50 |

### Database Tables (13)

```
organizations          - Schools/institutions (name, type, address)
users                  - All users (email, password_hash, role, organization_id)
topics                 - Subject topics (title, subject, grade_level, teacher_id)
materials              - Uploaded PDFs (filename, extracted_text, topic_id)
quizzes                - Quiz definitions (title, type, status, time_limit, pass_percentage)
questions              - Quiz questions (type, options, correct_answer, marks, explanation, difficulty)
quiz_attempts          - Student attempts (score, status, started_at, submitted_at)
student_answers        - Individual answers (is_correct, marks_awarded, ai_feedback)
enrollments            - Student-organization mappings
conversations          - AI chat sessions (user_id, topic_id)
messages               - Chat messages (role, content, conversation_id)
student_profiles       - Gamification data (xp_total, level, streaks, badges)
leaderboard_entries    - Rankings by period (weekly, monthly, all_time)
```

### Authentication

- JWT-based with `authMiddleware` extracting user from `Authorization: Bearer <token>` header
- Passwords hashed with bcrypt (10 rounds)
- Role-based middleware: `roleMiddleware("admin")`, `roleMiddleware("teacher")`
- SSE endpoints accept token via `?token=` query param (EventSource can't set headers)

### Frontend Architecture

The frontend is a vanilla JS SPA in a single `ui.html` file served at `/`. Key patterns:

- **Routing**: `navigate(page)` function switches between renderers
- **State**: `currentUser`, `token`, `currentPage` globals
- **API calls**: `api(url, options)` helper that auto-adds auth headers
- **Rendering**: Each page has an `async function renderXxx()` that fetches data and sets `innerHTML`
- **Modals**: `showModal(title, content)` / `closeModal()` pattern
- **Toasts**: `showToast(message, type)` for notifications

### Design System

- **Font**: Inter (Google Fonts)
- **Colors**: Indigo primary (`#6366f1`), light sidebar, CSS custom properties
- **Cards**: White with subtle border + box-shadow
- **Dark mode**: `.dark` class on `<html>`, CSS variable overrides
- **Responsive**: `768px` and `480px` breakpoints, mobile bottom nav + sheet

---

## Implementation Details

### Phase 1: Gamification Engine

**XP Awards** (in quiz submit handler):
- Quiz completion: +50 XP
- Per correct answer: +10 XP
- Perfect score: +100 XP
- Streak bonus (3+ days): +25 XP
- First attempt: +20 XP
- Speed bonus (<50% time): +30 XP

**Level formula**: `level = floor(sqrt(xp_total / 100)) + 1`

**8 Badges**: first_steps, on_fire (3-day streak), week_warrior (7-day), perfect_score, quiz_master (10 quizzes), subject_expert (80%+ avg in subject), speed_demon (<50% time), comeback_kid (80%+ after <40%).

**Leaderboard**: Updated on quiz submit. Queries `leaderboard_entries` table filtered by `period` and `period_key` (e.g., `weekly` + `2026-W07`).

### Phase 2: Live Quiz Mode

**Server-Sent Events** infrastructure:
- In-memory `Map<joinCode, LiveSession>` stores session state
- Teacher POSTs to `/api/quizzes/:id/start-live` → generates 6-digit code
- Students GET `/api/live/:code/stream` → SSE connection
- Events pushed: `waiting`, `question`, `results`, `ended`
- Each question has a timer; server scores immediately on answer

**Flow**: Teacher starts → students join → teacher clicks Next → question pushed to all → students answer → results pushed → repeat → final leaderboard.

### Phase 3: Enhanced Quiz UX

- One-question-at-a-time with `quizState` object tracking `currentIndex`
- Progress dots for navigation
- Instant feedback after each answer (practice mode)
- Animated score reveal with count-up
- Confetti animation on perfect score (CSS-only)
- Level-up overlay when XP threshold crossed

### Phase 4: Question Types

6 types supported in `questions.question_type`:
- `mcq` — 4 options, one correct (stored as `string[]`)
- `true_false` — 2 options
- `short_answer` — Free text, AI-evaluated
- `fill_in_blank` — `{ sentence, acceptable[] }` in options jsonb
- `matching` — `{ pairs: [{left, right}] }` in options jsonb
- `ordering` — `{ items[], correct_order[] }` in options jsonb

Evaluation logic in quiz submit handler handles each type differently (exact match, acceptable answers array, pair matching with partial credit, order comparison).

### Phase 5: Teacher Analytics

- `GET /api/analytics/quiz/:id/questions` returns per-question stats
- Frontend renders difficulty bar chart, question details table, student heatmap
- Struggling students alert: scores <40% on recent quizzes
- CSV export of analytics data

### Phase 6: Polish

- Dark mode via CSS custom properties with `.dark` class toggle
- Toast notifications (CSS-only animation, auto-dismiss 4s)
- Skeleton loading states
- Mobile bottom nav (4 items + More button)
- Mobile "More" sheet with profile, extra nav, dark mode, logout
- Completion certificates (HTML rendered at `/api/certificates/:attemptId`)
- Daily challenge (rotating quiz based on date hash)

---

## Recent Changes (Latest Session)

1. **Organization management** — Admin can manage org members, assign teachers, enroll students
2. **Sticky sidebar** — Left panel fixed, right panel scrolls independently
3. **Mobile responsive** — Bottom nav, responsive grids, mobile-optimized sizing
4. **Mobile "More" menu** — Bottom sheet with profile, extra nav items, dark mode, logout
5. **Table horizontal scroll** — Quiz performance table scrolls within card on mobile
6. **Dark mode form styling** — Inputs/selects properly styled in dark mode
7. **Design language overhaul** — Refined color palette, Inter font, lighter weights, subtle shadows, soft badges
8. **Light sidebar** — White sidebar matching content area, section labels, rounded nav items
9. **Profile page** — View/edit name, email, password; activity stats for students; preferences
10. **Profile edit API** — `PUT /api/auth/profile` with validation
11. **Presentation files** — Markdown doc + HTML slide deck (11 slides)

---

## Known Patterns & Gotchas

1. **Single HTML file**: All frontend code is in `ui.html`. Search by function name (e.g., `renderDashboard`, `renderProfile`).
2. **CSS is at the top** of `ui.html` (lines 1-420). Responsive styles are in `@media` blocks.
3. **Mobile sheet overlay** must have `display: none` OUTSIDE the media query to stay hidden on desktop.
4. **Variable scope**: Avoid duplicate `const` declarations in `buildSidebar()` — it declares `initials` once for both sidebar avatar and mobile sheet.
5. **SSE auth**: LiveQuiz SSE endpoint reads token from `?token=` query param since EventSource can't set headers.
6. **Port**: App runs on `3456`, not `3000`. Database on `5433`, not `5432`.
7. **Migrations**: Run automatically on startup via `migrate.ts`. Generate new ones with `npx drizzle-kit generate`.
8. **Seed data**: Only seeds if no users exist. 3 demo users: admin, teacher, student (all password: `password`).

---

## Future Roadmap

- [ ] Adaptive difficulty (AI adjusts based on student performance)
- [ ] Group quiz mode (team competitions)
- [ ] Parent/guardian dashboard
- [ ] LMS integrations (Google Classroom, Canvas, Moodle)
- [ ] Multi-language support
- [ ] Question bank sharing across teachers
- [ ] Video question support
- [ ] Push notifications for streaks and challenges

---

## Author

**Aryan Kale**

Built with Express.js, TypeScript, PostgreSQL, and Anthropic Claude AI.
