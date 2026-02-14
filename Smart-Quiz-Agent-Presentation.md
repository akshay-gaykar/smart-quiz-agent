# Smart Quiz Agent
### AI-Powered Quiz Management Platform

**Author:** Aryan Kale
**Date:** February 2026

---

## Overview

Smart Quiz Agent is an AI-powered quiz management platform built for educational institutions. It combines intelligent quiz generation, real-time assessments, gamification, and comprehensive analytics to transform how teachers create and students experience quizzes.

---

## Problem Statement

Traditional quiz platforms suffer from:

- **Manual question creation** is time-consuming for teachers
- **Static assessments** lack engagement and real-time interaction
- **No AI-powered evaluation** for subjective answers
- **Limited analytics** for identifying student struggles
- **Low student motivation** without gamification

---

## Solution

Smart Quiz Agent addresses these gaps with:

| Capability | Description |
|-----------|-------------|
| AI Quiz Generation | Auto-generate questions from uploaded PDFs and topic descriptions |
| AI Evaluation | Semantic answer grading with partial credit and constructive feedback |
| Live Quizzes | Kahoot-style real-time quiz sessions with leaderboards |
| Gamification | XP, levels, badges, streaks, and leaderboards |
| Analytics | Per-question analytics, heatmaps, and student comparison |
| AI Tutor | Conversational assistant for student help |

---

## Architecture

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express.js 5 + TypeScript |
| AI Engine | Anthropic Claude (via Agent SDK + MCP) |
| Database | PostgreSQL + Drizzle ORM |
| Auth | JWT + bcrypt |
| Real-time | Server-Sent Events (SSE) |
| File Processing | Multer + pdf-parse |
| Frontend | Vanilla JS Single-Page App |

### Database Schema (13 Tables)

```
organizations, users, topics, materials, quizzes, questions,
quiz_attempts, student_answers, enrollments, conversations,
messages, student_profiles, leaderboard_entries
```

### API Surface

**45+ REST endpoints** across 10 domains: Auth, Organizations, Topics, Materials, Quizzes, Gamification, Live Sessions, Analytics, AI Agent, Utilities.

---

## Key Features

### 1. AI-Powered Quiz Generation

- Teachers upload PDF study materials or describe a topic
- AI generates contextually relevant questions across 6 types:
  - Multiple Choice (MCQ)
  - True/False
  - Short Answer
  - Fill-in-the-Blank
  - Matching
  - Ordering
- Configurable difficulty (easy/medium/hard/mixed)
- Automatic explanations for each question

### 2. AI Answer Evaluation

- Semantic understanding of student responses
- Partial credit for short answers based on conceptual accuracy
- Constructive feedback on incorrect answers
- Per-question AI-generated explanations

### 3. Live Quiz Mode (Kahoot-style)

- Teacher starts a live session with a 6-digit join code
- Students join from any device in real-time
- Server-Sent Events push questions, timers, and results
- Live leaderboard updates after each question
- Podium display for top 3 at the end

### 4. Gamification Engine

| Element | Details |
|---------|---------|
| XP System | +50 completion, +10/correct, +100 perfect, +30 speed bonus, +25 streak |
| Leveling | `level = floor(sqrt(xp / 100)) + 1` |
| Streaks | Daily quiz streak tracking with longest streak record |
| Badges | 8 achievements (First Steps, On Fire, Week Warrior, Perfect Score, Quiz Master, Subject Expert, Speed Demon, Comeback Kid) |
| Leaderboards | Weekly, monthly, and all-time rankings |
| Daily Challenge | Auto-rotating daily quiz with bonus XP |

### 5. Teacher Analytics Dashboard

- **Per-question analytics**: correct/incorrect/skipped counts, % correct, common wrong answers
- **Student heatmap**: color-coded grid of student x question performance
- **Struggling students alert**: students scoring <40% on recent quizzes
- **Quiz difficulty analysis**: actual vs. assigned difficulty
- **CSV export** for all analytics data

