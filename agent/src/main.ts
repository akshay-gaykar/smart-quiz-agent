/** Smart Quiz Management System - main entry point with Express server + agent. */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import multer from "multer";
import pdfParse from "pdf-parse";
import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { eq, desc, and, count, sql, inArray } from "drizzle-orm";

import { buildQuizAgentPrompt } from "./prompts.js";
import { allTools } from "./tools/index.js";
import { db, checkDatabaseConnection } from "./db/index.js";
import {
  organizations,
  users,
  topics,
  materials,
  quizzes,
  questions,
  quizAttempts,
  studentAnswers,
  enrollments,
  conversations,
  messages,
  studentProfiles,
  leaderboardEntries,
} from "./db/schema.js";
import { runMigrations } from "./db/migrate.js";
import { seedDatabase } from "./db/seed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-in-production";
const SALT_ROUNDS = 10;

// ── Helpers ──

function genId(): string {
  return randomBytes(8).toString("hex");
}

function parseDecimal(val: string | null | undefined): number | null {
  if (val == null) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Safely extract a route param that Express 5 types as string | string[]. */
function param(req: express.Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? v[0] : v;
}

interface JwtPayload {
  userId: string;
  role: string;
  orgId: string | null;
}

function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
}

function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

// ── Auth Middleware ──

interface AuthRequest extends express.Request {
  user?: JwtPayload;
}

function authMiddleware(req: AuthRequest, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  req.user = payload;
  next();
}

function roleMiddleware(...allowedRoles: string[]) {
  return (req: AuthRequest, res: express.Response, next: express.NextFunction): void => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

// ── Live Quiz Session State ──

interface LiveParticipant {
  userId: string;
  name: string;
  score: number;
  answers: Array<{ questionIndex: number; answer: string; correct: boolean; time: number }>;
}

interface LiveSession {
  quizId: string;
  teacherId: string;
  status: "waiting" | "question" | "results" | "ended";
  currentQuestionIndex: number;
  questionStartedAt: number;
  questionTimeLimit: number;
  participants: Map<string, LiveParticipant>;
  sseClients: express.Response[];
  questions: Array<{
    id: string;
    question_text: string;
    question_type: string;
    options: unknown;
    correct_answer: string;
    marks: number;
    difficulty: string;
  }>;
}

const liveSessions = new Map<string, LiveSession>();

function generateJoinCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function broadcastSSE(session: LiveSession, event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  session.sseClients = session.sseClients.filter((res) => {
    try {
      res.write(msg);
      return true;
    } catch {
      return false;
    }
  });
}

// ── Gamification Helpers ──

function calculateLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}

function getWeekKey(d: Date): string {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function getMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const BADGE_DEFINITIONS: Record<string, { condition: string; icon: string }> = {
  first_steps: { condition: "Complete first quiz", icon: "\u{1F3CB}" },
  on_fire: { condition: "3-day streak", icon: "\u{1F525}" },
  week_warrior: { condition: "7-day streak", icon: "\u26A1" },
  perfect_score: { condition: "100% on any quiz", icon: "\u2B50" },
  quiz_master: { condition: "Complete 10 quizzes", icon: "\u{1F3C6}" },
  speed_demon: { condition: "Finish quiz in <50% time", icon: "\u23F1" },
  comeback_kid: { condition: "Score 80%+ after scoring <40%", icon: "\u{1F4AA}" },
};

async function updateLeaderboard(userId: string, xpEarned: number): Promise<void> {
  const now = new Date();
  const weekKey = getWeekKey(now);
  const monthKey = getMonthKey(now);

  for (const [period, periodKey] of [
    ["weekly", weekKey],
    ["monthly", monthKey],
    ["all_time", "all"],
  ] as const) {
    const [existing] = await db
      .select()
      .from(leaderboardEntries)
      .where(
        and(
          eq(leaderboardEntries.user_id, userId),
          eq(leaderboardEntries.period, period),
          eq(leaderboardEntries.period_key, periodKey)
        )
      )
      .limit(1);

    if (existing) {
      await db
        .update(leaderboardEntries)
        .set({ xp: existing.xp + xpEarned, updated_at: now })
        .where(eq(leaderboardEntries.id, existing.id));
    } else {
      await db.insert(leaderboardEntries).values({
        user_id: userId,
        period,
        period_key: periodKey,
        xp: xpEarned,
      });
    }
  }
}

// ── File Upload Setup ──

const UPLOADS_DIR = resolve(__dirname, "..", "uploads");
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

// ── Agent Setup ──

async function buildAgentOptions(): Promise<Options> {
  const quizServer = createSdkMcpServer({
    name: "quiz",
    version: "1.0.0",
    tools: allTools,
  });

  return {
    systemPrompt: buildQuizAgentPrompt(),
    allowedTools: [
      "Read",
      "mcp__quiz__generate_quiz",
      "mcp__quiz__evaluate_answers",
      "mcp__quiz__get_performance_analytics",
      "mcp__quiz__get_topic_insights",
    ],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    pathToClaudeCodeExecutable:
      process.env.CLAUDE_CODE_PATH ?? "/Users/akshaygaykar/.local/bin/claude",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) =>
            !["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"].includes(k)
        )
      ) as Record<string, string>,
    },
    mcpServers: { quiz: quizServer },
    agents: {},
    model: "claude-sonnet-4-5@20250929",
  };
}

// ── Express App ──

const app = express();
app.use(express.json({ limit: "10mb" }));

const HTML_PATH = resolve(__dirname, "..", "ui.html");

// ── Health Check ──

app.get("/health", async (_req, res) => {
  const dbOk = await checkDatabaseConnection();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "healthy" : "unhealthy",
    database: dbOk ? "connected" : "disconnected",
  });
});

// ── UI ──

app.get("/", (_req, res) => {
  if (!existsSync(HTML_PATH)) {
    res.status(404).send("ui.html not found");
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.send(readFileSync(HTML_PATH, "utf-8"));
});

// ========================================================================
// AUTH ROUTES
// ========================================================================

app.post("/api/auth/register", async (req, res) => {
  const { email, password, name, role, organization_id } = req.body;
  if (!email || !password || !name || !role) {
    res.status(400).json({ error: "email, password, name, and role are required" });
    return;
  }
  if (!["admin", "teacher", "student"].includes(role)) {
    res.status(400).json({ error: "role must be admin, teacher, or student" });
    return;
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    res.status(409).json({ error: "Email already registered" });
    return;
  }

  const id = genId();
  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);

  await db.insert(users).values({
    id,
    email,
    password_hash,
    name,
    role,
    organization_id: organization_id || null,
  });

  const token = signToken({ userId: id, role, orgId: organization_id || null });
  res.status(201).json({ token, user: { id, email, name, role, organization_id: organization_id || null } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  const token = signToken({
    userId: user.id,
    role: user.role,
    orgId: user.organization_id,
  });

  let organization_name: string | null = null;
  if (user.organization_id) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, user.organization_id)).limit(1);
    organization_name = org?.name ?? null;
  }

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organization_id: user.organization_id,
      organization_name,
    },
  });
});

app.get("/api/auth/me", authMiddleware, async (req: AuthRequest, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  let organization_name: string | null = null;
  if (user.organization_id) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, user.organization_id)).limit(1);
    organization_name = org?.name ?? null;
  }

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    organization_id: user.organization_id,
    organization_name,
  });
});

// Profile update
app.put("/api/auth/profile", authMiddleware, async (req: AuthRequest, res) => {
  const { name, email, current_password, new_password } = req.body;
  const userId = req.user!.userId;

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const updates: Record<string, any> = {};

  if (name && name.trim()) updates.name = name.trim();

  if (email && email.trim() && email !== user.email) {
    const [existing] = await db.select().from(users).where(eq(users.email, email.trim())).limit(1);
    if (existing) { res.status(400).json({ error: "Email already in use" }); return; }
    updates.email = email.trim();
  }

  if (new_password) {
    if (!current_password) { res.status(400).json({ error: "Current password is required" }); return; }
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) { res.status(400).json({ error: "Current password is incorrect" }); return; }
    if (new_password.length < 6) { res.status(400).json({ error: "New password must be at least 6 characters" }); return; }
    updates.password_hash = await bcrypt.hash(new_password, 10);
  }

  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No changes provided" }); return; }

  await db.update(users).set(updates).where(eq(users.id, userId));
  const [updated] = await db.select().from(users).where(eq(users.id, userId)).limit(1);

  let organization_name: string | null = null;
  if (updated.organization_id) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, updated.organization_id)).limit(1);
    organization_name = org?.name ?? null;
  }

  res.json({ id: updated.id, email: updated.email, name: updated.name, role: updated.role, organization_id: updated.organization_id, organization_name });
});

// ========================================================================
// ORGANIZATION ROUTES
// ========================================================================

app.post("/api/organizations", authMiddleware, roleMiddleware("admin"), async (req: AuthRequest, res) => {
  const { name, type, address } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const id = genId();
  await db.insert(organizations).values({
    id,
    name,
    type: type || "school",
    address: address || null,
  });
  res.status(201).json({ id, name, type: type || "school", address });
});

app.get("/api/organizations", authMiddleware, async (_req, res) => {
  const rows = await db.select().from(organizations).orderBy(desc(organizations.created_at));
  const enriched = await Promise.all(
    rows.map(async (o) => {
      const members = await db.select().from(users).where(eq(users.organization_id, o.id));
      const teacherCount = members.filter((m) => m.role === "teacher").length;
      const studentCount = members.filter((m) => m.role === "student").length;
      return {
        id: o.id,
        name: o.name,
        type: o.type,
        address: o.address,
        created_at: o.created_at?.toISOString(),
        teacher_count: teacherCount,
        student_count: studentCount,
        total_members: members.length,
      };
    })
  );
  res.json(enriched);
});

// Get members of an organization
app.get(
  "/api/organizations/:id/members",
  authMiddleware,
  roleMiddleware("admin"),
  async (req, res) => {
    const orgId = param(req, "id");
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }

    const members = await db.select().from(users).where(eq(users.organization_id, orgId));
    res.json({
      organization: { id: org.id, name: org.name, type: org.type, address: org.address },
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        created_at: m.created_at?.toISOString(),
      })),
    });
  }
);

