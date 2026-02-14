/** Seed the database from data/sample_data.json if the users table is empty. */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { count } from "drizzle-orm";
import { db } from "./index.js";
import { organizations, users, topics, quizzes, questions, enrollments, studentProfiles } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDataDir(): string {
  const devPath = resolve(__dirname, "..", "..", "..", "data");
  if (existsSync(resolve(devPath, "sample_data.json"))) return devPath;
  const dockerPath = resolve(__dirname, "..", "..", "data");
  if (existsSync(resolve(dockerPath, "sample_data.json"))) return dockerPath;
  return devPath;
}

const DATA_DIR = resolveDataDir();

function genId(): string {
  return randomBytes(8).toString("hex");
}

export async function seedDatabase(): Promise<void> {
  const [{ value: userCount }] = await db.select({ value: count() }).from(users);
  if (userCount > 0) {
    console.log(`Database already seeded (${userCount} user(s) found). Skipping.`);
    return;
  }

  const samplePath = resolve(DATA_DIR, "sample_data.json");
  if (!existsSync(samplePath)) {
    console.log("No sample_data.json found. Skipping seed.");
    return;
  }

  console.log("Seeding database from sample_data.json...");
  const raw = JSON.parse(readFileSync(samplePath, "utf-8"));

  await db.transaction(async (tx) => {
    // Seed organizations
    if (raw.organizations) {
      for (const org of raw.organizations) {
        await tx.insert(organizations).values({
          id: org.id || genId(),
          name: org.name,
          type: org.type || "school",
          address: org.address || null,
        });
      }
      console.log(`Seeded ${raw.organizations.length} organization(s).`);
    }

    // Seed users (passwords are pre-hashed in seed data)
    if (raw.users) {
      for (const user of raw.users) {
        await tx.insert(users).values({
          id: user.id || genId(),
          email: user.email,
          password_hash: user.password_hash,
          name: user.name,
          role: user.role,
          organization_id: user.organization_id || null,
        });
      }
      console.log(`Seeded ${raw.users.length} user(s).`);
    }

    // Seed topics
    if (raw.topics) {
      for (const topic of raw.topics) {
        await tx.insert(topics).values({
          id: topic.id || genId(),
          title: topic.title,
          description: topic.description || null,
          subject: topic.subject,
          grade_level: topic.grade_level || null,
          teacher_id: topic.teacher_id,
          organization_id: topic.organization_id || null,
        });
      }
      console.log(`Seeded ${raw.topics.length} topic(s).`);
    }

    // Seed quizzes and questions
    if (raw.quizzes) {
      for (const quiz of raw.quizzes) {
        await tx.insert(quizzes).values({
          id: quiz.id || genId(),
          title: quiz.title,
          topic_id: quiz.topic_id,
          teacher_id: quiz.teacher_id,
          quiz_type: quiz.quiz_type || "practice",
          status: quiz.status || "draft",
          time_limit_minutes: quiz.time_limit_minutes || null,
          total_marks: quiz.total_marks || 0,
          pass_percentage: quiz.pass_percentage || 40,
        });

        if (quiz.questions) {
          for (const q of quiz.questions) {
            await tx.insert(questions).values({
              id: q.id || genId(),
              quiz_id: quiz.id,
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
        }
      }
      console.log(`Seeded ${raw.quizzes.length} quiz(zes).`);
    }

    // Seed enrollments
    if (raw.enrollments) {
      for (const enrollment of raw.enrollments) {
        await tx.insert(enrollments).values({
          student_id: enrollment.student_id,
          organization_id: enrollment.organization_id,
        });
      }
      console.log(`Seeded ${raw.enrollments.length} enrollment(s).`);
    }

    // Seed student profiles for gamification
    if (raw.users) {
      const students = raw.users.filter((u: { role: string }) => u.role === "student");
      for (const student of students) {
        await tx.insert(studentProfiles).values({
          user_id: student.id,
          xp_total: 0,
          level: 1,
          current_streak: 0,
          longest_streak: 0,
          badges: [],
          quizzes_completed: 0,
          perfect_scores: 0,
        });
      }
      console.log(`Seeded ${students.length} student profile(s).`);
    }
  });

  console.log("Database seeding complete.");
}

// Allow running directly: tsx src/db/seed.ts
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