### 6. Student Dashboard

- XP progress bar with level display
- Streak counter with flame animation
- Badge showcase (earned and locked)
- Weekly leaderboard widget
- Daily challenge card
- Subject-wise performance breakdown

### 7. Organization Management

- Admin creates and manages schools/institutions
- Assign teachers and enroll students to organizations
- Organization-level analytics and statistics
- Member management (add/remove)

### 8. Profile Management

- Edit name, email, and password
- View account details and activity stats
- Dark mode toggle
- Completion certificates

---

## User Roles

| Role | Capabilities |
|------|-------------|
| **Admin** | Manage organizations, view platform analytics, all teacher capabilities |
| **Teacher** | Create topics, upload materials, generate/manage quizzes, view student analytics, run live sessions |
| **Student** | Take quizzes, view results, earn XP/badges, join live sessions, chat with AI tutor |

---

## AI MCP Tools

The platform uses 4 custom Model Context Protocol tools:

1. **generate_quiz** - Creates questions from materials with configurable parameters
2. **evaluate_answers** - Auto-grades with semantic understanding and partial credit
3. **get_performance_analytics** - Analyzes student, quiz, and organization performance
4. **get_topic_insights** - Topic-level mastery and difficulty analysis

---

## UX Highlights

- **One-question-at-a-time** quiz flow with progress dots and navigation
- **Instant feedback** after each answer (correct/incorrect with explanation)
- **Animated score reveal** with XP breakdown on completion
- **Confetti animation** on perfect scores
- **Level-up overlay** when crossing XP thresholds
- **Toast notifications** for badges and achievements
- **Dark mode** with full theme support
- **Mobile responsive** with bottom navigation bar and "More" drawer
- **Skeleton loading** states instead of spinners

---

## Demo Credentials

| Role | Email | Password |
|------|-------|----------|
| Teacher | teacher@springfield.edu | password |
| Student | student@springfield.edu | password |
| Admin | admin@springfield.edu | password |

**URL:** `http://localhost:3456`

---

## Competitive Comparison

| Feature | Smart Quiz Agent | Kahoot | Quizizz | Google Forms |
|---------|:---:|:---:|:---:|:---:|
| AI Quiz Generation | Yes | No | Limited | No |
| AI Answer Evaluation | Yes | No | No | No |
| Live Quiz Mode | Yes | Yes | Yes | No |
| Gamification (XP/Badges) | Yes | Limited | Yes | No |
| PDF Material Upload | Yes | No | No | No |
| Per-question Analytics | Yes | Limited | Yes | Limited |
| AI Tutor Chat | Yes | No | No | No |
| Daily Challenges | Yes | No | Yes | No |
| Certificates | Yes | No | Yes | No |
| 6 Question Types | Yes | 4 | 5 | 4 |
| Free & Self-hosted | Yes | No | No | Yes |

---

## Impact Metrics (Industry Research)

- Gamification increases **engagement by 34%** and **retention by 27%**
- Quiz completion rates improve by **50%** with XP/badge systems
- AI-generated questions reduce teacher prep time by **70%**
- Instant feedback improves learning outcomes by **20%**

---

## Future Roadmap

- Adaptive difficulty (AI adjusts question difficulty based on student performance)
- Group quiz mode (team-based competitions)
- Parent/guardian dashboard
- LMS integrations (Google Classroom, Canvas, Moodle)
- Multi-language support
- Question bank sharing across teachers
- Video question support

---

## Summary

Smart Quiz Agent combines the best of modern quiz platforms with AI capabilities:

- **For Teachers**: Save hours with AI quiz generation, get actionable analytics
- **For Students**: Engaging gamified experience with personalized AI tutoring
- **For Admins**: Full platform oversight with organization management

Built with a modern tech stack, the platform is self-hosted, extensible, and designed for real classroom use.

---

**Author:** Aryan Kale
**Contact:** Smart Quiz Agent Project
**Built with:** Express.js, TypeScript, PostgreSQL, Anthropic Claude AI
