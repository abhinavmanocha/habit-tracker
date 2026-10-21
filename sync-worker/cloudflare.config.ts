import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	accountId: "93ce178553aedceb97b02f806f7e5f8e",
	worker: {
		name: "habit-tracker-sync",
		compatibilityDate: "2026-10-19",
		entrypoint,
		env: {
			DB: bindings.d1({
				name: "habit-tracker-sync",
				id: "6e41733f-f658-4004-8077-46d8a996f527",
			}),
			SYNC_KEY: bindings.secret("SYNC_KEY"),
		},
	},
});
