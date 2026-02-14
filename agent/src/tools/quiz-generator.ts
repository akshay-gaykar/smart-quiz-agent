/** Quiz generation tool - generates quiz questions from topic/material content. */

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";

export const generateQuiz = tool(
  "generate_quiz",
  "Generate quiz questions from a given topic and optional study material text. " +
    "Produces questions with options, correct answers, explanations, and difficulty levels. " +
    "The AI should generate contextually relevant questions based on the provided material.",
  {
    topic_title: z.string().describe("The title of the topic"),
    subject: z.string().describe("The subject area (e.g., Mathematics, Science, History)"),
    grade_level: z.string().optional().describe("The grade level (e.g., Grade 10, College)"),
    num_questions: z.number().min(1).max(50).describe("Number of questions to generate"),
    question_types: z
      .array(z.enum(["mcq", "true_false", "short_answer", "fill_in_blank", "matching", "ordering"]))
      .describe("Types of questions to generate"),
    difficulty: z
      .enum(["easy", "medium", "hard", "mixed"])
      .describe("Difficulty level for questions"),
    material_text: z
      .string()
      .optional()
      .describe("Extracted text from uploaded study materials/PDFs to base questions on"),
  },
  async (args) => {
    const {
      topic_title,
      subject,
      grade_level,
      num_questions,
      question_types,
      difficulty,
      material_text,
    } = args;

    const questionsPerType = Math.ceil(num_questions / question_types.length);
    const generatedQuestions: Array<{
      question_text: string;
      question_type: string;
      options: string[] | null;
      correct_answer: string;
      marks: number;
      explanation: string;
      difficulty: string;
      order_index: number;
    }> = [];

    const difficulties =
      difficulty === "mixed"
        ? ["easy", "medium", "hard"]
        : [difficulty];

    let orderIndex = 0;

    for (const qType of question_types) {
      for (let i = 0; i < questionsPerType && generatedQuestions.length < num_questions; i++) {
        const diff = difficulties[i % difficulties.length];
        orderIndex++;

        let options: any = null;
        let correct_answer = "Sample correct answer";

        if (qType === "mcq") {
          options = ["Option A", "Option B", "Option C", "Option D"];
          correct_answer = "Option A";
        } else if (qType === "true_false") {
          options = ["True", "False"];
          correct_answer = "True";
        } else if (qType === "fill_in_blank") {
          options = {
            sentence: `[AI should generate a sentence about "${topic_title}" with a ___ blank]`,
            acceptable: ["answer1", "answer2"],
          };
          correct_answer = "answer1";
        } else if (qType === "matching") {
          options = {
            pairs: [
              { left: "Term 1", right: "Definition 1" },
              { left: "Term 2", right: "Definition 2" },
              { left: "Term 3", right: "Definition 3" },
            ],
          };
          correct_answer = JSON.stringify([
            { left: "Term 1", right: "Definition 1" },
            { left: "Term 2", right: "Definition 2" },
            { left: "Term 3", right: "Definition 3" },
          ]);
        } else if (qType === "ordering") {
          options = {
            items: ["Step 1", "Step 2", "Step 3", "Step 4"],
            correct_order: [0, 1, 2, 3],
          };
          correct_answer = JSON.stringify([0, 1, 2, 3]);
        }

        const question = {
          question_text: `[AI should generate a ${diff} ${qType} question about "${topic_title}" in ${subject}${grade_level ? ` for ${grade_level}` : ""}${material_text ? " based on the provided study material" : ""}]`,
          question_type: qType,
          options,
          correct_answer,
          marks: diff === "easy" ? 1 : diff === "medium" ? 2 : 3,
          explanation: `[AI should provide a detailed explanation for why this is the correct answer]`,
          difficulty: diff,
          order_index: orderIndex,
        };

        generatedQuestions.push(question);
      }
    }

    const totalMarks = generatedQuestions.reduce((sum, q) => sum + q.marks, 0);

    const result = {
      topic: topic_title,
      subject,
      grade_level: grade_level ?? "Not specified",
      total_questions: generatedQuestions.length,
      total_marks: totalMarks,
      difficulty_distribution: {
        easy: generatedQuestions.filter((q) => q.difficulty === "easy").length,
        medium: generatedQuestions.filter((q) => q.difficulty === "medium").length,
        hard: generatedQuestions.filter((q) => q.difficulty === "hard").length,
      },
      type_distribution: {
        mcq: generatedQuestions.filter((q) => q.question_type === "mcq").length,
        true_false: generatedQuestions.filter((q) => q.question_type === "true_false").length,
        short_answer: generatedQuestions.filter((q) => q.question_type === "short_answer").length,
        fill_in_blank: generatedQuestions.filter((q) => q.question_type === "fill_in_blank").length,
        matching: generatedQuestions.filter((q) => q.question_type === "matching").length,
        ordering: generatedQuestions.filter((q) => q.question_type === "ordering").length,
      },
      questions: generatedQuestions,
      material_used: !!material_text,
      material_preview: material_text ? material_text.slice(0, 200) + "..." : null,
      instructions:
        "IMPORTANT: The question placeholders above must be replaced with actual questions. " +
        "Use the topic, subject, grade level, and material text to generate relevant, " +
        "accurate questions. Each question should test understanding of the subject matter. " +
        "For MCQ: provide 4 distinct options with only one correct. " +
        "For true_false: create clear factual statements. " +
        "For short_answer: ask questions requiring 1-3 sentence responses. " +
        "For fill_in_blank: provide a sentence with ___ and acceptable answers array. " +
        "For matching: provide pairs of left/right items to match. " +
        "For ordering: provide items and their correct_order as index array.",
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

export const quizGeneratorTools = [generateQuiz];