// Get all unassigned teachers (for admin to assign)
app.get(
  "/api/teachers/unassigned",
  authMiddleware,
  roleMiddleware("admin"),
  async (_req, res) => {
    const allTeachers = await db.select().from(users).where(eq(users.role, "teacher"));
    const unassigned = allTeachers.filter((t) => !t.organization_id);
    res.json(
      unassigned.map((t) => ({
        id: t.id,
        name: t.name,
        email: t.email,
      }))
    );
  }
);

// Assign a teacher to an organization
app.post(
  "/api/organizations/:id/assign-teacher",
  authMiddleware,
  roleMiddleware("admin"),
  async (req, res) => {
    const orgId = param(req, "id");
    const { teacher_id } = req.body;
    if (!teacher_id) { res.status(400).json({ error: "teacher_id is required" }); return; }

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }

    const [teacher] = await db.select().from(users).where(eq(users.id, teacher_id)).limit(1);
    if (!teacher || teacher.role !== "teacher") {
      res.status(400).json({ error: "Valid teacher ID required" });
      return;
    }

    await db
      .update(users)
      .set({ organization_id: orgId, updated_at: new Date() })
      .where(eq(users.id, teacher_id));

    res.status(201).json({ assigned: true, teacher_id, organization_id: orgId, organization_name: org.name });
  }
);

// Remove a member from an organization
app.delete(
  "/api/organizations/:id/members/:userId",
  authMiddleware,
  roleMiddleware("admin"),
  async (req, res) => {
    const orgId = param(req, "id");
    const userId = param(req, "userId");

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    if (user.organization_id !== orgId) { res.status(400).json({ error: "User is not in this organization" }); return; }

    await db.update(users).set({ organization_id: null, updated_at: new Date() }).where(eq(users.id, userId));
    // Also remove enrollment if student
    if (user.role === "student") {
      await db.delete(enrollments).where(
        and(eq(enrollments.student_id, userId), eq(enrollments.organization_id, orgId))
      );
    }
    res.json({ removed: true, user_id: userId });
  }
);

app.post("/api/organizations/:id/enroll", authMiddleware, async (req: AuthRequest, res) => {
  const orgId = param(req, "id");
  const studentId = req.body.student_id || req.user!.userId;

  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }

  const [student] = await db.select().from(users).where(eq(users.id, studentId)).limit(1);
  if (!student || student.role !== "student") {
    res.status(400).json({ error: "Valid student ID required" });
    return;
  }

  await db.insert(enrollments).values({ student_id: studentId, organization_id: orgId });
  await db.update(users).set({ organization_id: orgId, updated_at: new Date() }).where(eq(users.id, studentId));
  res.status(201).json({ enrolled: true, student_id: studentId, organization_id: orgId });
});

// ========================================================================
// TOPIC ROUTES
// ========================================================================

app.post("/api/topics", authMiddleware, roleMiddleware("teacher", "admin"), async (req: AuthRequest, res) => {
  const { title, description, subject, grade_level } = req.body;
  if (!title || !subject) {
    res.status(400).json({ error: "title and subject are required" });
    return;
  }
  const id = genId();
  await db.insert(topics).values({
    id,
    title,
    description: description || null,
    subject,
    grade_level: grade_level || null,
    teacher_id: req.user!.userId,
    organization_id: req.user!.orgId,
  });
  res.status(201).json({ id, title, description, subject, grade_level });
});

app.get("/api/topics", authMiddleware, async (req: AuthRequest, res) => {
  let rows;
  if (req.user!.role === "teacher") {
    rows = await db
      .select()
      .from(topics)
      .where(eq(topics.teacher_id, req.user!.userId))
      .orderBy(desc(topics.created_at));
  } else if (req.user!.orgId) {
    rows = await db
      .select()
      .from(topics)
      .where(eq(topics.organization_id, req.user!.orgId as string))
      .orderBy(desc(topics.created_at));
  } else {
    rows = await db.select().from(topics).orderBy(desc(topics.created_at));
  }
  res.json(
    rows.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      subject: t.subject,
      grade_level: t.grade_level,
      teacher_id: t.teacher_id,
      created_at: t.created_at?.toISOString(),
    }))
  );
});

app.get("/api/topics/:id", authMiddleware, async (req, res) => {
  const [topic] = await db.select().from(topics).where(eq(topics.id, param(req, "id"))).limit(1);
  if (!topic) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }
  const mats = await db
    .select()
    .from(materials)
    .where(eq(materials.topic_id, topic.id))
    .orderBy(desc(materials.created_at));

  res.json({
    ...topic,
    created_at: topic.created_at?.toISOString(),
    updated_at: topic.updated_at?.toISOString(),
    materials: mats.map((m) => ({
      id: m.id,
      file_name: m.file_name,
      file_size_bytes: m.file_size_bytes,
      has_extracted_text: !!m.extracted_text,
      created_at: m.created_at?.toISOString(),
    })),
  });
});

// ========================================================================
// MATERIAL ROUTES
// ========================================================================

app.post(
  "/api/topics/:id/materials",
  authMiddleware,
  roleMiddleware("teacher", "admin"),
  upload.single("file"),
  async (req: AuthRequest, res) => {
    const topicId = param(req, "id");
    const [topic] = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1);
    if (!topic) {
      res.status(404).json({ error: "Topic not found" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    // Extract text from PDF
    let extractedText: string | null = null;
    try {
      const dataBuffer = readFileSync(file.path);
      const pdfData = await pdfParse(dataBuffer);
      extractedText = pdfData.text;
    } catch (err) {
      console.error("PDF text extraction failed:", err);
    }

    const id = genId();
    await db.insert(materials).values({
      id,
      topic_id: topicId,
      file_name: file.originalname,
      file_path: file.path,
      file_size_bytes: file.size,
      extracted_text: extractedText,
      uploaded_by: req.user!.userId,
    });

    res.status(201).json({
      id,
      file_name: file.originalname,
      file_size_bytes: file.size,
      has_extracted_text: !!extractedText,
      text_preview: extractedText ? extractedText.slice(0, 200) + "..." : null,
    });
  }
);

app.get("/api/materials/:id/download", authMiddleware, async (req, res) => {
  const [mat] = await db.select().from(materials).where(eq(materials.id, param(req, "id"))).limit(1);
  if (!mat) {
    res.status(404).json({ error: "Material not found" });
    return;
  }
  if (!existsSync(mat.file_path)) {
    res.status(404).json({ error: "File not found on disk" });
    return;
  }
  res.download(mat.file_path, mat.file_name);
});

// ========================================================================
// QUIZ ROUTES
// ========================================================================

app.post("/api/quizzes", authMiddleware, roleMiddleware("teacher", "admin"), async (req: AuthRequest, res) => {
  const { title, topic_id, quiz_type, time_limit_minutes, scheduled_at, expires_at, pass_percentage } = req.body;
  if (!title || !topic_id) {
    res.status(400).json({ error: "title and topic_id are required" });
    return;
  }

  const [topic] = await db.select().from(topics).where(eq(topics.id, topic_id)).limit(1);
  if (!topic) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }

  const id = genId();
  await db.insert(quizzes).values({
    id,
    title,
    topic_id,
    teacher_id: req.user!.userId,
    quiz_type: quiz_type || "practice",
    status: "draft",
    time_limit_minutes: time_limit_minutes || null,
    scheduled_at: scheduled_at ? new Date(scheduled_at) : null,
    expires_at: expires_at ? new Date(expires_at) : null,
    total_marks: 0,
    pass_percentage: pass_percentage || 40,
  });

  res.status(201).json({ id, title, topic_id, status: "draft", quiz_type: quiz_type || "practice" });
});

app.get("/api/quizzes", authMiddleware, async (req: AuthRequest, res) => {
  let rows;
  if (req.user!.role === "teacher") {
    rows = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.teacher_id, req.user!.userId))
      .orderBy(desc(quizzes.created_at));
  } else if (req.user!.role === "student") {
    rows = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.status, "published"))
      .orderBy(desc(quizzes.created_at));
  } else {
    rows = await db.select().from(quizzes).orderBy(desc(quizzes.created_at));
  }

  const enriched = await Promise.all(
    rows.map(async (q) => {
      const [{ value: qCount }] = await db
        .select({ value: count() })
        .from(questions)
        .where(eq(questions.quiz_id, q.id));
      const [topic] = await db.select().from(topics).where(eq(topics.id, q.topic_id)).limit(1);
      return {
        id: q.id,
        title: q.title,
        topic_title: topic?.title ?? "Unknown",
        subject: topic?.subject ?? "Unknown",
        quiz_type: q.quiz_type,
        status: q.status,
        time_limit_minutes: q.time_limit_minutes,
        total_marks: q.total_marks,
        question_count: Number(qCount),
        created_at: q.created_at?.toISOString(),
      };
    })
  );

  res.json(enriched);
});

app.get("/api/quizzes/:id", authMiddleware, async (req: AuthRequest, res) => {
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, param(req, "id"))).limit(1);
  if (!quiz) {
    res.status(404).json({ error: "Quiz not found" });
    return;
  }

  const qs = await db
    .select()
    .from(questions)
    .where(eq(questions.quiz_id, quiz.id))
    .orderBy(questions.order_index);

  // For students, hide correct answers unless quiz is completed
  const isStudent = req.user!.role === "student";

  res.json({
    id: quiz.id,
    title: quiz.title,
    topic_id: quiz.topic_id,
    teacher_id: quiz.teacher_id,
    quiz_type: quiz.quiz_type,
    status: quiz.status,
    time_limit_minutes: quiz.time_limit_minutes,
    total_marks: quiz.total_marks,
    pass_percentage: quiz.pass_percentage,
    scheduled_at: quiz.scheduled_at?.toISOString(),
    expires_at: quiz.expires_at?.toISOString(),
    created_at: quiz.created_at?.toISOString(),
    questions: qs.map((q) => ({
      id: q.id,
      question_text: q.question_text,
      question_type: q.question_type,
      options: q.options,
      marks: q.marks,
      difficulty: q.difficulty,
      order_index: q.order_index,
      ...(isStudent
        ? {}
        : {
            correct_answer: q.correct_answer,
            explanation: q.explanation,
          }),
    })),
  });
});

