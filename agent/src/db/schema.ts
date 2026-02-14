/** Drizzle ORM table definitions for the Smart Quiz Management System. */

import {
  pgTable,
  varchar,
  text,
  integer,
  serial,
  numeric,
  timestamp,
  jsonb,
  boolean,
  date,
  index,
} from "drizzle-orm/pg-core";

// ── Organizations ──

export const organizations = pgTable("organizations", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 32 }).notNull().default("school"),
  address: text("address"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Users ──

export const users = pgTable(
  "users",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    password_hash: text("password_hash").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    role: varchar("role", { length: 32 }).notNull().default("student"),
    organization_id: varchar("organization_id", { length: 64 }).references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("users_email_idx").on(table.email),
    index("users_role_idx").on(table.role),
  ]
);

// ── Topics ──

export const topics = pgTable(
  "topics",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    subject: varchar("subject", { length: 128 }).notNull(),
    grade_level: varchar("grade_level", { length: 32 }),
    teacher_id: varchar("teacher_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: varchar("organization_id", { length: 64 }).references(
      () => organizations.id,
      { onDelete: "set null" }
    ),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("topics_teacher_id_idx").on(table.teacher_id),
    index("topics_subject_idx").on(table.subject),
  ]
);

// ── Materials ──

export const materials = pgTable(
  "materials",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    topic_id: varchar("topic_id", { length: 64 })
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    file_name: varchar("file_name", { length: 255 }).notNull(),
    file_path: text("file_path").notNull(),
    file_size_bytes: integer("file_size_bytes"),
    extracted_text: text("extracted_text"),
    uploaded_by: varchar("uploaded_by", { length: 64 }).references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("materials_topic_id_idx").on(table.topic_id)]
);

// ── Quizzes ──

export const quizzes = pgTable(
  "quizzes",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    title: varchar("title", { length: 255 }).notNull(),
    topic_id: varchar("topic_id", { length: 64 })
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    teacher_id: varchar("teacher_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    quiz_type: varchar("quiz_type", { length: 32 }).notNull().default("practice"),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    time_limit_minutes: integer("time_limit_minutes"),
    scheduled_at: timestamp("scheduled_at", { withTimezone: true }),
    expires_at: timestamp("expires_at", { withTimezone: true }),
    total_marks: integer("total_marks").notNull().default(0),
    pass_percentage: integer("pass_percentage").notNull().default(40),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("quizzes_topic_id_idx").on(table.topic_id),
    index("quizzes_teacher_id_idx").on(table.teacher_id),
    index("quizzes_status_idx").on(table.status),
  ]
);

// ── Questions ──

export const questions = pgTable(
  "questions",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    quiz_id: varchar("quiz_id", { length: 64 })
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    question_text: text("question_text").notNull(),
    question_type: varchar("question_type", { length: 32 }).notNull().default("mcq"),
    options: jsonb("options").$type<string[]>(),
    correct_answer: text("correct_answer").notNull(),
    marks: integer("marks").notNull().default(1),
    explanation: text("explanation"),
    difficulty: varchar("difficulty", { length: 16 }).notNull().default("medium"),
    order_index: integer("order_index").notNull().default(0),
  },
  (table) => [index("questions_quiz_id_idx").on(table.quiz_id)]
);

// ── Quiz Attempts ──

export const quizAttempts = pgTable(
  "quiz_attempts",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    quiz_id: varchar("quiz_id", { length: 64 })
      .notNull()
      .references(() => quizzes.id, { onDelete: "cascade" }),
    student_id: varchar("student_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    submitted_at: timestamp("submitted_at", { withTimezone: true }),
    score: integer("score"),
    total_marks: integer("total_marks").notNull().default(0),
    percentage: numeric("percentage", { precision: 5, scale: 2 }),
    status: varchar("status", { length: 32 }).notNull().default("in_progress"),
  },
  (table) => [
    index("quiz_attempts_quiz_id_idx").on(table.quiz_id),
    index("quiz_attempts_student_id_idx").on(table.student_id),
    index("quiz_attempts_status_idx").on(table.status),
  ]
);

// ── Student Answers ──

export const studentAnswers = pgTable(
  "student_answers",
  {
    id: serial("id").primaryKey(),
    attempt_id: varchar("attempt_id", { length: 64 })
      .notNull()
      .references(() => quizAttempts.id, { onDelete: "cascade" }),
    question_id: varchar("question_id", { length: 64 })
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    answer_text: text("answer_text"),
    is_correct: boolean("is_correct"),
    marks_awarded: integer("marks_awarded").notNull().default(0),
    ai_feedback: text("ai_feedback"),
  },
  (table) => [index("student_answers_attempt_id_idx").on(table.attempt_id)]
);

// ── Enrollments ──

export const enrollments = pgTable(
  "enrollments",
  {
    id: serial("id").primaryKey(),
    student_id: varchar("student_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: varchar("organization_id", { length: 64 })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    enrolled_at: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("enrollments_student_id_idx").on(table.student_id),
    index("enrollments_org_id_idx").on(table.organization_id),
  ]
);

// ── Agent Conversations (for AI chat sessions) ──

export const conversations = pgTable(
  "conversations",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    user_id: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    topic_id: varchar("topic_id", { length: 64 }).references(() => topics.id, {
      onDelete: "set null",
    }),
    agent_session_id: text("agent_session_id"),
    title: varchar("title", { length: 255 }).notNull().default("New Chat"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("conversations_user_id_idx").on(table.user_id)]
);

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversation_id: varchar("conversation_id", { length: 64 })
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull(),
    text: text("text").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("messages_conversation_id_idx").on(table.conversation_id)]
);

// ── Student Profiles (Gamification) ──

export const studentProfiles = pgTable("student_profiles", {
  user_id: varchar("user_id", { length: 64 })
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  xp_total: integer("xp_total").notNull().default(0),
  level: integer("level").notNull().default(1),
  current_streak: integer("current_streak").notNull().default(0),
  longest_streak: integer("longest_streak").notNull().default(0),
  last_quiz_date: date("last_quiz_date"),
  badges: jsonb("badges").$type<string[]>().notNull().default([]),
  quizzes_completed: integer("quizzes_completed").notNull().default(0),
  perfect_scores: integer("perfect_scores").notNull().default(0),
});

// ── Leaderboard Entries ──

export const leaderboardEntries = pgTable(
  "leaderboard_entries",
  {
    id: serial("id").primaryKey(),
    user_id: varchar("user_id", { length: 64 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    period: varchar("period", { length: 16 }).notNull(),
    period_key: varchar("period_key", { length: 16 }).notNull(),
    xp: integer("xp").notNull().default(0),
    rank: integer("rank"),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("leaderboard_user_period_idx").on(table.user_id, table.period, table.period_key),
    index("leaderboard_period_xp_idx").on(table.period, table.period_key, table.xp),
  ]
);
