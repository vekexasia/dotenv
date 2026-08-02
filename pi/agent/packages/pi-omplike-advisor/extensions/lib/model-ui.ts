/** TUI model picker used by the advisor command. */

import { Container, fuzzyFilter, getKeybindings, Input, SelectList, Text, type TUI, type Theme } from "@earendil-works/pi-tui";

export interface AdvisorModelSearchItem {
	provider: string;
	id: string;
	name?: string;
}

export function filterAdvisorModels<T extends AdvisorModelSearchItem>(models: readonly T[], query: string): T[] {
	return fuzzyFilter([...models], query, (model) => `${model.provider}/${model.id} ${model.name ?? ""}`);
}

export interface AdvisorModelPickerItem extends AdvisorModelSearchItem {
	label: string;
}

const ADVISOR_MODEL_PICKER_MAX_ROWS = 8;

export class AdvisorModelPicker extends Container {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly items: readonly AdvisorModelPickerItem[];
	private readonly done: (value: string | undefined) => void;
	private list!: SelectList;
	private closed = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(items: readonly AdvisorModelPickerItem[], tui: TUI, theme: Theme, done: (value: string | undefined) => void) {
		super();
		this.items = items;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.addChild(new Text(theme.fg("accent", "Advisor model"), 1, 0));
		this.addChild(this.searchInput);
		this.addChild(this.listContainer);
		this.addChild(new Text(theme.fg("dim", "up/down move | Enter select | Esc cancel"), 1, 0));
		this.searchInput.onSubmit = () => this.finish(this.list.getSelectedItem()?.value);
		this.searchInput.onEscape = () => this.finish(undefined);
		this.refreshList();
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down")) {
			this.list.handleInput(data);
			this.tui.requestRender();
			return;
		}
		const previousValue = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== previousValue) this.refreshList();
	}

	private refreshList(): void {
		const filtered = filterAdvisorModels(this.items, this.searchInput.getValue());
		const listItems = filtered.map((item) => ({
			value: item.label,
			label: item.label,
			...(item.name ? { description: item.name } : {}),
		}));
		this.list = new SelectList(listItems, Math.min(ADVISOR_MODEL_PICKER_MAX_ROWS, Math.max(1, listItems.length)), {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("warning", text),
		});
		this.listContainer.clear();
		this.listContainer.addChild(this.list);
		this.tui.requestRender();
	}

	private finish(value: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.done(value);
	}
}
