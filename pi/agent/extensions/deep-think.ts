import {
  getMarkdownTheme,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

class DeepThinkView extends Container {
  private readonly title = new Text("", 0, 0);
  private readonly body: Markdown;

  constructor(theme: Theme) {
    super();
    this.body = new Markdown("", 0, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("thinkingText", text),
      italic: true,
    });
    this.addChild(this.title);
    this.addChild(this.body);
  }

  update(thoughts: string, streaming: boolean, theme: Theme): void {
    this.title.setText(
      theme.fg("toolTitle", theme.bold("think")) +
        (streaming ? theme.fg("dim", " (streaming)") : ""),
    );
    this.body.setText(thoughts);
  }
}

export default function deepThinkExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "think",
    label: "Deep Think",
    description:
      "Use this visible scratchpad to reason before answering any non-trivial request. Put the reasoning in thoughts. Call it again when more reasoning is needed.",
    promptSnippet:
      "Reason before answering every non-trivial request in a visible streaming scratchpad",
    promptGuidelines: [
      "Call think before answering every non-trivial user request.",
    ],
    parameters: Type.Object(
      { thoughts: Type.String() },
      { additionalProperties: false },
    ),

    async execute() {
      return {
        content: [
          {
            type: "text",
            text: "Recorded. Continue reasoning or answer the user.",
          },
        ],
        details: {},
      };
    },

    renderCall(args, theme, context) {
      const view =
        context.lastComponent instanceof DeepThinkView
          ? context.lastComponent
          : new DeepThinkView(theme);
      view.update(args.thoughts ?? "", !context.argsComplete, theme);
      return view;
    },

    renderResult(_result, _options, _theme, context) {
      return context.lastComponent ?? new Container();
    },
  });

  const syncAvailability = (): void => {
    const activeTools = pi.getActiveTools();
    const isActive = activeTools.includes("think");
    const shouldBeActive = pi.getThinkingLevel() === "off";
    if (isActive === shouldBeActive) return;
    pi.setActiveTools(
      shouldBeActive
        ? [...activeTools, "think"]
        : activeTools.filter((name) => name !== "think"),
    );
  };

  pi.on("session_start", syncAvailability);
  pi.on("thinking_level_select", (event, ctx) => {
    syncAvailability();
    if (
      event.level === "off" &&
      event.previousLevel !== "off" &&
      ctx.mode === "tui"
    ) {
      ctx.ui.notify(
        "think enabled dynamically. Adding its tool definition and prompt instructions may invalidate the provider prompt cache.",
        "warning",
      );
    }
  });
}
