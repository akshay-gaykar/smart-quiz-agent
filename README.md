# Smart Quiz Agent

AI-Powered Quiz Management Platform for Education.

Built with Express.js, TypeScript, PostgreSQL, and Anthropic Claude AI.

## Features

- **AI Quiz Generation** - Auto-generate questions from uploaded PDFs and topic descriptions
- **AI Answer Evaluation** - Semantic grading with partial credit and constructive feedback
- **Live Quiz Mode** - Kahoot-style real-time sessions with join codes and live leaderboards
- **Gamification** - XP, levels, 8 badges, streaks, daily challenges, and leaderboards
- **6 Question Types** - MCQ, True/False, Short Answer, Fill-in-Blank, Matching, Ordering
- **Teacher Analytics** - Per-question analytics, student heatmaps, struggling student alerts
- **AI Tutor** - Conversational assistant for personalized student help
- **Organization Management** - Admin manages schools, assigns teachers, enrolls students
- **Profile Management** - Edit name, email, password for all users
- **Dark Mode** - Full light/dark theme support
- **Mobile Responsive** - Bottom navigation bar with "More" drawer on mobile

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express.js 5 + TypeScript |
| AI Engine | Anthropic Claude (Agent SDK + MCP) |
| Database | PostgreSQL + Drizzle ORM |
| Auth | JWT + bcrypt |
| Real-time | Server-Sent Events (SSE) |
| File Processing | Multer + pdf-parse |
| Validation | Zod |
| Frontend | Vanilla JS Single-Page App |

## Prerequisites

- Node.js 18+
- Docker (for PostgreSQL)
- Anthropic API key

## Setup

### 1. Start PostgreSQL

```bash
docker-compose up -d
```

This starts PostgreSQL on port `5433` with database `quiz_db`.

### 2. Configure environment

```bash
cd agent
cp .env.example .env
```

Edit `.env` and set your `ANTHROPIC_API_KEY`.

### 3. Install dependencies

```bash
cd agent
npm install
```

### 4. Run the application

```bash
DATABASE_URL="postgresql://postgres:admin@localhost:5433/quiz_db" npx tsx src/main.ts
```

The app runs at **http://localhost:3456**.

Migrations and seed data run automatically on startup.

## Demo Credentials

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@springfield.edu | password |
| Teacher | teacher@springfield.edu | password |
| Student | student@springfield.edu | password |

## Project Structure

```
smart-quiz-agent/
├── agent/
│   ├── src/
│   │   ├── main.ts              # Express server, all API routes (45+ endpoints)
│   │   ├── prompts.ts           # AI system prompts
│   │   ├── db/
│   │   │   ├── schema.ts        # Drizzle ORM schema (13 tables)
│   │   │   ├── index.ts         # Database connection
│   │   │   ├── migrate.ts       # Migration runner
│   │   │   └── seed.ts          # Demo data seeder
│   │   └── tools/
│   │       ├── index.ts         # Tool exports
│   │       ├── quiz-generator.ts    # AI quiz generation MCP tool
│   │       ├── quiz-evaluator.ts    # AI answer evaluation MCP tool
│   │       └── analytics.ts         # AI analytics MCP tool
│   ├── ui.html                  # Full SPA frontend (single file)
│   ├── drizzle/                 # Database migrations
│   ├── package.json
│   └── tsconfig.json
├── data/
│   └── sample_data.json         # Sample quiz data
├── docker-compose.yml           # PostgreSQL container config
├── presentation.html            # Browser-based slide deck (11 slides)
├── Smart-Quiz-Agent-Presentation.md  # Full markdown presentation
└── PLAN.md                      # Architecture and implementation plan
```

## API Endpoints (45+)

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login, returns JWT token
- `GET /api/auth/me` - Get current user profile
- `PUT /api/auth/profile` - Update name, email, or password

### Topics & Materials
- `POST /api/topics` - Create topic (teacher/admin)
- `GET /api/topics` - List topics
- `POST /api/topics/:id/materials` - Upload PDF with text extraction

### Quizzes
- `POST /api/quizzes` - Create quiz
- `GET /api/quizzes` - List quizzes (role-filtered)
- `GET /api/quizzes/:id` - Get quiz with questions
- `PUT /api/quizzes/:id/publish` - Publish quiz
- `POST /api/quizzes/:id/attempt` - Start attempt (student)
- `POST /api/quizzes/:id/submit` - Submit with AI evaluation

### Gamification
- `GET /api/student-profile` - XP, level, streaks, badges
- `GET /api/leaderboard?period=weekly|monthly|all_time` - Rankings

### Live Quiz (SSE)
- `POST /api/quizzes/:id/start-live` - Start session (teacher)
- `GET /api/live/:code/stream` - SSE real-time stream
- `POST /api/live/:code/join` - Join session (student)
- `POST /api/live/:code/next` - Next question (teacher)
- `POST /api/live/:code/answer` - Submit answer (student)
- `POST /api/live/:code/end` - End session (teacher)

### Analytics
- `GET /api/analytics/quiz/:id/questions` - Per-question stats
- `GET /api/analytics/compare` - Student comparison
- `GET /api/daily-challenge` - Daily quiz
- `GET /api/certificates/:attemptId` - HTML certificate

### Organizations
- `POST /api/organizations` - Create org (admin)
- `GET /api/organizations` - List with member counts
- `GET /api/organizations/:id/members` - Member list
- `POST /api/organizations/:id/assign-teacher` - Assign teacher
- `DELETE /api/organizations/:id/members/:userId` - Remove member

### AI Agent
- `POST /api/agent/generate-quiz` - AI quiz generation
- `POST /api/agent/evaluate` - AI answer evaluation
- `POST /api/agent/chat` - AI tutor conversation

## Database Schema

13 tables: `organizations`, `users`, `topics`, `materials`, `quizzes`, `questions`, `quiz_attempts`, `student_answers`, `enrollments`, `conversations`, `messages`, `student_profiles`, `leaderboard_entries`.

## User Roles

- **Admin** - Platform management, organizations, all teacher capabilities
- **Teacher** - Create topics/quizzes, run live sessions, view analytics
- **Student** - Take quizzes, earn XP/badges, join live sessions, AI tutor

## Presentation Files

- `presentation.html` - Open in browser, use arrow keys to navigate (11 slides)
- `Smart-Quiz-Agent-Presentation.md` - Full markdown document for sharing

**Author:** Aryan Kale