app.put("/api/quizzes/:id/publish", authMiddleware, roleMiddleware("teacher", "admin"), async (req, res) => {
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, param(req, "id"))).limit(1);
  if (!quiz) {
    res.status(404).json({ error: "Quiz not found" });
    return;
  }

  const [{ value: qCount }] = await db
    .select({ value: count() })
    .from(questions)
    .where(eq(questions.quiz_id, quiz.id));

  if (Number(qCount) === 0) {
    res.status(400).json({ error: "Cannot publish a quiz with no questions" });
    return;
  }

  await db
    .update(quizzes)
    .set({ status: "published", updated_at: new Date() })
    .where(eq(quizzes.id, quiz.id));

  res.json({ id: quiz.id, status: "published" });
});

// ── Quiz Attempt Routes ──

app.post("/api/quizzes/:id/attempt", authMiddleware, roleMiddleware("student"), async (req: AuthRequest, res) => {
  const quizId = param(req, "id");
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, quizId)).limit(1);
  if (!quiz) {
    res.status(404).json({ error: "Quiz not found" });
    return;
  }
  if (quiz.status !== "published") {
    res.status(400).json({ error: "Quiz is not available" });
    return;
  }

  // Check for existing in-progress attempt
  const [existing] = await db
    .select()
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.quiz_id, quizId),
        eq(quizAttempts.student_id, req.user!.userId),
        eq(quizAttempts.status, "in_progress")
      )
    )
    .limit(1);

  if (existing) {
    res.json({ attempt_id: existing.id, status: "in_progress", message: "Resuming existing attempt" });
    return;
  }

  const attemptId = genId();
  await db.insert(quizAttempts).values({
    id: attemptId,
    quiz_id: quizId,
    student_id: req.user!.userId,
    total_marks: quiz.total_marks,
    status: "in_progress",
  });

  res.status(201).json({ attempt_id: attemptId, status: "in_progress" });
});

app.post("/api/quizzes/:id/submit", authMiddleware, roleMiddleware("student"), async (req: AuthRequest, res) => {
  const quizId = param(req, "id");
  const { attempt_id, answers: submittedAnswers } = req.body;

  if (!attempt_id || !submittedAnswers) {
    res.status(400).json({ error: "attempt_id and answers are required" });
    return;
  }

  const [attempt] = await db
    .select()
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.id, attempt_id),
        eq(quizAttempts.quiz_id, quizId),
        eq(quizAttempts.student_id, req.user!.userId)
      )
    )
    .limit(1);

  if (!attempt) {
    res.status(404).json({ error: "Attempt not found" });
    return;
  }
  if (attempt.status !== "in_progress") {
    res.status(400).json({ error: "Attempt already submitted" });
    return;
  }

  // Get quiz questions
  const qs = await db.select().from(questions).where(eq(questions.quiz_id, quizId));
  const questionMap = new Map(qs.map((q) => [q.id, q]));

  let totalScore = 0;
  let totalMarks = 0;

  const answerRecords: Array<{
    attempt_id: string;
    question_id: string;
    answer_text: string;
    is_correct: boolean;
    marks_awarded: number;
    ai_feedback: string | null;
  }> = [];

  for (const ans of submittedAnswers as Array<{ question_id: string; answer: string }>) {
    const q = questionMap.get(ans.question_id);
    if (!q) continue;

    totalMarks += q.marks;
    let isCorrect = false;
    let marksAwarded = 0;
    let feedback: string | null = null;

    if (q.question_type === "mcq" || q.question_type === "true_false") {
      isCorrect = ans.answer.trim().toLowerCase() === q.correct_answer.trim().toLowerCase();
      marksAwarded = isCorrect ? q.marks : 0;
      feedback = isCorrect ? "Correct!" : `Incorrect. The correct answer is: ${q.correct_answer}`;
    } else if (q.question_type === "fill_in_blank") {
      const opts = q.options as { acceptable?: string[] } | null;
      const acceptable = (opts?.acceptable || [q.correct_answer]).map((s: string) => s.trim().toLowerCase());
      const studentAnswer = ans.answer.trim().toLowerCase();
      isCorrect = acceptable.includes(studentAnswer);
      marksAwarded = isCorrect ? q.marks : 0;
      feedback = isCorrect ? "Correct!" : `Incorrect. Acceptable answers: ${acceptable.join(", ")}`;
    } else if (q.question_type === "matching") {
      try {
        const studentPairs = JSON.parse(ans.answer);
        const correctPairs = JSON.parse(q.correct_answer);
        let matchCount = 0;
        for (const cp of correctPairs) {
          const match = studentPairs.find(
            (sp: { left: string; right: string }) =>
              sp.left?.trim().toLowerCase() === cp.left?.trim().toLowerCase() &&
              sp.right?.trim().toLowerCase() === cp.right?.trim().toLowerCase()
          );
          if (match) matchCount++;
        }
        isCorrect = matchCount === correctPairs.length;
        const ratio = correctPairs.length > 0 ? matchCount / correctPairs.length : 0;
        marksAwarded = Math.round(q.marks * ratio);
        feedback = isCorrect
          ? "Correct! All pairs matched."
          : `${matchCount}/${correctPairs.length} pairs correct.`;
      } catch {
        feedback = "Invalid answer format for matching question.";
      }
    } else if (q.question_type === "ordering") {
      try {
        const studentOrder = JSON.parse(ans.answer);
        const correctOrder = JSON.parse(q.correct_answer);
        isCorrect =
          Array.isArray(studentOrder) &&
          Array.isArray(correctOrder) &&
          studentOrder.length === correctOrder.length &&
          studentOrder.every((v: number, i: number) => v === correctOrder[i]);
        marksAwarded = isCorrect ? q.marks : 0;
        feedback = isCorrect ? "Correct order!" : "Incorrect order.";
      } catch {
        feedback = "Invalid answer format for ordering question.";
      }
    } else {
      // Short answer - basic evaluation (AI agent can provide better evaluation)
      const studentLower = ans.answer.trim().toLowerCase();
      const correctLower = q.correct_answer.trim().toLowerCase();
      if (studentLower === correctLower) {
        isCorrect = true;
        marksAwarded = q.marks;
        feedback = "Correct!";
      } else if (
        correctLower.split(" ").filter((w) => w.length > 3).some((word) => studentLower.includes(word))
      ) {
        marksAwarded = Math.ceil(q.marks * 0.5);
        feedback = `Partial credit. Expected: ${q.correct_answer}`;
      } else {
        feedback = `Incorrect. Expected: ${q.correct_answer}`;
      }
    }

    totalScore += marksAwarded;
    answerRecords.push({
      attempt_id,
      question_id: ans.question_id,
      answer_text: ans.answer,
      is_correct: isCorrect,
      marks_awarded: marksAwarded,
      ai_feedback: feedback,
    });
  }

  const percentage = totalMarks > 0 ? Math.round((totalScore / totalMarks) * 100 * 100) / 100 : 0;

  const submittedAt = new Date();

  await db.transaction(async (tx) => {
    if (answerRecords.length > 0) {
      await tx.insert(studentAnswers).values(answerRecords);
    }
    await tx
      .update(quizAttempts)
      .set({
        submitted_at: submittedAt,
        score: totalScore,
        total_marks: totalMarks,
        percentage: String(percentage),
        status: "evaluated",
      })
      .where(eq(quizAttempts.id, attempt_id));
  });

  // ── Gamification: XP, badges, streaks, leaderboard ──
  let xpEarned = 0;
  const newBadges: string[] = [];

  // Ensure student profile exists
  let [profile] = await db
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.user_id, req.user!.userId))
    .limit(1);

  if (!profile) {
    await db.insert(studentProfiles).values({ user_id: req.user!.userId });
    [profile] = await db
      .select()
      .from(studentProfiles)
      .where(eq(studentProfiles.user_id, req.user!.userId))
      .limit(1);
  }

  // Base XP
  xpEarned += 50; // Quiz completion
  xpEarned += answerRecords.filter((a) => a.is_correct).length * 10; // Per correct answer

  // Perfect score bonus
  if (percentage === 100) {
    xpEarned += 100;
  }

  // First attempt bonus
  const [priorAttempts] = await db
    .select({ value: count() })
    .from(quizAttempts)
    .where(
      and(
        eq(quizAttempts.quiz_id, quizId),
        eq(quizAttempts.student_id, req.user!.userId),
        eq(quizAttempts.status, "evaluated")
      )
    );
  if (Number(priorAttempts?.value ?? 0) <= 1) {
    xpEarned += 20;
  }

  // Speed bonus
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, quizId)).limit(1);
  if (quiz?.time_limit_minutes) {
    const timeTaken = (submittedAt.getTime() - attempt.started_at.getTime()) / 60000;
    if (timeTaken < quiz.time_limit_minutes * 0.5) {
      xpEarned += 30;
    }
  }

  // Streak logic
  const today = submittedAt.toISOString().slice(0, 10);
  let newStreak = profile.current_streak;
  if (profile.last_quiz_date) {
    const lastDate = typeof profile.last_quiz_date === "string"
      ? profile.last_quiz_date
      : profile.last_quiz_date;
    const lastMs = new Date(lastDate).getTime();
    const todayMs = new Date(today).getTime();
    const diffDays = Math.floor((todayMs - lastMs) / 86400000);
    if (diffDays === 1) {
      newStreak += 1;
    } else if (diffDays > 1) {
      newStreak = 1;
    }
    // Same day: no streak change
  } else {
    newStreak = 1;
  }

  // Streak bonus
  if (newStreak >= 3) {
    xpEarned += 25;
  }

  const longestStreak = Math.max(profile.longest_streak, newStreak);
  const newXpTotal = profile.xp_total + xpEarned;
  const newLevel = calculateLevel(newXpTotal);
  const newQuizzesCompleted = profile.quizzes_completed + 1;
  const newPerfectScores = percentage === 100 ? profile.perfect_scores + 1 : profile.perfect_scores;

  // Badge checks
  const currentBadges = new Set(profile.badges || []);
  if (!currentBadges.has("first_steps")) {
    newBadges.push("first_steps");
    currentBadges.add("first_steps");
  }
  if (newStreak >= 3 && !currentBadges.has("on_fire")) {
    newBadges.push("on_fire");
    currentBadges.add("on_fire");
  }
  if (newStreak >= 7 && !currentBadges.has("week_warrior")) {
    newBadges.push("week_warrior");
    currentBadges.add("week_warrior");
  }
  if (percentage === 100 && !currentBadges.has("perfect_score")) {
    newBadges.push("perfect_score");
    currentBadges.add("perfect_score");
  }
  if (newQuizzesCompleted >= 10 && !currentBadges.has("quiz_master")) {
    newBadges.push("quiz_master");
    currentBadges.add("quiz_master");
  }
  if (quiz?.time_limit_minutes && !currentBadges.has("speed_demon")) {
    const timeTaken = (submittedAt.getTime() - attempt.started_at.getTime()) / 60000;
    if (timeTaken < quiz.time_limit_minutes * 0.5) {
      newBadges.push("speed_demon");
      currentBadges.add("speed_demon");
    }
  }
  // Comeback kid check
  if (percentage >= 80 && !currentBadges.has("comeback_kid")) {
    const prevAttempts = await db
      .select()
      .from(quizAttempts)
      .where(
        and(
          eq(quizAttempts.student_id, req.user!.userId),
          eq(quizAttempts.status, "evaluated")
        )
      );
    const hadLowScore = prevAttempts.some(
      (a) => a.id !== attempt_id && (parseDecimal(a.percentage) ?? 0) < 40
    );
    if (hadLowScore) {
      newBadges.push("comeback_kid");
      currentBadges.add("comeback_kid");
    }
  }

  const leveledUp = newLevel > profile.level;

  // Update profile
  await db
    .update(studentProfiles)
    .set({
      xp_total: newXpTotal,
      level: newLevel,
      current_streak: newStreak,
      longest_streak: longestStreak,
      last_quiz_date: today,
      badges: Array.from(currentBadges),
      quizzes_completed: newQuizzesCompleted,
      perfect_scores: newPerfectScores,
    })
    .where(eq(studentProfiles.user_id, req.user!.userId));

  // Update leaderboard
  await updateLeaderboard(req.user!.userId, xpEarned);

  res.json({
    attempt_id,
    score: totalScore,
    total_marks: totalMarks,
    percentage,
    status: "evaluated",
    answers: answerRecords.map((a) => ({
      question_id: a.question_id,
      is_correct: a.is_correct,
      marks_awarded: a.marks_awarded,
      feedback: a.ai_feedback,
    })),
    gamification: {
      xp_earned: xpEarned,
      xp_total: newXpTotal,
      level: newLevel,
      leveled_up: leveledUp,
      streak: newStreak,
      new_badges: newBadges,
      badges_total: currentBadges.size,
    },
  });
});

