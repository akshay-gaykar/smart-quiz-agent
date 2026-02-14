export { quizGeneratorTools } from "./quiz-generator.js";
export { quizEvaluatorTools } from "./quiz-evaluator.js";
export { analyticsTools } from "./analytics.js";

import { quizGeneratorTools } from "./quiz-generator.js";
import { quizEvaluatorTools } from "./quiz-evaluator.js";
import { analyticsTools } from "./analytics.js";

export const allTools = [
  ...quizGeneratorTools,
  ...quizEvaluatorTools,
  ...analyticsTools,
];
