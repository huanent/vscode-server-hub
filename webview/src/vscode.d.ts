interface VsCodeApi<State = unknown> {
	postMessage(message: unknown): void;
	getState(): State | undefined;
	setState(state: State): State;
}

declare function acquireVsCodeApi<State = unknown>(): VsCodeApi<State>;