app.get("/api/quizzes/:id/results", authMiddleware, async (req: AuthRequest, res) => {
  const quizId = param(req, "id");

  let attemptsQuery;
  if (req.user!.role === "student") {
    attemptsQuery = db
      .select()
      .from(quizAttempts)
      .where(and(eq(quizAttempts.quiz_id, quizId), eq(quizAttempts.student_id, req.user!.userId)))
      .orderBy(desc(quizAttempts.submitted_at));
  } else {
    attemptsQuery = db
      .select()
      .from(quizAttempts)
      .where(eq(quizAttempts.quiz_id, quizId))
      .orderBy(desc(quizAttempts.submitted_at));
  }

  const attemptRows = await attemptsQuery;

  const results = await Promise.all(
    attemptRows.map(async (a) => {
      const [student] = await db.select().from(users).where(eq(users.id, a.student_id)).limit(1);
      const answers = await db
        .select()
        .from(studentAnswers)
        .where(eq(studentAnswers.attempt_id, a.id));

      return {
        attempt_id: a.id,
        student_name: student?.name ?? "Unknown",
        student_id: a.student_id,
        score: a.score,
        total_marks: a.total_marks,
        percentage: parseDecimal(a.percentage),
        status: a.status,
        started_at: a.started_at?.toISOString(),
        submitted_at: a.submitted_at?.toISOString(),
        answers: answers.map((ans) => ({
          question_id: ans.question_id,
          answer_text: ans.answer_text,
          is_correct: ans.is_correct,
          marks_awarded: ans.marks_awarded,
          ai_feedback: ans.ai_feedback,
        })),
      };
    })
  );

  res.json(results);
});

// ========================================================================
// GAMIFICATION ROUTES
// ========================================================================

app.get("/api/student-profile", authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.user!.userId;
  let [profile] = await db
    .select()
    .from(studentProfiles)
    .where(eq(studentProfiles.user_id, userId))
    .limit(1);

  if (!profile) {
    await db.insert(studentProfiles).values({ user_id: userId });
    [profile] = await db
      .select()
      .from(studentProfiles)
      .where(eq(studentProfiles.user_id, userId))
      .limit(1);
  }

  const nextLevelXp = Math.pow(profile.level, 2) * 100;
  const prevLevelXp = Math.pow(profile.level - 1, 2) * 100;
  const xpInLevel = profile.xp_total - prevLevelXp;
  const xpNeeded = nextLevelXp - prevLevelXp;

  res.json({
    ...profile,
    xp_in_level: xpInLevel,
    xp_needed: xpNeeded,
    xp_progress: xpNeeded > 0 ? Math.round((xpInLevel / xpNeeded) * 100) : 100,
    badge_details: (profile.badges || []).map((b: string) => ({
      id: b,
      ...(BADGE_DEFINITIONS[b] || { condition: b, icon: "\u2B50" }),
    })),
  });
});

app.get("/api/leaderboard", authMiddleware, async (req, res) => {
  const period = (req.query.period as string) || "weekly";
  const now = new Date();
  let periodKey: string;

  if (period === "weekly") periodKey = getWeekKey(now);
  else if (period === "monthly") periodKey = getMonthKey(now);
  else periodKey = "all";

  const validPeriod = period === "weekly" || period === "monthly" ? period : "all_time";

  const entries = await db
    .select()
    .from(leaderboardEntries)
    .where(
      and(
        eq(leaderboardEntries.period, validPeriod),
        eq(leaderboardEntries.period_key, periodKey)
      )
    )
    .orderBy(desc(leaderboardEntries.xp))
    .limit(20);

  const enriched = await Promise.all(
    entries.map(async (e, idx) => {
      const [user] = await db.select().from(users).where(eq(users.id, e.user_id)).limit(1);
      const [profile] = await db
        .select()
        .from(studentProfiles)
        .where(eq(studentProfiles.user_id, e.user_id))
        .limit(1);
      return {
        rank: idx + 1,
        user_id: e.user_id,
        name: user?.name ?? "Unknown",
        xp: e.xp,
        level: profile?.level ?? 1,
        badges_count: (profile?.badges as string[] || []).length,
        streak: profile?.current_streak ?? 0,
      };
    })
  );

  res.json({ period: validPeriod, period_key: periodKey, entries: enriched });
});

// ========================================================================
// LIVE QUIZ ROUTES
// ========================================================================

app.post(
  "/api/quizzes/:id/start-live",
  authMiddleware,
  roleMiddleware("teacher", "admin"),
  async (req: AuthRequest, res) => {
    const quizId = param(req, "id");
    const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, quizId)).limit(1);
    if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }
    if (quiz.status !== "published") {
      res.status(400).json({ error: "Quiz must be published to start live" });
      return;
    }

    const qs = await db
      .select()
      .from(questions)
      .where(eq(questions.quiz_id, quizId))
      .orderBy(questions.order_index);

    if (qs.length === 0) {
      res.status(400).json({ error: "Quiz has no questions" });
      return;
    }

    let joinCode: string;
    do {
      joinCode = generateJoinCode();
    } while (liveSessions.has(joinCode));

    const session: LiveSession = {
      quizId,
      teacherId: req.user!.userId,
      status: "waiting",
      currentQuestionIndex: -1,
      questionStartedAt: 0,
      questionTimeLimit: (quiz.time_limit_minutes || 30) * 60 / qs.length,
      participants: new Map(),
      sseClients: [],
      questions: qs.map((q) => ({
        id: q.id,
        question_text: q.question_text,
        question_type: q.question_type,
        options: q.options,
        correct_answer: q.correct_answer,
        marks: q.marks,
        difficulty: q.difficulty,
      })),
    };

    liveSessions.set(joinCode, session);

    res.json({
      join_code: joinCode,
      quiz_title: quiz.title,
      question_count: qs.length,
      time_per_question: Math.round(session.questionTimeLimit),
    });
  }
);

