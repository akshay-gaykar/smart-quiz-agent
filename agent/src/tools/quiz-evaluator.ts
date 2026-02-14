/** Quiz evaluation tool - auto-grades student answers with AI feedback. */

import { z } from "zod";
import { tool } from "@anthropic-ai/claude-agent-sdk";

export const evaluateAnswers = tool(
  "evaluate_answers",
  "Evaluate a student's quiz answers. Auto-grades MCQ and True/False questions by " +
    "direct comparison. For short-answer questions, provides AI judgment with partial " +
    "credit and detailed feedback. Returns a score breakdown with per-question analysis.",
  {
    attempt_id: z.string().describe("The quiz attempt identifier"),
    quiz_title: z.string().describe("Title of the quiz for context"),
    subject: z.string().describe("Subject area for contextual evaluation"),
    answers: z
      .array(
        z.object({
          question_id: z.string(),
          question_text: z.string(),
          question_type: z.enum(["mcq", "true_false", "short_answer"]),
          student_answer: z.string().describe("The student's submitted answer"),
          correct_answer: z.string().describe("The correct/expected answer"),
          marks: z.number().describe("Maximum marks for this question"),
          options: z.array(z.string()).optional().describe("Available options for MCQ"),
        })
      )
      .describe("Array of answers to evaluate"),
  },
  async (args) => {
    const { attempt_id, quiz_title, subject, answers } = args;

    const evaluatedAnswers: Array<{
      question_id: string;
      question_text: string;
      question_type: string;
      student_answer: string;
      correct_answer: string;
      is_correct: boolean;
      marks_awarded: number;
      max_marks: number;
      feedback: string;
    }> = [];

    let totalScore = 0;
    let totalMarks = 0;

    for (const answer of answers) {
      totalMarks += answer.marks;
      let isCorrect = false;
      let marksAwarded = 0;
      let feedback = "";

      switch (answer.question_type) {
        case "mcq":
        case "true_false": {
          const studentNorm = answer.student_answer.trim().toLowerCase();
          const correctNorm = answer.correct_answer.trim().toLowerCase();
          isCorrect = studentNorm === correctNorm;
          marksAwarded = isCorrect ? answer.marks : 0;
          feedback = isCorrect
            ? "Correct!"
            : `Incorrect. The correct answer is: ${answer.correct_answer}`;
          break;
        }

        case "short_answer": {
          // AI evaluation placeholder - the agent will use its judgment
          const studentLower = answer.student_answer.trim().toLowerCase();
          const correctLower = answer.correct_answer.trim().toLowerCase();

          if (studentLower === correctLower) {
            isCorrect = true;
            marksAwarded = answer.marks;
            feedback = "Correct! Exact match with expected answer.";
          } else if (
            correctLower.split(" ").some((word) => studentLower.includes(word)) &&
            answer.student_answer.trim().length > 0
          ) {
            // Partial credit for short answers containing key terms
            marksAwarded = Math.ceil(answer.marks * 0.5);
            isCorrect = false;
            feedback =
              `[AI should evaluate this answer more carefully]\n` +
              `Student wrote: "${answer.student_answer}"\n` +
              `Expected answer contains: "${answer.correct_answer}"\n` +
              `Partial credit awarded. The AI should assess semantic similarity ` +
              `and provide detailed feedback on what was correct and what was missing.`;
          } else {
            isCorrect = false;
            marksAwarded = 0;
            feedback =
              `Incorrect. The expected answer is: ${answer.correct_answer}. ` +
              `[AI should provide helpful feedback explaining the correct answer ` +
              `and where the student's understanding may have gaps.]`;
          }
          break;
        }
      }

      totalScore += marksAwarded;

      evaluatedAnswers.push({
        question_id: answer.question_id,
        question_text: answer.question_text,
        question_type: answer.question_type,
        student_answer: answer.student_answer,
        correct_answer: answer.correct_answer,
        is_correct: isCorrect,
        marks_awarded: marksAwarded,
        max_marks: answer.marks,
        feedback,
      });
    }

    const percentage = totalMarks > 0 ? Math.round((totalScore / totalMarks) * 100 * 100) / 100 : 0;

    const result = {
      attempt_id,
      quiz_title,
      subject,
      summary: {
        total_score: totalScore,
        total_marks: totalMarks,
        percentage,
        questions_attempted: answers.length,
        correct_count: evaluatedAnswers.filter((a) => a.is_correct).length,
        incorrect_count: evaluatedAnswers.filter((a) => !a.is_correct).length,
        pass_status: percentage >= 40 ? "passed" : "failed",
      },
      type_breakdown: {
        mcq: {
          total: evaluatedAnswers.filter((a) => a.question_type === "mcq").length,
          correct: evaluatedAnswers.filter((a) => a.question_type === "mcq" && a.is_correct).length,
        },
        true_false: {
          total: evaluatedAnswers.filter((a) => a.question_type === "true_false").length,
          correct: evaluatedAnswers.filter(
            (a) => a.question_type === "true_false" && a.is_correct
          ).length,
        },
        short_answer: {
          total: evaluatedAnswers.filter((a) => a.question_type === "short_answer").length,
          correct: evaluatedAnswers.filter(
            (a) => a.question_type === "short_answer" && a.is_correct
          ).length,
        },
      },
      answers: evaluatedAnswers,
      recommendations:
        percentage >= 80
          ? "Excellent performance! Consider more challenging material."
          : percentage >= 60
            ? "Good effort. Review the incorrect answers and their explanations."
            : percentage >= 40
              ? "You passed but there is room for improvement. Focus on weak areas."
              : "Needs improvement. Consider re-studying the material and trying again.",
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

export const quizEvaluatorTools = [evaluateAnswers];
