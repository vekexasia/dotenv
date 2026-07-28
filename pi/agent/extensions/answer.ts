import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import { runQuestionnaire } from "./questionnaire.ts";

interface ExtractedQuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface ExtractedQuestion {
	id: string;
	label?: string;
	prompt: string;
	options: ExtractedQuestionOption[];
	allowOther?: boolean;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

const SYSTEM_PROMPT = `You prepare input for the questionnaire tool. Given text from a conversation, extract any questions that require user input and convert them to questionnaire parameters.

The questionnaire tool has this parameter shape:
{
  "questions": [
    {
      "id": "Unique stable id, e.g. q1",
      "label": "Short tab label, e.g. Q1",
      "prompt": "The question text to show to the user",
      "options": [
        {
          "value": "machine_readable_value",
          "label": "Display label",
          "description": "Optional short explanation"
        }
      ],
      "allowOther": true
    }
  ]
}

Output only JSON with that exact top-level shape.

Rules:
- Extract all questions that require user input.
- Keep questions in the order they appeared.
- Use ids q1, q2, q3, etc. and labels Q1, Q2, Q3, etc.
- If a question contains explicit choices, convert each choice into an option.
- If choices are inline, remove them from prompt once they are represented as options.
- Use concise option values like speed, accuracy, lowest_cost, yes, no, one_by_one.
- Set allowOther to true unless the question explicitly requires one of the listed choices only.
- If there are no explicit choices, use "options": [] and "allowOther": true.
- Include essential context in prompt, not in options.
- If no questions are found, return {"questions": []}.`;

const EXTRACTION_PROVIDER = "openai-codex";
const EXTRACTION_MODEL_ID = "gpt-5.4-mini";

function selectExtractionModel(ctx: ExtensionContext): Model<Api> {
	ctx.modelRegistry.refresh();
	const preferredModel = ctx.modelRegistry.find(EXTRACTION_PROVIDER, EXTRACTION_MODEL_ID);
	return preferredModel ?? ctx.model!;
}

function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		let jsonStr = text;
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) jsonStr = jsonMatch[1].trim();
		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.questions)) {
			return parsed as ExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message and answer them interactively",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("answer requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			const extractionModel = selectExtractionModel(ctx);

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
				loader.onAbort = () => done(null);

				const doExtract = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
					if (auth.ok !== true) {
						throw new Error(auth.error);
					}
					if (!auth.apiKey) {
						throw new Error(`No API key for ${extractionModel.provider}`);
					}
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await complete(
						extractionModel,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				};

				doExtract()
					.then(done)
					.catch((error) => {
						ctx.ui.notify(error instanceof Error ? error.message : "Question extraction failed", "error");
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const extraction = parseExtractionResult(result);
			if (!extraction || extraction.questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return;
			}

			const questions = extraction.questions.map((q, i) => ({
				id: q.id || `q${i + 1}`,
				label: q.label || `Q${i + 1}`,
				prompt: q.context ? `${q.prompt}\n\n${q.context}` : q.prompt,
				options: Array.isArray(q.options) ? q.options : [],
				allowOther: q.allowOther !== false,
			}));

			const questionnaireResult = await runQuestionnaire(pi, ctx, { questions });

			if (questionnaireResult.details.cancelled) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const answerById = new Map(questionnaireResult.details.answers.map((answer) => [answer.id, answer.label]));
			const lines = questions.map((q) => {
				const answer = answerById.get(q.id) || "(no answer)";
				return `Q: ${q.prompt}\nA: ${answer}`;
			});

			pi.sendMessage(
				{
					customType: "answers",
					content: "I answered your questions in the following way:\n\n" + lines.join("\n\n"),
					display: true,
				},
				{ triggerTurn: true },
			);
		},
	});
}