app.get("/api/live/:code/stream", (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  // SSE clients pass token as query param since EventSource can't set headers
  const queryToken = req.query.token as string;
  if (queryToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  authMiddleware(req, res, next);
}, async (req: AuthRequest, res) => {
  const code = param(req, "code");
  const session = liveSessions.get(code);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ status: session.status })}\n\n`);

  session.sseClients.push(res);

  req.on("close", () => {
    session.sseClients = session.sseClients.filter((c) => c !== res);
  });
});

app.post("/api/live/:code/join", authMiddleware, async (req: AuthRequest, res) => {
  const code = param(req, "code");
  const session = liveSessions.get(code);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  if (session.status === "ended") {
    res.status(400).json({ error: "Session has ended" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);

  if (!session.participants.has(req.user!.userId)) {
    session.participants.set(req.user!.userId, {
      userId: req.user!.userId,
      name: user?.name ?? "Unknown",
      score: 0,
      answers: [],
    });
    broadcastSSE(session, "participant_joined", {
      user_id: req.user!.userId,
      name: user?.name ?? "Unknown",
      participant_count: session.participants.size,
    });
  }

  res.json({
    status: session.status,
    participant_count: session.participants.size,
    question_count: session.questions.length,
  });
});

app.post("/api/live/:code/next", authMiddleware, roleMiddleware("teacher", "admin"), async (req: AuthRequest, res) => {
  const code = param(req, "code");
  const session = liveSessions.get(code);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  if (session.teacherId !== req.user!.userId) {
    res.status(403).json({ error: "Not the session host" });
    return;
  }

  session.currentQuestionIndex++;
  if (session.currentQuestionIndex >= session.questions.length) {
    // Quiz is over
    session.status = "ended";
    const leaderboard = Array.from(session.participants.values())
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
    broadcastSSE(session, "quiz_ended", { leaderboard });

    // Save attempts to database
    for (const [userId, participant] of session.participants) {
      const attemptId = genId();
      const totalMarks = session.questions.reduce((s, q) => s + q.marks, 0);
      const pct = totalMarks > 0 ? Math.round((participant.score / totalMarks) * 100 * 100) / 100 : 0;

      await db.insert(quizAttempts).values({
        id: attemptId,
        quiz_id: session.quizId,
        student_id: userId,
        total_marks: totalMarks,
        score: participant.score,
        percentage: String(pct),
        status: "evaluated",
        submitted_at: new Date(),
      });

      for (const ans of participant.answers) {
        const q = session.questions[ans.questionIndex];
        if (q) {
          await db.insert(studentAnswers).values({
            attempt_id: attemptId,
            question_id: q.id,
            answer_text: ans.answer,
            is_correct: ans.correct,
            marks_awarded: ans.correct ? q.marks : 0,
            ai_feedback: ans.correct ? "Correct!" : `Incorrect. The correct answer is: ${q.correct_answer}`,
          });
        }
      }
    }

    res.json({ status: "ended", leaderboard });
    return;
  }

  session.status = "question";
  session.questionStartedAt = Date.now();

  const q = session.questions[session.currentQuestionIndex];
  broadcastSSE(session, "question", {
    index: session.currentQuestionIndex,
    total: session.questions.length,
    question_text: q.question_text,
    question_type: q.question_type,
    options: q.options,
    marks: q.marks,
    difficulty: q.difficulty,
    time_limit: Math.round(session.questionTimeLimit),
  });

  res.json({
    status: "question",
    question_index: session.currentQuestionIndex,
    total_questions: session.questions.length,
  });
});

app.post("/api/live/:code/answer", authMiddleware, async (req: AuthRequest, res) => {
  const code = param(req, "code");
  const session = liveSessions.get(code);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  if (session.status !== "question") {
    res.status(400).json({ error: "No active question" });
    return;
  }

  const participant = session.participants.get(req.user!.userId);
  if (!participant) { res.status(400).json({ error: "Not a participant" }); return; }

  // Check if already answered this question
  if (participant.answers.some((a) => a.questionIndex === session.currentQuestionIndex)) {
    res.status(400).json({ error: "Already answered" });
    return;
  }

  const { answer } = req.body;
  const q = session.questions[session.currentQuestionIndex];
  const isCorrect = answer?.trim().toLowerCase() === q.correct_answer.trim().toLowerCase();
  const timeTaken = (Date.now() - session.questionStartedAt) / 1000;

  if (isCorrect) {
    participant.score += q.marks;
  }

  participant.answers.push({
    questionIndex: session.currentQuestionIndex,
    answer: answer || "",
    correct: isCorrect,
    time: timeTaken,
  });

  // Broadcast answer count
  const answered = Array.from(session.participants.values()).filter(
    (p) => p.answers.some((a) => a.questionIndex === session.currentQuestionIndex)
  ).length;

  broadcastSSE(session, "answer_update", {
    answered,
    total: session.participants.size,
  });

  res.json({ correct: isCorrect, score: participant.score });
});

app.post("/api/live/:code/end", authMiddleware, roleMiddleware("teacher", "admin"), async (req: AuthRequest, res) => {
  const code = param(req, "code");
  const session = liveSessions.get(code);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  session.status = "ended";
  const leaderboard = Array.from(session.participants.values())
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
  broadcastSSE(session, "quiz_ended", { leaderboard });

  // Clean up after a delay
  setTimeout(() => liveSessions.delete(code), 60000);

  res.json({ status: "ended", leaderboard });
});

app.get("/api/live/:code/status", authMiddleware, async (req, res) => {
  const code = param(req, "code");
  const session = liveSessions.get(code);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  const leaderboard = Array.from(session.participants.values())
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, user_id: p.userId }));

  res.json({
    status: session.status,
    current_question: session.currentQuestionIndex,
    total_questions: session.questions.length,
    participant_count: session.participants.size,
    leaderboard,
  });
});

// ========================================================================
// DAILY CHALLENGE & CERTIFICATES
// ========================================================================

app.get("/api/daily-challenge", authMiddleware, async (_req, res) => {
  const today = new Date();
  const dayOfYear = Math.floor(
    (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000
  );

  const publishedQuizzes = await db
    .select()
    .from(quizzes)
    .where(eq(quizzes.status, "published"));

  if (publishedQuizzes.length === 0) {
    res.json({ challenge: null });
    return;
  }

  const challengeQuiz = publishedQuizzes[dayOfYear % publishedQuizzes.length];
  const [topic] = await db.select().from(topics).where(eq(topics.id, challengeQuiz.topic_id)).limit(1);
  const [qCount] = await db
    .select({ value: count() })
    .from(questions)
    .where(eq(questions.quiz_id, challengeQuiz.id));

  res.json({
    challenge: {
      id: challengeQuiz.id,
      title: challengeQuiz.title,
      subject: topic?.subject ?? "Unknown",
      question_count: Number(qCount?.value ?? 0),
      total_marks: challengeQuiz.total_marks,
      bonus_xp: 50,
      date: today.toISOString().slice(0, 10),
    },
  });
});

app.get("/api/certificates/:attemptId", authMiddleware, async (req, res) => {
  const attemptId = param(req, "attemptId");
  const [attempt] = await db.select().from(quizAttempts).where(eq(quizAttempts.id, attemptId)).limit(1);
  if (!attempt) { res.status(404).json({ error: "Attempt not found" }); return; }
  if (attempt.status !== "evaluated") { res.status(400).json({ error: "Quiz not evaluated" }); return; }

  const [student] = await db.select().from(users).where(eq(users.id, attempt.student_id)).limit(1);
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, attempt.quiz_id)).limit(1);
  const [topic] = quiz
    ? await db.select().from(topics).where(eq(topics.id, quiz.topic_id)).limit(1)
    : [null];

  const pct = parseDecimal(attempt.percentage) ?? 0;
  const passed = quiz ? pct >= quiz.pass_percentage : pct >= 40;

  const certHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Certificate</title>
<style>
  body{margin:0;padding:40px;font-family:Georgia,serif;background:#f8fafc;display:flex;justify-content:center;align-items:center;min-height:100vh}
  .cert{background:white;border:3px solid #4f46e5;border-radius:12px;padding:60px 80px;max-width:800px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.1);position:relative}
  .cert::before{content:'';position:absolute;inset:8px;border:1px solid #e2e8f0;border-radius:8px}
  .cert h1{color:#4f46e5;font-size:36px;margin-bottom:8px}
  .cert .subtitle{color:#64748b;font-size:18px;margin-bottom:32px}
  .cert .recipient{font-size:28px;color:#1e293b;border-bottom:2px solid #4f46e5;display:inline-block;padding-bottom:4px;margin-bottom:16px}
  .cert .details{color:#475569;font-size:16px;line-height:1.8;margin:24px 0}
  .cert .score{font-size:48px;font-weight:bold;color:${passed ? "#10b981" : "#ef4444"};margin:16px 0}
  .cert .footer{color:#94a3b8;font-size:13px;margin-top:32px}
  .cert .badge{display:inline-block;padding:6px 16px;border-radius:20px;font-size:14px;font-weight:600;background:${passed ? "#d1fae5" : "#fee2e2"};color:${passed ? "#065f46" : "#991b1b"}}
  @media print{body{background:white;padding:0}.cert{box-shadow:none;border-width:2px}}
</style></head><body>
<div class="cert">
  <h1>Certificate of Completion</h1>
  <div class="subtitle">Smart Quiz Platform</div>
  <p>This certifies that</p>
  <div class="recipient">${student?.name ?? "Student"}</div>
  <div class="details">
    has completed the quiz<br>
    <strong>${quiz?.title ?? "Quiz"}</strong><br>
    Subject: ${topic?.subject ?? "General"}<br>
    on ${attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "N/A"}
  </div>
  <div class="score">${pct}%</div>
  <div class="badge">${passed ? "PASSED" : "COMPLETED"}</div>
  <p style="margin-top:16px;color:#64748b">Score: ${attempt.score}/${attempt.total_marks}</p>
  <div class="footer">
    <p>Certificate ID: ${attemptId}</p>
    <p>Generated by Smart Quiz AI Platform</p>
  </div>
</div>
</body></html>`;

  res.setHeader("Content-Type", "text/html");
  res.send(certHtml);
});

// ========================================================================
// ENHANCED ANALYTICS ROUTES
// ========================================================================

