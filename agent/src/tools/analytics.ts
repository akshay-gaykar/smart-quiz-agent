/** Analytics tools - performance tracking and insights. */

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";

export const getPerformanceAnalytics = tool(
  "get_performance_analytics",
  "Retrieve performance analytics for a student, quiz, or organization. " +
    "Aggregates scores, identifies trends, and highlights weak topics. " +
    "Returns a structured performance summary with actionable metrics.",
  {
    entity_type: z
      .enum(["student", "quiz", "organization"])
      .describe("Type of entity to get analytics for"),
    entity_id: z.string().describe("ID of the student, quiz, or organization"),
    time_range: z
      .enum(["week", "month", "quarter", "year", "all"])
      .optional()
      .describe("Time range for analytics"),
    attempts_data: z
      .array(
        z.object({
          attempt_id: z.string(),
          quiz_title: z.string(),
          subject: z.string(),
          score: z.number(),
          total_marks: z.number(),
          percentage: z.number(),
          submitted_at: z.string(),
          status: z.string(),
        })
      )
      .describe("Array of quiz attempt data to analyze"),
  },
  async (args) => {
    const { entity_type, entity_id, time_range, attempts_data } = args;

    const completedAttempts = attempts_data.filter((a) => a.status === "evaluated");
    const totalAttempts = completedAttempts.length;

    if (totalAttempts === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                entity_type,
                entity_id,
                time_range: time_range ?? "all",
                message: "No completed quiz attempts found for this entity.",
                summary: { total_attempts: 0 },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    const avgPercentage =
      Math.round(
        (completedAttempts.reduce((sum, a) => sum + a.percentage, 0) / totalAttempts) * 100
      ) / 100;

    const totalScore = completedAttempts.reduce((sum, a) => sum + a.score, 0);
    const totalMarks = completedAttempts.reduce((sum, a) => sum + a.total_marks, 0);

    // Subject-wise breakdown
    const subjectMap = new Map<
      string,
      { scores: number[]; percentages: number[]; count: number }
    >();
    for (const attempt of completedAttempts) {
      const subj = attempt.subject;
      if (!subjectMap.has(subj)) {
        subjectMap.set(subj, { scores: [], percentages: [], count: 0 });
      }
      const entry = subjectMap.get(subj)!;
      entry.scores.push(attempt.score);
      entry.percentages.push(attempt.percentage);
      entry.count++;
    }

    const subjectBreakdown = Array.from(subjectMap.entries()).map(([subject, data]) => ({
      subject,
      attempts: data.count,
      avg_percentage:
        Math.round((data.percentages.reduce((a, b) => a + b, 0) / data.count) * 100) / 100,
      best_score: Math.max(...data.percentages),
      needs_improvement: data.percentages.reduce((a, b) => a + b, 0) / data.count < 60,
    }));

    // Sort by performance (worst first for improvement areas)
    subjectBreakdown.sort((a, b) => a.avg_percentage - b.avg_percentage);

    const weakSubjects = subjectBreakdown
      .filter((s) => s.needs_improvement)
      .map((s) => s.subject);

    const strongSubjects = subjectBreakdown
      .filter((s) => s.avg_percentage >= 80)
      .map((s) => s.subject);

    // Trend analysis (based on chronological order)
    const sorted = [...completedAttempts].sort(
      (a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime()
    );

    let trend = "stable";
    if (sorted.length >= 3) {
      const firstHalf = sorted.slice(0, Math.floor(sorted.length / 2));
      const secondHalf = sorted.slice(Math.floor(sorted.length / 2));
      const firstAvg =
        firstHalf.reduce((s, a) => s + a.percentage, 0) / firstHalf.length;
      const secondAvg =
        secondHalf.reduce((s, a) => s + a.percentage, 0) / secondHalf.length;

      if (secondAvg - firstAvg > 5) trend = "improving";
      else if (firstAvg - secondAvg > 5) trend = "declining";
    }

    const result = {
      entity_type,
      entity_id,
      time_range: time_range ?? "all",
      summary: {
        total_attempts: totalAttempts,
        total_score: totalScore,
        total_possible_marks: totalMarks,
        overall_percentage: avgPercentage,
        trend,
        pass_rate:
          Math.round(
            (completedAttempts.filter((a) => a.percentage >= 40).length / totalAttempts) *
              100 *
              100
          ) / 100,
      },
      subject_breakdown: subjectBreakdown,
      weak_subjects: weakSubjects,
      strong_subjects: strongSubjects,
      recommendations:
        weakSubjects.length > 0
          ? `Focus on improving in: ${weakSubjects.join(", ")}. ` +
            `Consider additional practice quizzes in these areas.`
          : "Great performance across all subjects! Keep up the good work.",
      recent_attempts: sorted.slice(-5).map((a) => ({
        quiz: a.quiz_title,
        subject: a.subject,
        percentage: a.percentage,
        date: a.submitted_at,
      })),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

export const getTopicInsights = tool(
  "get_topic_insights",
  "Analyze quiz results across all students for a specific topic. " +
    "Provides difficulty analysis, identifies common mistakes, and " +
    "calculates mastery percentage for the topic.",
  {
    topic_id: z.string().describe("The topic identifier"),
    topic_title: z.string().describe("The topic title"),
    subject: z.string().describe("The subject area"),
    question_stats: z
      .array(
        z.object({
          question_id: z.string(),
          question_text: z.string(),
          question_type: z.string(),
          difficulty: z.string(),
          total_attempts: z.number(),
          correct_count: z.number(),
          avg_marks_awarded: z.number(),
          max_marks: z.number(),
          common_wrong_answers: z.array(z.string()).optional(),
        })
      )
      .describe("Per-question statistics across all students"),
    total_students: z.number().describe("Total number of students who attempted quizzes on this topic"),
    avg_score_percentage: z.number().describe("Average score percentage across all attempts"),
  },
  async (args) => {
    const { topic_id, topic_title, subject, question_stats, total_students, avg_score_percentage } =
      args;

    const totalQuestions = question_stats.length;

    // Difficulty analysis
    const difficultyGroups = new Map<string, { count: number; avgCorrectRate: number }>();
    for (const q of question_stats) {
      const rate = q.total_attempts > 0 ? q.correct_count / q.total_attempts : 0;
      if (!difficultyGroups.has(q.difficulty)) {
        difficultyGroups.set(q.difficulty, { count: 0, avgCorrectRate: 0 });
      }
      const group = difficultyGroups.get(q.difficulty)!;
      group.count++;
      group.avgCorrectRate += rate;
    }

    const difficultyAnalysis = Array.from(difficultyGroups.entries()).map(([level, data]) => ({
      level,
      question_count: data.count,
      avg_correct_rate: Math.round((data.avgCorrectRate / data.count) * 100 * 100) / 100,
    }));

    // Most challenging questions (lowest correct rate)
    const challengingQuestions = [...question_stats]
      .map((q) => ({
        ...q,
        correct_rate:
          q.total_attempts > 0
            ? Math.round((q.correct_count / q.total_attempts) * 100 * 100) / 100
            : 0,
      }))
      .sort((a, b) => a.correct_rate - b.correct_rate)
      .slice(0, 5);

    // Mastery calculation
    const masteryPercentage = avg_score_percentage;
    let masteryLevel: string;
    if (masteryPercentage >= 90) masteryLevel = "expert";
    else if (masteryPercentage >= 75) masteryLevel = "proficient";
    else if (masteryPercentage >= 60) masteryLevel = "developing";
    else if (masteryPercentage >= 40) masteryLevel = "basic";
    else masteryLevel = "needs_attention";

    const result = {
      topic_id,
      topic_title,
      subject,
      overview: {
        total_students,
        total_questions: totalQuestions,
        avg_score_percentage: avg_score_percentage,
        mastery_level: masteryLevel,
        mastery_percentage: masteryPercentage,
      },
      difficulty_analysis: difficultyAnalysis,
      most_challenging_questions: challengingQuestions.map((q) => ({
        question: q.question_text.slice(0, 100),
        type: q.question_type,
        difficulty: q.difficulty,
        correct_rate: q.correct_rate,
        common_mistakes: q.common_wrong_answers ?? [],
      })),
      recommendations:
        masteryLevel === "needs_attention"
          ? "This topic needs significant review. Consider simplifying material and providing more practice."
          : masteryLevel === "basic"
            ? "Students have basic understanding. More practice questions and worked examples would help."
            : masteryLevel === "developing"
              ? "Good progress. Focus on the challenging questions identified above."
              : "Students are performing well. Consider introducing more advanced material.",
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

export const analyticsTools = [getPerformanceAnalytics, getTopicInsights];