app.get("/api/analytics/quiz/:id/questions", authMiddleware, roleMiddleware("teacher", "admin"), async (req, res) => {
  const quizId = param(req, "id");
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, quizId)).limit(1);
  if (!quiz) { res.status(404).json({ error: "Quiz not found" }); return; }

  const qs = await db
    .select()
    .from(questions)
    .where(eq(questions.quiz_id, quizId))
    .orderBy(questions.order_index);

  const allAttempts = await db
    .select()
    .from(quizAttempts)
    .where(and(eq(quizAttempts.quiz_id, quizId), eq(quizAttempts.status, "evaluated")));

  const attemptIds = allAttempts.map((a) => a.id);
  const allAnswers = attemptIds.length > 0
    ? await db.select().from(studentAnswers).where(inArray(studentAnswers.attempt_id, attemptIds))
    : [];

  const questionAnalytics = qs.map((q) => {
    const qAnswers = allAnswers.filter((a) => a.question_id === q.id);
    const correct = qAnswers.filter((a) => a.is_correct).length;
    const incorrect = qAnswers.filter((a) => a.is_correct === false).length;
    const skipped = allAttempts.length - qAnswers.length;
    const pctCorrect = qAnswers.length > 0 ? Math.round((correct / qAnswers.length) * 100) : 0;

    // Most common wrong answer
    const wrongAnswers = qAnswers.filter((a) => !a.is_correct && a.answer_text);
    const answerCounts = new Map<string, number>();
    for (const a of wrongAnswers) {
      const key = (a.answer_text || "").trim();
      answerCounts.set(key, (answerCounts.get(key) || 0) + 1);
    }
    let mostCommonWrong: string | null = null;
    let maxCount = 0;
    for (const [ans, cnt] of answerCounts) {
      if (cnt > maxCount) { mostCommonWrong = ans; maxCount = cnt; }
    }

    return {
      question_id: q.id,
      question_text: q.question_text,
      question_type: q.question_type,
      difficulty: q.difficulty,
      correct_count: correct,
      incorrect_count: incorrect,
      skipped_count: skipped,
      total_responses: qAnswers.length,
      percent_correct: pctCorrect,
      most_common_wrong_answer: mostCommonWrong,
      actual_difficulty: pctCorrect >= 80 ? "easy" : pctCorrect >= 50 ? "medium" : "hard",
    };
  });

  res.json({ quiz_id: quizId, quiz_title: quiz.title, questions: questionAnalytics });
});

app.get("/api/analytics/compare", authMiddleware, roleMiddleware("teacher", "admin"), async (req, res) => {
  const studentIdsParam = req.query.student_ids as string;
  const quizId = req.query.quiz_id as string;

  if (!studentIdsParam) {
    res.status(400).json({ error: "student_ids query parameter required" });
    return;
  }

  const studentIds = studentIdsParam.split(",");

  const comparison = await Promise.all(
    studentIds.map(async (sid) => {
      const [student] = await db.select().from(users).where(eq(users.id, sid)).limit(1);
      let attemptsQuery = db
        .select()
        .from(quizAttempts)
        .where(eq(quizAttempts.student_id, sid))
        .orderBy(desc(quizAttempts.submitted_at));

      const allAttempts = await attemptsQuery;
      const filteredAttempts = quizId
        ? allAttempts.filter((a) => a.quiz_id === quizId && a.status === "evaluated")
        : allAttempts.filter((a) => a.status === "evaluated");

      const avgPct = filteredAttempts.length > 0
        ? Math.round(
            (filteredAttempts.reduce((s, a) => s + (parseDecimal(a.percentage) ?? 0), 0) /
              filteredAttempts.length) *
              100
          ) / 100
        : 0;

      return {
        student_id: sid,
        student_name: student?.name ?? "Unknown",
        attempt_count: filteredAttempts.length,
        avg_percentage: avgPct,
        best_percentage: filteredAttempts.length > 0
          ? Math.max(...filteredAttempts.map((a) => parseDecimal(a.percentage) ?? 0))
          : 0,
        attempts: filteredAttempts.slice(0, 5).map((a) => ({
          quiz_id: a.quiz_id,
          score: a.score,
          total_marks: a.total_marks,
          percentage: parseDecimal(a.percentage),
          submitted_at: a.submitted_at?.toISOString(),
        })),
      };
    })
  );

  res.json({ comparison });
});

// ========================================================================
// AI AGENT ROUTES
// ========================================================================

app.post("/api/agent/generate-quiz", authMiddleware, roleMiddleware("teacher", "admin"), async (req: AuthRequest, res) => {
  const { topic_id, num_questions, question_types, difficulty } = req.body;
  if (!topic_id) {
    res.status(400).json({ error: "topic_id is required" });
    return;
  }

  const [topic] = await db.select().from(topics).where(eq(topics.id, topic_id)).limit(1);
  if (!topic) {
    res.status(404).json({ error: "Topic not found" });
    return;
  }

  // Gather material text
  const mats = await db.select().from(materials).where(eq(materials.topic_id, topic_id));
  const materialText = mats
    .filter((m) => m.extracted_text)
    .map((m) => m.extracted_text)
    .join("\n\n");

  const prompt =
    `Generate a quiz for the topic "${topic.title}" (${topic.subject}, ${topic.grade_level || "General"}).\n` +
    `Number of questions: ${num_questions || 5}\n` +
    `Question types: ${(question_types || ["mcq"]).join(", ")}\n` +
    `Difficulty: ${difficulty || "mixed"}\n` +
    (materialText
      ? `\nStudy Material Text:\n${materialText.slice(0, 5000)}\n`
      : "\nNo study material uploaded. Generate questions based on the topic title and subject.") +
    `\nUse the generate_quiz tool to create the questions. Then return the generated questions as a JSON array.`;

  try {
    const options = await buildAgentOptions();
    let resultText = "";

    const AGENT_TIMEOUT_MS = 120_000;
    let timedOut = false;

    const agentPromise = (async () => {
      for await (const msg of query({ prompt, options })) {
        if (msg.type === "result" && msg.subtype === "success") {
          resultText = msg.result ?? "";
        }
      }
    })();

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve();
      }, AGENT_TIMEOUT_MS);
    });

    await Promise.race([agentPromise, timeoutPromise]);
    clearTimeout(timeoutHandle!);

    if (timedOut && !resultText) {
      res.status(504).json({ error: "Quiz generation timed out. Please try again." });
      return;
    }

    // Try to parse generated questions from agent result
    let generatedQuestions: Array<{
      question_text: string;
      question_type: string;
      options: string[] | null;
      correct_answer: string;
      marks: number;
      explanation: string;
      difficulty: string;
      order_index: number;
    }> = [];

    try {
      // Try to extract JSON array from the result
      const jsonMatch = resultText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        generatedQuestions = JSON.parse(jsonMatch[0]);
      }
    } catch {
      // If parsing fails, return raw result
    }

    // If we have questions, create a quiz and store them
    if (generatedQuestions.length > 0) {
      const quizId = genId();
      const totalMarks = generatedQuestions.reduce((sum, q) => sum + (q.marks || 1), 0);

      await db.insert(quizzes).values({
        id: quizId,
        title: `${topic.title} - AI Generated Quiz`,
        topic_id,
        teacher_id: req.user!.userId,
        quiz_type: "practice",
        status: "draft",
        total_marks: totalMarks,
      });

      for (const q of generatedQuestions) {
        await db.insert(questions).values({
          id: genId(),
          quiz_id: quizId,
          question_text: q.question_text,
          question_type: q.question_type || "mcq",
          options: q.options || null,
          correct_answer: q.correct_answer,
          marks: q.marks || 1,
          explanation: q.explanation || null,
          difficulty: q.difficulty || "medium",
          order_index: q.order_index || 0,
        });
      }

      res.json({
        quiz_id: quizId,
        title: `${topic.title} - AI Generated Quiz`,
        questions_generated: generatedQuestions.length,
        total_marks: totalMarks,
        status: "draft",
        questions: generatedQuestions,
      });
    } else {
      // Return raw agent output if no structured questions found
      res.json({ raw_result: resultText, questions_generated: 0 });
    }
  } catch (err) {
    console.error("AI quiz generation error:", err);
    res.status(500).json({ error: "Failed to generate quiz. Please try again." });
  }
});

app.post("/api/agent/evaluate", authMiddleware, async (req: AuthRequest, res) => {
  const { attempt_id } = req.body;
  if (!attempt_id) {
    res.status(400).json({ error: "attempt_id is required" });
    return;
  }

  const [attempt] = await db
    .select()
    .from(quizAttempts)
    .where(eq(quizAttempts.id, attempt_id))
    .limit(1);

  if (!attempt) {
    res.status(404).json({ error: "Attempt not found" });
    return;
  }

  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, attempt.quiz_id)).limit(1);
  const [topic] = quiz
    ? await db.select().from(topics).where(eq(topics.id, quiz.topic_id)).limit(1)
    : [null];

  const answers = await db
    .select()
    .from(studentAnswers)
    .where(eq(studentAnswers.attempt_id, attempt_id));

  // Get corresponding questions
  const questionIds = answers.map((a) => a.question_id);
  const qs = questionIds.length > 0
    ? await db.select().from(questions).where(inArray(questions.id, questionIds))
    : [];
  const questionMap = new Map(qs.map((q) => [q.id, q]));

  // Build prompt for AI evaluation (primarily for short answer questions)
  const shortAnswers = answers.filter((a) => {
    const q = questionMap.get(a.question_id);
    return q?.question_type === "short_answer";
  });

  if (shortAnswers.length === 0) {
    res.json({ message: "No short-answer questions to evaluate with AI", attempt_id });
    return;
  }

  const evaluationData = shortAnswers.map((a) => {
    const q = questionMap.get(a.question_id)!;
    return {
      question_id: a.question_id,
      question_text: q.question_text,
      question_type: q.question_type,
      student_answer: a.answer_text || "",
      correct_answer: q.correct_answer,
      marks: q.marks,
    };
  });

  const prompt =
    `Evaluate the following short-answer responses for the quiz "${quiz?.title ?? "Quiz"}" ` +
    `(Subject: ${topic?.subject ?? "General"}).\n\n` +
    `Use the evaluate_answers tool with the following data:\n` +
    JSON.stringify(
      {
        attempt_id,
        quiz_title: quiz?.title ?? "Quiz",
        subject: topic?.subject ?? "General",
        answers: evaluationData,
      },
      null,
      2
    );

  try {
    const options = await buildAgentOptions();
    let resultText = "";

    for await (const msg of query({ prompt, options })) {
      if (msg.type === "result" && msg.subtype === "success") {
        resultText = msg.result ?? "";
      }
    }

    res.json({ attempt_id, ai_evaluation: resultText });
  } catch (err) {
    console.error("AI evaluation error:", err);
    res.status(500).json({ error: "AI evaluation failed" });
  }
});

app.post("/api/agent/chat", authMiddleware, async (req: AuthRequest, res) => {
  const { message, conversation_id, topic_id } = req.body;
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  let convId = conversation_id;
  let agentSessionId: string | null = null;

  if (convId) {
    const [existing] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, convId))
      .limit(1);
    if (existing) {
      agentSessionId = existing.agent_session_id;
    } else {
      convId = null;
    }
  }

  if (!convId) {
    convId = genId();
    await db.insert(conversations).values({
      id: convId,
      user_id: req.user!.userId,
      topic_id: topic_id || null,
      title: message.slice(0, 50),
    });
  }

  // Store user message
  await db.insert(messages).values({
    conversation_id: convId,
    role: "user",
    text: message,
  });

  // Build context
  let context = "";
  if (topic_id) {
    const [topic] = await db.select().from(topics).where(eq(topics.id, topic_id)).limit(1);
    if (topic) {
      context += `Topic: ${topic.title} (${topic.subject}, ${topic.grade_level ?? "General"})\n`;
      if (topic.description) context += `Description: ${topic.description}\n`;

      const mats = await db.select().from(materials).where(eq(materials.topic_id, topic_id));
      const materialText = mats
        .filter((m) => m.extracted_text)
        .map((m) => m.extracted_text)
        .join("\n\n");
      if (materialText) {
        context += `\nStudy Material:\n${materialText.slice(0, 3000)}\n`;
      }
    }
  }

  const fullPrompt = agentSessionId
    ? message
    : `${context}\n\nUser: ${message}`;

  try {
    const options: Options = {
      ...(await buildAgentOptions()),
      ...(agentSessionId ? { resume: agentSessionId } : {}),
    };

    let resultText = "";
    let sessionId: string | null = null;

    for await (const msg of query({ prompt: fullPrompt, options })) {
      if (msg.type === "result") {
        sessionId = msg.session_id;
        if (msg.subtype === "success") {
          resultText = msg.result ?? "";
        }
      }
    }

    const finalText = resultText || "I'm having trouble processing your question. Could you try rephrasing?";

    // Store agent reply and update conversation
    await db.insert(messages).values({
      conversation_id: convId,
      role: "agent",
      text: finalText,
    });
    await db
      .update(conversations)
      .set({ agent_session_id: sessionId, updated_at: new Date() })
      .where(eq(conversations.id, convId));

    res.json({
      result: finalText,
      conversation_id: convId,
    });
  } catch (err) {
    console.error("Agent chat error:", err);
    const fallback = "Something went wrong. Please try again.";
    await db.insert(messages).values({
      conversation_id: convId,
      role: "agent",
      text: fallback,
    }).catch(() => {});

    res.status(500).json({ error: "Chat failed", result: fallback, conversation_id: convId });
  }
});

// ========================================================================
// ANALYTICS ROUTES
// ========================================================================

app.get("/api/analytics/student/:id", authMiddleware, async (req: AuthRequest, res) => {
  const studentId = param(req, "id");

  // Students can only view their own analytics
  if (req.user!.role === "student" && req.user!.userId !== studentId) {
    res.status(403).json({ error: "You can only view your own analytics" });
    return;
  }

  const attempts = await db
    .select()
    .from(quizAttempts)
    .where(eq(quizAttempts.student_id, studentId))
    .orderBy(desc(quizAttempts.submitted_at));

  const enriched = await Promise.all(
    attempts.map(async (a) => {
      const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, a.quiz_id)).limit(1);
      const [topic] = quiz
        ? await db.select().from(topics).where(eq(topics.id, quiz.topic_id)).limit(1)
        : [null];
      return {
        attempt_id: a.id,
        quiz_title: quiz?.title ?? "Unknown",
        subject: topic?.subject ?? "Unknown",
        score: a.score ?? 0,
        total_marks: a.total_marks,
        percentage: parseDecimal(a.percentage) ?? 0,
        status: a.status,
        submitted_at: a.submitted_at?.toISOString() ?? "",
      };
    })
  );

  const completedAttempts = enriched.filter((a) => a.status === "evaluated");
  const totalAttempts = completedAttempts.length;
  const avgPercentage =
    totalAttempts > 0
      ? Math.round(
          (completedAttempts.reduce((sum, a) => sum + a.percentage, 0) / totalAttempts) * 100
        ) / 100
      : 0;

  // Subject breakdown
  const subjectMap = new Map<string, number[]>();
  for (const a of completedAttempts) {
    if (!subjectMap.has(a.subject)) subjectMap.set(a.subject, []);
    subjectMap.get(a.subject)!.push(a.percentage);
  }
  const subjects = Array.from(subjectMap.entries()).map(([subject, percs]) => ({
    subject,
    attempts: percs.length,
    avg_percentage: Math.round((percs.reduce((a, b) => a + b, 0) / percs.length) * 100) / 100,
  }));

  res.json({
    student_id: studentId,
    total_attempts: totalAttempts,
    avg_percentage: avgPercentage,
    subjects,
    recent_attempts: enriched.slice(0, 10),
  });
});

app.get("/api/analytics/quiz/:id", authMiddleware, roleMiddleware("teacher", "admin"), async (req, res) => {
  const quizId = param(req, "id");
  const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, quizId)).limit(1);
  if (!quiz) {
    res.status(404).json({ error: "Quiz not found" });
    return;
  }

  const attempts = await db
    .select()
    .from(quizAttempts)
    .where(eq(quizAttempts.quiz_id, quizId));

  const completedAttempts = attempts.filter((a) => a.status === "evaluated");
  const totalAttempts = completedAttempts.length;
  const avgScore =
    totalAttempts > 0
      ? Math.round(
          (completedAttempts.reduce((sum, a) => sum + (a.score ?? 0), 0) / totalAttempts) * 100
        ) / 100
      : 0;
  const avgPercentage =
    totalAttempts > 0
      ? Math.round(
          (completedAttempts.reduce((sum, a) => sum + (parseDecimal(a.percentage) ?? 0), 0) /
            totalAttempts) *
            100
        ) / 100
      : 0;

  const passCount = completedAttempts.filter(
    (a) => (parseDecimal(a.percentage) ?? 0) >= quiz.pass_percentage
  ).length;

  res.json({
    quiz_id: quizId,
    quiz_title: quiz.title,
    total_attempts: totalAttempts,
    avg_score: avgScore,
    avg_percentage: avgPercentage,
    pass_rate: totalAttempts > 0 ? Math.round((passCount / totalAttempts) * 100 * 100) / 100 : 0,
    highest_score: completedAttempts.length > 0 ? Math.max(...completedAttempts.map((a) => a.score ?? 0)) : 0,
    lowest_score: completedAttempts.length > 0 ? Math.min(...completedAttempts.map((a) => a.score ?? 0)) : 0,
  });
});

app.get("/api/analytics/organization/:id", authMiddleware, roleMiddleware("admin"), async (req, res) => {
  const orgId = param(req, "id");

  const orgUsers = await db.select().from(users).where(eq(users.organization_id, orgId));
  const teacherCount = orgUsers.filter((u) => u.role === "teacher").length;
  const studentCount = orgUsers.filter((u) => u.role === "student").length;

  const studentIds = orgUsers.filter((u) => u.role === "student").map((u) => u.id);
  let totalAttempts = 0;
  let avgPercentage = 0;

  if (studentIds.length > 0) {
    const attempts = await db
      .select()
      .from(quizAttempts)
      .where(inArray(quizAttempts.student_id, studentIds));

    const completed = attempts.filter((a) => a.status === "evaluated");
    totalAttempts = completed.length;
    avgPercentage =
      totalAttempts > 0
        ? Math.round(
            (completed.reduce((sum, a) => sum + (parseDecimal(a.percentage) ?? 0), 0) / totalAttempts) *
              100
          ) / 100
        : 0;
  }

  res.json({
    organization_id: orgId,
    teacher_count: teacherCount,
    student_count: studentCount,
    total_quiz_attempts: totalAttempts,
    avg_percentage: avgPercentage,
  });
});

app.get("/api/analytics/dashboard", authMiddleware, async (req: AuthRequest, res) => {
  if (req.user!.role === "student") {
    // Student dashboard - rich data
    const attempts = await db
      .select()
      .from(quizAttempts)
      .where(eq(quizAttempts.student_id, req.user!.userId))
      .orderBy(desc(quizAttempts.submitted_at));

    const completed = attempts.filter((a) => a.status === "evaluated");
    const [availableQuizzesRow] = await db
      .select({ value: count() })
      .from(quizzes)
      .where(eq(quizzes.status, "published"));

    const avgPercentage = completed.length > 0
      ? Math.round((completed.reduce((sum, a) => sum + (parseDecimal(a.percentage) ?? 0), 0) / completed.length) * 100) / 100
      : 0;

    const passedCount = completed.filter((a) => (parseDecimal(a.percentage) ?? 0) >= 40).length;
    const perfectCount = completed.filter((a) => (parseDecimal(a.percentage) ?? 0) === 100).length;
    const bestScore = completed.length > 0 ? Math.max(...completed.map((a) => parseDecimal(a.percentage) ?? 0)) : 0;

    // Recent attempts with quiz info
    const recentAttempts = await Promise.all(
      completed.slice(0, 5).map(async (a) => {
        const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, a.quiz_id)).limit(1);
        const [topic] = quiz ? await db.select().from(topics).where(eq(topics.id, quiz.topic_id)).limit(1) : [null];
        return {
          quiz_title: quiz?.title ?? "Unknown",
          subject: topic?.subject ?? "Unknown",
          score: a.score ?? 0,
          total_marks: a.total_marks,
          percentage: parseDecimal(a.percentage) ?? 0,
          submitted_at: a.submitted_at?.toISOString() ?? "",
        };
      })
    );

    // Subject breakdown
    const subjectMap = new Map<string, number[]>();
    for (const a of recentAttempts) {
      if (!subjectMap.has(a.subject)) subjectMap.set(a.subject, []);
      subjectMap.get(a.subject)!.push(a.percentage);
    }
    const subjects = Array.from(subjectMap.entries()).map(([subject, percs]) => ({
      subject,
      avg: Math.round((percs.reduce((x, y) => x + y, 0) / percs.length) * 100) / 100,
      count: percs.length,
    }));

    // Available quizzes not yet attempted
    const allPublished = await db.select().from(quizzes).where(eq(quizzes.status, "published"));
    const attemptedQuizIds = new Set(attempts.map((a) => a.quiz_id));
    const unattempted = await Promise.all(
      allPublished.filter((q) => !attemptedQuizIds.has(q.id)).slice(0, 5).map(async (q) => {
        const [topic] = await db.select().from(topics).where(eq(topics.id, q.topic_id)).limit(1);
        return {
          id: q.id,
          title: q.title,
          subject: topic?.subject ?? "Unknown",
          total_marks: q.total_marks,
          time_limit: q.time_limit_minutes,
          question_count: Number((await db.select({ value: count() }).from(questions).where(eq(questions.quiz_id, q.id)))[0]?.value ?? 0),
        };
      })
    );

    // Get gamification profile
    let [profile] = await db
      .select()
      .from(studentProfiles)
      .where(eq(studentProfiles.user_id, req.user!.userId))
      .limit(1);

    if (!profile) {
      await db.insert(studentProfiles).values({ user_id: req.user!.userId });
      [profile] = await db
        .select()
        .from(studentProfiles)
        .where(eq(studentProfiles.user_id, req.user!.userId))
        .limit(1);
    }

    const nextLevelXp = Math.pow(profile.level, 2) * 100;
    const prevLevelXp = Math.pow(profile.level - 1, 2) * 100;
    const xpInLevel = profile.xp_total - prevLevelXp;
    const xpNeeded = nextLevelXp - prevLevelXp;

    // Get leaderboard rank
    const weekKey = getWeekKey(new Date());
    const weeklyEntries = await db
      .select()
      .from(leaderboardEntries)
      .where(
        and(
          eq(leaderboardEntries.period, "weekly"),
          eq(leaderboardEntries.period_key, weekKey)
        )
      )
      .orderBy(desc(leaderboardEntries.xp));
    const myRank = weeklyEntries.findIndex((e) => e.user_id === req.user!.userId) + 1;

    // Top 5 for leaderboard widget
    const top5 = await Promise.all(
      weeklyEntries.slice(0, 5).map(async (e, i) => {
        const [u] = await db.select().from(users).where(eq(users.id, e.user_id)).limit(1);
        return { rank: i + 1, name: u?.name ?? "Unknown", xp: e.xp };
      })
    );

    // Daily challenge
    const today = new Date();
    const dayOfYear = Math.floor(
      (today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000
    );
    const allPublishedForChallenge = await db.select().from(quizzes).where(eq(quizzes.status, "published"));
    let dailyChallenge = null;
    if (allPublishedForChallenge.length > 0) {
      const cq = allPublishedForChallenge[dayOfYear % allPublishedForChallenge.length];
      const [ct] = await db.select().from(topics).where(eq(topics.id, cq.topic_id)).limit(1);
      dailyChallenge = {
        id: cq.id,
        title: cq.title,
        subject: ct?.subject ?? "Unknown",
        bonus_xp: 50,
      };
    }

    res.json({
      role: "student",
      user_name: (await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1))[0]?.name ?? "",
      stats: {
        available_quizzes: Number(availableQuizzesRow?.value ?? 0),
        completed: completed.length,
        in_progress: attempts.filter((a) => a.status === "in_progress").length,
        avg_percentage: avgPercentage,
        best_score: bestScore,
        passed: passedCount,
        perfect_scores: perfectCount,
        total_marks_earned: completed.reduce((sum, a) => sum + (a.score ?? 0), 0),
      },
      gamification: {
        xp_total: profile.xp_total,
        level: profile.level,
        xp_in_level: xpInLevel,
        xp_needed: xpNeeded,
        xp_progress: xpNeeded > 0 ? Math.round((xpInLevel / xpNeeded) * 100) : 100,
        current_streak: profile.current_streak,
        longest_streak: profile.longest_streak,
        badges: (profile.badges || []).map((b: string) => ({
          id: b,
          ...(BADGE_DEFINITIONS[b] || { condition: b, icon: "\u2B50" }),
        })),
        quizzes_completed: profile.quizzes_completed,
        perfect_scores_total: profile.perfect_scores,
      },
      leaderboard: {
        my_rank: myRank || null,
        top5,
      },
      daily_challenge: dailyChallenge,
      recent_attempts: recentAttempts,
      subjects,
      challenges: unattempted,
    });
  } else if (req.user!.role === "teacher") {
    // Teacher dashboard - rich data
    const teacherQuizzes = await db
      .select()
      .from(quizzes)
      .where(eq(quizzes.teacher_id, req.user!.userId))
      .orderBy(desc(quizzes.created_at));

    const quizIds = teacherQuizzes.map((q) => q.id);

    let allAttempts: Array<{ quiz_id: string; score: number | null; total_marks: number; percentage: string | null; status: string; student_id: string; submitted_at: Date | null }> = [];
    if (quizIds.length > 0) {
      allAttempts = await db.select().from(quizAttempts).where(inArray(quizAttempts.quiz_id, quizIds));
    }
    const completedAttempts = allAttempts.filter((a) => a.status === "evaluated");
    const uniqueStudents = new Set(allAttempts.map((a) => a.student_id)).size;
    const avgScore = completedAttempts.length > 0
      ? Math.round((completedAttempts.reduce((sum, a) => sum + (parseDecimal(a.percentage) ?? 0), 0) / completedAttempts.length) * 100) / 100
      : 0;

    const [teacherTopicsRow] = await db
      .select({ value: count() })
      .from(topics)
      .where(eq(topics.teacher_id, req.user!.userId));

    // Per-quiz performance
    const quizPerformance = await Promise.all(
      teacherQuizzes.slice(0, 6).map(async (q) => {
        const qAttempts = completedAttempts.filter((a) => a.quiz_id === q.id);
        const [topic] = await db.select().from(topics).where(eq(topics.id, q.topic_id)).limit(1);
        const qCount = Number((await db.select({ value: count() }).from(questions).where(eq(questions.quiz_id, q.id)))[0]?.value ?? 0);
        return {
          id: q.id,
          title: q.title,
          subject: topic?.subject ?? "Unknown",
          status: q.status,
          question_count: qCount,
          attempt_count: qAttempts.length,
          avg_score: qAttempts.length > 0 ? Math.round((qAttempts.reduce((s, a) => s + (parseDecimal(a.percentage) ?? 0), 0) / qAttempts.length) * 100) / 100 : null,
          pass_rate: qAttempts.length > 0 ? Math.round((qAttempts.filter((a) => (parseDecimal(a.percentage) ?? 0) >= q.pass_percentage).length / qAttempts.length) * 100) : null,
        };
      })
    );

    // Recent student activity
    const recentActivity = await Promise.all(
      completedAttempts.slice(0, 5).map(async (a) => {
        const [student] = await db.select().from(users).where(eq(users.id, a.student_id)).limit(1);
        const [quiz] = await db.select().from(quizzes).where(eq(quizzes.id, a.quiz_id)).limit(1);
        return {
          student_name: student?.name ?? "Unknown",
          quiz_title: quiz?.title ?? "Unknown",
          percentage: parseDecimal(a.percentage) ?? 0,
          submitted_at: a.submitted_at?.toISOString() ?? "",
        };
      })
    );

    res.json({
      role: "teacher",
      user_name: (await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1))[0]?.name ?? "",
      stats: {
        total_quizzes: teacherQuizzes.length,
        published: teacherQuizzes.filter((q) => q.status === "published").length,
        drafts: teacherQuizzes.filter((q) => q.status === "draft").length,
        total_topics: Number(teacherTopicsRow?.value ?? 0),
        total_attempts: allAttempts.length,
        unique_students: uniqueStudents,
        avg_score: avgScore,
      },
      quiz_performance: quizPerformance,
      recent_activity: recentActivity,
    });
  } else {
    // Admin dashboard - rich data
    const [userCount] = await db.select({ value: count() }).from(users);
    const [quizCount] = await db.select({ value: count() }).from(quizzes);
    const [topicCount] = await db.select({ value: count() }).from(topics);
    const [orgCount] = await db.select({ value: count() }).from(organizations);
    const [attemptCount] = await db.select({ value: count() }).from(quizAttempts);

    const teacherRows = await db.select().from(users).where(eq(users.role, "teacher"));
    const studentRows = await db.select().from(users).where(eq(users.role, "student"));

    const allAttempts = await db.select().from(quizAttempts).where(eq(quizAttempts.status, "evaluated"));
    const avgScore = allAttempts.length > 0
      ? Math.round((allAttempts.reduce((sum, a) => sum + (parseDecimal(a.percentage) ?? 0), 0) / allAttempts.length) * 100) / 100
      : 0;

    const recentQuizzes = await Promise.all(
      (await db.select().from(quizzes).orderBy(desc(quizzes.created_at)).limit(5)).map(async (q) => {
        const [topic] = await db.select().from(topics).where(eq(topics.id, q.topic_id)).limit(1);
        const [teacher] = await db.select().from(users).where(eq(users.id, q.teacher_id)).limit(1);
        return { title: q.title, subject: topic?.subject ?? "", teacher: teacher?.name ?? "", status: q.status, created_at: q.created_at?.toISOString() ?? "" };
      })
    );

    res.json({
      role: "admin",
      stats: {
        total_users: Number(userCount?.value ?? 0),
        teachers: teacherRows.length,
        students: studentRows.length,
        total_quizzes: Number(quizCount?.value ?? 0),
        total_topics: Number(topicCount?.value ?? 0),
        total_organizations: Number(orgCount?.value ?? 0),
        total_attempts: Number(attemptCount?.value ?? 0),
        avg_score: avgScore,
      },
      recent_quizzes: recentQuizzes,
    });
  }
});

// ── Start Server ──

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (non-fatal):", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (non-fatal):", err);
});

const PORT = parseInt(process.env.PORT ?? "3456", 10);

async function startup(): Promise<void> {
  await runMigrations();
  await seedDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  Smart Quiz Agent running at http://localhost:${PORT}\n`);
  });
}

startup().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
